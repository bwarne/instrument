// A stand-in MIDI port, ~midi. Everything sent to it is forwarded to the browser's MIDI tile.
// If MIDI_PORT (in .env) matches a MIDI destination's name, it is also sent to that device.
// Without MIDI_PORT it is visualization only, so nothing reaches a synth or DAW by surprise.
//
// Use it like a MIDIOut:
//   Pbind(\type, \midi, \midiout, ~midi, \midinote, Pseq([60, 64, 67]), \dur, 0.25).play;
//   ~midi.noteOn(0, 60, 100);  ~midi.noteOff(0, 60);  ~midi.control(0, 74, 90);
(
var addr = NetAddr("127.0.0.1", 57200);
var want = "MIDI_PORT".getenv;
var dev = nil;
// the built-in \note event type, kept once (Library is global) so loading this file again can't wrap the tap in itself
var playNote = Library.at(\instrument, \note) ?? { Library.put(\instrument, \note, Event.eventTypes[\note]); Event.eventTypes[\note] };

try {
    MIDIClient.init;
    if(want.notNil and: { want.size > 0 }) {
        MIDIClient.destinations.do { |d, i|
            if(dev.isNil and: { (d.device ++ " " ++ d.name).toLower.find(want.toLower).notNil }) {
                dev = MIDIOut(i);
                ("MIDI: sending to" + d.device + "/" + d.name).postln;
            };
        };
        if(dev.isNil) { ("MIDI: no destination matches MIDI_PORT=" ++ want).postln };
    } {
        ("MIDI: visualization only. Set MIDI_PORT to also send to a device. Destinations:"
            + MIDIClient.destinations.collect { |d| d.device ++ " / " ++ d.name }).postln;
    };
} { |err|
    ("MIDI: could not initialise CoreMIDI (" ++ err.errorString ++ "); visualization only.").postln;
};

// know: true lets Event's \midi type call ~midi.noteOn(...) etc. as plain methods
~midi = (know: true, uid: dev !? { dev.uid } ? 0);
[\noteOn, \noteOff, \control, \program, \touch, \bend, \polyTouch, \allNotesOff].do { |cmd|
    ~midi[cmd] = { |self ...args|
        // shown after the server's latency, as a MIDIOut sends (its latency is 0.2 s too), so the
        // tile lines up with the sound of synths the same pattern plays
        SystemClock.sched(s.latency ? 0, { addr.sendMsg('/midi', cmd, *args); nil });
        dev !? { dev.performList(cmd, args) };
        self
    };
};

// Cmd-. cancels the scheduled note-offs, so release anything still sounding
CmdPeriod.add({ 16.do { |c| ~midi.allNotesOff(c) } });

// Every note a pattern plays shows in the MIDI tile too, without ~midi: the \note event type (Pbind's
// default) reports its notes to the tile only (never to a device), when they're heard, which is the
// server's latency after the pattern plays them. The channel comes from the part's name (or the
// SynthDef's, outside a Pdef), so each part gets its own colour. Rests (and muted parts) aren't played, so they aren't shown.
// \midiTap, false in a Pbind hides its notes. (Inside an event, ~names are the event's keys.)
Event.addEventType(\note, { |server|
    var beat, on, off, notes, vel, chan, name, tempo;
    playNote.value(server);
    if(~midiTap != false) {
        beat = thisThread.clock.tryPerform(\beatDur) ? 1;
        on = ((~timingOffset ? 0) * beat) + (~lag.asArray.first ? 0) + (~latency ? server.latency ? 0);
        off = on + (~sustain.value.asArray.maxItem * beat);
        notes = ~midinote.value.asArray.flat.collect { |n| n.round.asInteger.clip(0, 127) };
        vel = (~amp.value.asArray.first * 127).round.asInteger.clip(1, 127);
        name = (~part ? ~instrument).asString; // the Pdef's name (parts.scd sets \part), else the SynthDef's
        chan = name.sum(_.ascii) % 16;
        // the instrument and tempo (beats per second) ride along for the app's MIDI file export
        tempo = (thisThread.clock.tryPerform(\tempo) ? 1).asFloat;
        SystemClock.sched(on, { notes.do { |n| addr.sendMsg('/midi', \noteOn, chan, n, vel, name, tempo) }; nil });
        SystemClock.sched(off, { notes.do { |n| addr.sendMsg('/midi', \noteOff, chan, n) }; nil });
    };
});
)
