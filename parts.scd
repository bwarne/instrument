// Parts: the Pdefs and Ndefs your code defines, for the app's parts strip and live coding. Loaded once
// at startup by server.js. Safe to ignore while learning.
//   /parts  kind, name, playing (0/1), muted (0/1) for each part, sent whenever that changes
//   ~partsSync.(keep)    runs after your code on every Run: stops parts the code no longer mentions
//                        (deleted or commented out), and re-mutes parts muted in the app, in case
//                        your code's .play started them afresh
//   ~partsSet.(key, on)  the app's toggle: off = mute, on = unmute (or play, if it isn't playing)
//   ~partsSetAll.(on)    Mute all (false) / Unmute all (true)
// Muting keeps a part running silently, so it comes back in time when unmuted: a Pdef's player turns
// its events into rests (EventStreamPlayer's muteCount), and an Ndef's monitor volume goes to 0.
// A key is a Symbol like 'pdef:drums' or 'ndef:pad'.
var addr = NetAddr("127.0.0.1", 57200);
var last;

~partsMuted = IdentitySet[];
~partsVol = IdentityDictionary[]; // an Ndef's monitor volume from before it was muted

~partsAll = {
    var list = List[];
    Pdef.all.keysValuesDo { |name, p| list.add([\pdef, name, p.isPlaying]) };
    Ndef.dictFor(s).envir.keysValuesDo { |name, n| list.add([\ndef, name, n.isMonitoring]) };
    list.sort { |a, b| a[1].asString < b[1].asString }
};
~partsKey = { |kind, name| (kind.asString ++ ":" ++ name.asString).asSymbol };

~partsSplit = { |key| var kind, name; #kind, name = key.asString.split($:); [kind, name.asSymbol] };

~partsApply = { |key, on|
    var kind, name;
    #kind, name = ~partsSplit.(key);
    if(kind == "pdef") {
        if(on) { Pdef(name).play } { Pdef(name).stop }
    } {
        if(on) { Ndef(name).play } { Ndef(name).stop }
    };
};

// Silence or restore a part without stopping it. Safe to repeat: it sets the mute, it doesn't count.
~partsMute = { |key, mute|
    var kind, name, n;
    #kind, name = ~partsSplit.(key);
    if(kind == "pdef") {
        Pdef(name).player !? { |pl| pl.muteCount = mute.binaryValue };
    } {
        n = Ndef(name);
        if(mute) {
            if(n.vol > 0) { ~partsVol[name] = n.vol };
            n.vol = 0;
        } {
            n.vol = ~partsVol.removeAt(name) ? 1;
        };
    };
};

~partsReport = { |force = false|
    var msg = ~partsAll.value.collect { |p|
        [p[0], p[1], p[2].binaryValue, ~partsMuted.includes(~partsKey.(p[0], p[1])).binaryValue]
    }.flatten;
    if(force or: { msg != last }) { last = msg; addr.sendMsg('/parts', *msg) };
};

~partsSync = { |keep|
    // parts that are gone are unmuted as they stop, so they start out audible if they come back
    ~partsMuted.reject { |k| keep.includes(k) }.do { |k| ~partsMute.(k, false); ~partsMuted.remove(k) };
    ~partsAll.value.do { |p|
        if(keep.includes(~partsKey.(p[0], p[1])).not and: { p[2] }) { ~partsApply.(~partsKey.(p[0], p[1]), false) };
    };
    ~partsMuted.do { |k| ~partsMute.(k, true) };
    // tag each Pdef's events with its name, so the MIDI tile and a take's MIDI file can tell parts apart
    // (midi.scd reads \part); the Pdef's own keys still win, as \part is only a default
    Pdef.all.keysValuesDo { |name, p| if(p.get(\part) != name) { p.set(\part, name) } };
    ~partsReport.(true);
};

~partsSet = { |key, on|
    var playing = ~partsAll.value.detect { |p| ~partsKey.(p[0], p[1]) == key } !? { |p| p[2] } ? false;
    if(on) {
        ~partsMuted.remove(key);
        ~partsMute.(key, false);
        if(playing.not) { ~partsApply.(key, true) };
    } {
        ~partsMuted.add(key);
        ~partsMute.(key, true);
    };
    ~partsReport.(true);
};

// The strip's Mute all / Unmute all: mutes every playing part, or unmutes every muted one (stopped parts
// stay stopped either way)
~partsSetAll = { |on|
    ~partsAll.value.do { |p|
        var k = ~partsKey.(p[0], p[1]);
        if(on) {
            if(~partsMuted.includes(k)) { ~partsMuted.remove(k); ~partsMute.(k, false) };
        } {
            if(p[2]) { ~partsMuted.add(k); ~partsMute.(k, true) };
        };
    };
    ~partsReport.(true);
};

// SkipJack keeps running through Cmd-. (Stop), which is exactly when every part changes state
SkipJack({ ~partsReport.value }, 0.25, name: "instrumentParts");
