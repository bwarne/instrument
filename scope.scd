// Audio setup for the instrument, loaded once at startup by server.js. Safe to ignore while learning,
// or read as an example. It boots scsynth, then streams to the Node server over OSC:
//   /scope   snapshots of the master output (bus 0, L+R mixed to mono) for the oscilloscope
//   /levels  peak and RMS of each channel, 20 times a second, for the level meters and clip light
//   /audio   server status every 2 s (running, nominal and actual sample rate) for the warning bar
var addr = NetAddr("127.0.0.1", 57200);
var frames = 2048;                           // scope snapshot length, ~43 ms at 48 kHz
var buf;

// No audio input: nothing here records, and a mismatched input device (e.g. Bluetooth headphones whose
// mic runs at 24 kHz while their output runs at 48 kHz) otherwise stops scsynth from booting.
s.options.numInputBusChannels = 0;
// Output device: the system default unless INSTRUMENT_OUT_DEVICE names one (e.g. "Scarlett Solo 4th Gen")
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
    syn = Synth.tail(s.defaultGroup, \instrumentScope, [\buf, buf]);
    ~scopeRoutine = Routine({
        loop {
            syn.set(\t_trig, 1);
            0.05.wait;                       // let the capture finish
            // send every 2nd sample: plenty for a display, keeps the OSC packet small
            buf.getn(0, frames, { |d| addr.sendMsg('/scope', *d[0, 2..]) });
            0.01.wait;
        }
    }).play(SystemClock);
};

// Restart audio: stop everything, quit scsynth and boot it again. scsynth picks its output device and
// sample rate only when it boots, so this is how it follows a device change (headphones connected,
// Bluetooth switching to call mode). Your code has to be run again afterwards.
~audioRestart = {
    ~audioRestarting = true;
    CmdPeriod.run;
    ~scopeRoutine.stop;
    s.quit(onComplete: { ~audioRestarting = false; ~audioStart.value });
};

// /instrumentLevels arrives as [address, nodeID, replyID, peakL, rmsL, peakR, rmsR]
OSCFunc({ |msg| addr.sendMsg('/levels', *msg[3..6]) }, '/instrumentLevels').fix;

// SkipJack keeps running through Cmd-., unlike a plain Routine
SkipJack({
    addr.sendMsg('/audio', s.serverRunning.binaryValue, (s.sampleRate ? 0).asFloat, (s.actualSampleRate ? 0).asFloat);
}, 2, name: "instrumentAudioMonitor");

// Cmd-. frees every synth and clears the clocks, so bring the scope back afterwards
CmdPeriod.add({
    if(~audioRestarting != true and: { s.serverRunning }) { SystemClock.sched(0.3, { ~scopeStart.value; nil }) };
});

~audioStart.value;
