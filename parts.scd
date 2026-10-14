// Parts: the Pdefs and Ndefs your code defines, for the app's parts strip and live coding. Loaded once
// at startup by server.js. Safe to ignore while learning.
//   /parts  kind, name, playing (0/1), muted (0/1) for each part, sent whenever that changes
//   ~partsSync.(keep)    runs after your code on every Run: stops parts the code no longer mentions
//                        (deleted or commented out), and re-stops parts muted in the app, since your
//                        code's .play just started them again
//   ~partsSet.(key, on)  the app's toggle: on = play, off = stop and stay muted across runs
// A key is a Symbol like 'pdef:drums' or 'ndef:pad'.
var addr = NetAddr("127.0.0.1", 57200);
var last;

~partsMuted = IdentitySet[];

~partsAll = {
    var list = List[];
    Pdef.all.keysValuesDo { |name, p| list.add([\pdef, name, p.isPlaying]) };
    Ndef.dictFor(s).envir.keysValuesDo { |name, n| list.add([\ndef, name, n.isMonitoring]) };
    list.sort { |a, b| a[1].asString < b[1].asString }
};
~partsKey = { |kind, name| (kind.asString ++ ":" ++ name.asString).asSymbol };

~partsApply = { |key, on|
    var kind, name;
    #kind, name = key.asString.split($:);
    name = name.asSymbol;
    if(kind == "pdef") {
        if(on) { Pdef(name).play } { Pdef(name).stop }
    } {
        if(on) { Ndef(name).play } { Ndef(name).stop }
    };
};

~partsReport = { |force = false|
    var msg = ~partsAll.value.collect { |p|
        [p[0], p[1], p[2].binaryValue, ~partsMuted.includes(~partsKey.(p[0], p[1])).binaryValue]
    }.flatten;
    if(force or: { msg != last }) { last = msg; addr.sendMsg('/parts', *msg) };
};

~partsSync = { |keep|
    ~partsAll.value.do { |p|
        if(keep.includes(~partsKey.(p[0], p[1])).not and: { p[2] }) { ~partsApply.(~partsKey.(p[0], p[1]), false) };
    };
    ~partsMuted = ~partsMuted.select { |k| keep.includes(k) }; // forget mutes for parts that are gone
    ~partsMuted.do { |k| ~partsApply.(k, false) };
    ~partsReport.(true);
};

~partsSet = { |key, on|
    if(on) { ~partsMuted.remove(key) } { ~partsMuted.add(key) };
    ~partsApply.(key, on);
    ~partsReport.(true);
};

// SkipJack keeps running through Cmd-. (Stop), which is exactly when every part changes state
SkipJack({ ~partsReport.value }, 0.25, name: "instrumentParts");
