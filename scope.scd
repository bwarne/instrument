// Streams snapshots of the master output (bus 0, L+R mixed to mono) to the Node server
// over OSC, which relays them to the browser oscilloscope.
// Loaded once at startup by server.js. Safe to ignore while learning, or read as an example.
s.waitForBoot {
    var addr = NetAddr("127.0.0.1", 57200);
    var frames = 2048;                       // ~43 ms at 48 kHz
    var buf = Buffer.alloc(s, frames);

    SynthDef(\instrumentScope, { |buf, t_trig = 0|
        var sig = In.ar(0, 2).sum * 0.5;
        // one-shot capture; each t_trig restarts the recording from frame 0
        RecordBuf.ar(sig, buf, loop: 0, trigger: t_trig);
    }).add;
    s.sync;

    ~scopeStart = {
        var syn;
        ~scopeRoutine.stop;
        syn = Synth.tail(s.defaultGroup, \instrumentScope, [\buf, buf]);
        ~scopeRoutine = Routine({
            loop {
                syn.set(\t_trig, 1);
                0.05.wait;                   // let the capture finish
                // send every 2nd sample: plenty for a display, keeps the OSC packet small
                buf.getn(0, frames, { |d| addr.sendMsg('/scope', *d[0, 2..]) });
                0.01.wait;
            }
        }).play(SystemClock);
    };
    ~scopeStart.value;

    // Cmd-. frees every synth and clears the clocks, so bring the scope back afterwards
    CmdPeriod.add({ SystemClock.sched(0.3, { ~scopeStart.value; nil }) });
};
