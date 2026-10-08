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
        addr.sendMsg('/midi', cmd, *args);
        dev !? { dev.performList(cmd, args) };
        self
    };
};

// Cmd-. cancels the scheduled note-offs, so release anything still sounding
CmdPeriod.add({ 16.do { |c| ~midi.allNotesOff(c) } });
)
