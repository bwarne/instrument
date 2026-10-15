// Recording for the app's Record button, loaded once at startup by server.js. Safe to ignore while learning.
// It writes the master output (bus 0, stereo) to a 24-bit WAV file, like s.record, but keeps recording
// through Stop (Cmd-.), so one take can span several runs; only the Record button ends it.
//   /record "started" path    the file is open and recording
//   /record "finished" path   the file is closed and complete
//   /record "failed" reason
//   ~recStart.(path)     ~recStop.(done)   done runs once the file is closed (or at once if not recording)
// It's 24-bit at the server's sample rate; the app makes an MP3 from it on request.
//
// Fade out: ~fadeOut.(seconds) fades the whole output to silence, then finishes the recording (if one is
// running) and stops everything, as Stop does. ~fadeCancel.() brings the sound straight back.
//   /fade "started" seconds   /fade "done"   /fade "cancelled"
var addr = NetAddr("127.0.0.1", 57200);
var buf, node, path;
var fadeNode, fadeId = 0;

~recPlay = {
    // at the very end of the node tree, after everything that plays, so it hears the finished mix
    node = Synth.tail(RootNode(s), \instrumentRecord, [\buf, buf]);
    node.register(true);
};

~recStart = { |p|
    case
    { buf.notNil } { addr.sendMsg('/record', "started", path) }
    { s.serverRunning.not } { addr.sendMsg('/record', "failed", "audio isn't running") }
    {
        var b = Buffer.alloc(s, 65536, 2);
        buf = b;
        path = p;
        fork {
            SynthDef(\instrumentRecord, { |buf| DiskOut.ar(buf, In.ar(0, 2)) }).add;
            s.sync;
            b.write(p, "wav", "int24", 0, 0, true);
            s.sync;
            // unless the Record button was pressed again meanwhile
            if(buf === b) { ~recPlay.value; addr.sendMsg('/record', "started", p) };
        };
    };
};

~recStop = { |done|
    var b = buf, p = path, n = node, over = false, finish;
    buf = nil; node = nil;
    // once: when scsynth confirms the file is closed, or after 3 s if it doesn't answer (so a hung
    // server can't hold up Restart audio)
    finish = { |ok|
        if(over.not) {
            over = true;
            if(ok) { addr.sendMsg('/record', "finished", p) } { addr.sendMsg('/record', "failed", "the audio server didn't finish the file") };
            done.value;
        };
    };
    if(b.isNil) { done.value } {
        if(n.notNil and: { n.isPlaying }) { n.free };
        b.close;
        fork { s.sync; b.free; finish.(true) };
        SystemClock.sched(3, { finish.(false); nil });
    };
};

// Cmd-. frees every synth, the recorder's too, so start it again on the same open file
CmdPeriod.add({
    if(~audioRestarting != true and: { buf.notNil }) {
        SystemClock.sched(0.2, { if(buf.notNil and: { s.serverRunning }) { ~recPlay.value }; nil });
    };
});

// The fade sits just after the default group (where the music plays), so the scope, meters and recorder
// all come after it. It falls evenly in dB to -60 and then to silence, which sounds even to the ear.
~fadeOut = { |secs|
    var id;
    if(s.serverRunning.not) { addr.sendMsg('/fade', "cancelled") } {
        ~fadeCancel.value(false);
        id = fadeId = fadeId + 1;
        // on SystemClock, so the wait is in seconds whatever tempo the music set
        Routine {
            SynthDef(\instrumentFade, { |dur = 8|
                var g = Line.kr(0, -60, dur).dbamp * (Line.kr(0, 1, dur) < 1);
                ReplaceOut.ar(0, In.ar(0, 2) * g);
            }).add;
            s.sync;
            if(fadeId == id) {
                fadeNode = Synth.after(s.defaultGroup, \instrumentFade, [\dur, secs]);
                fadeNode.register(true);
                addr.sendMsg('/fade', "started", secs.asFloat);
                (secs + 0.2).wait;
                if(fadeId == id) {
                    fadeId = fadeId + 1;
                    fadeNode = nil; // so the CmdPeriod below isn't taken for Stop during a fade
                    ~recStop.value({
                        CmdPeriod.run; // stops everything and frees the fade synth
                        addr.sendMsg('/fade', "done");
                    });
                };
            };
        }.play(SystemClock);
    };
};

~fadeCancel = { |tell = true|
    var n = fadeNode;
    fadeId = fadeId + 1; // a fade in progress won't finish
    fadeNode = nil;
    if(n.notNil and: { n.isPlaying }) { n.free };
    if(tell) { addr.sendMsg('/fade', "cancelled") };
};

// Stop during a fade: the sound is already stopped, so the fade just ends (the recording carries on)
CmdPeriod.add({ if(fadeNode.notNil) { fadeNode = nil; fadeId = fadeId + 1; addr.sendMsg('/fade', "cancelled") } });
