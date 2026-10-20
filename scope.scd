// Audio setup for the instrument, loaded once at startup by server.js. Safe to ignore while learning,
// or read as an example. It boots scsynth, then streams to the Node server over OSC:
//   /scope   snapshots of the master output (bus 0, L+R mixed to mono) for the oscilloscope
//   /levels  peak and RMS of each channel, 20 times a second, for the level meters and clip light
//   /audio   server status every 2 s (running, nominal and actual sample rate) for the warning bar
//   /devices the available output devices, whenever the list changes, for the output dropdown
var addr = NetAddr("127.0.0.1", 57200);
var frames = 2048;                           // scope snapshot length, ~43 ms at 48 kHz
var buf;

// No audio input: nothing here records, and a mismatched input device (e.g. Bluetooth headphones whose
// mic runs at 24 kHz while their output runs at 48 kHz) otherwise stops scsynth from booting.
s.options.numInputBusChannels = 0;
// Output device chosen in the app's dropdown (server.js passes it in); nil means the system default.
// A device that isn't connected falls back to the system default.
s.options.outDevice = "INSTRUMENT_OUT_DEVICE".getenv;

~audioStart = {
    s.waitForBoot {
        buf = Buffer.alloc(s, frames);
        SynthDef(\instrumentScope, { |buf, t_trig = 0|
            var out = In.ar(0, 2);
            // one-shot capture; each t_trig restarts the recording from frame 0
            RecordBuf.ar(out.sum * 0.5, buf, loop: 0, trigger: t_trig);
            // measured on every sample, so a clip between scope snapshots still shows up
            SendPeakRMS.kr(out, 20, 1.5, '/instrumentLevels');  // peaks fall back over 1.5 s
        }).add;
        s.sync;
        ~scopeStart.value;
    };
};

~scopeStart = {
    var syn;
    ~scopeRoutine.stop;
    // just after the default group, where all the music plays; record.scd's fade-out goes between
    // the two, so the scope and meters show the fade too
    syn = Synth.after(s.defaultGroup, \instrumentScope, [\buf, buf]);
    ~scopeRoutine = Routine({
        var pending = false, sentAt = 0;
        loop {
            // One request in flight at a time. If scsynth stalls (sleep, device hiccup, heavy load) and
            // we kept asking, the unanswered /b_getn calls would fill its command FIFO and real-time
            // memory ("FAILURE IN SERVER /b_getn out of real time memory") after a long session.
            // A request unanswered for 2 s is given up on.
            if(s.serverRunning and: { pending.not or: { (thisThread.seconds - sentAt) > 2 } }) {
                pending = true;
                sentAt = thisThread.seconds;
                syn.set(\t_trig, 1);
                0.05.wait;                   // let the capture finish
                // send every 2nd sample: plenty for a display, keeps the OSC packet small
                buf.getn(0, frames, { |d| pending = false; addr.sendMsg('/scope', *d[0, 2..]) });
                0.01.wait;
            } {
                0.1.wait;
            };
        }
    }).play(SystemClock);
};

// Restart audio: stop everything, quit scsynth and boot it again. scsynth picks its output device and
// sample rate only when it boots, so this is how it follows a device change (headphones connected,
// Bluetooth switching to call mode). Your code has to be run again afterwards. A recording in progress
// (record.scd) is finished first, so its file is complete.
~audioRestart = {
    ~audioRestarting = true;
    CmdPeriod.run;
    ~scopeRoutine.stop;
    ~recStop.value({ s.quit(onComplete: { ~audioRestarting = false; ~audioStart.value }) });
};

// Switch output device: scsynth can only change device by rebooting
~audioSetDevice = { |name| s.options.outDevice = name; ~audioRestart.value };

// /instrumentLevels arrives as [address, nodeID, replyID, peakL, rmsL, peakR, rmsR]
OSCFunc({ |msg| addr.sendMsg('/levels', *msg[3..6]) }, '/instrumentLevels').fix;

// SkipJack keeps running through Cmd-., unlike a plain Routine
SkipJack({
    var devices = ServerOptions.outDevices;
    addr.sendMsg('/audio', s.serverRunning.binaryValue, (s.sampleRate ? 0).asFloat, (s.actualSampleRate ? 0).asFloat);
    // only when it changes: headphones connected or disconnected
    if(devices != ~lastDevices) { ~lastDevices = devices; addr.sendMsg('/devices', *devices) };
}, 2, name: "instrumentAudioMonitor");

// Cmd-. frees every synth and clears the clocks, so bring the scope back afterwards
CmdPeriod.add({
    if(~audioRestarting != true and: { s.serverRunning }) { SystemClock.sched(0.3, { ~scopeStart.value; nil }) };
});

~audioStart.value;
