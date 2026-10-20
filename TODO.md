# TODO

## Host on Railway with remote audio (tabled 2026-10-08)

Goal: use the instrument from a browser anywhere, with sound. Not started; findings below came from
experiments on a Mac, so nothing here is built yet.

### Why it isn't a simple deploy
1. **No audio device on the server.** scsynth plays to the machine's speakers; Railway has none, so the
   browser would get the scope and MIDI tiles but no sound.
2. **The server runs whatever sclang code it is sent**, including shell commands. On a public URL that is
   remote code execution. Locally it is safe only because it listens on `127.0.0.1`.

### Plan (in order)
1. **Audio streaming.** A `DiskOut` synth writes `In.ar(0, 2)` into a named pipe; Node reads it and sends the
   chunks over the existing WebSocket; an `AudioWorklet` in the page plays them with a small jitter buffer.
   - Add a 🔊 Listen button (browsers need a click before playing audio).
   - Only capture while someone is listening, so local use doesn't double up with the speakers.
   - Expect roughly 150-400 ms latency.
2. **Hosted mode.**
   - Node starts scsynth itself (not sclang) and sclang connects to it as a remote server
     (`Server.remote`, `startAliveThread`). This is what lets us block `unixCmd` outright, because `s.boot`
     itself uses `unixCmd`.
   - Run sclang as an unprivileged user with a scrubbed environment (no secrets) and a read-only filesystem.
   - Shared-password login (`APP_PASSWORD`) covering HTTP and the WebSocket. Bind `0.0.0.0` only in hosted mode.
3. **Docker + Railway.** Image with SuperCollider and JACK (`jackd -d dummy` as a virtual sound card), a
   start script for jackd, scsynth and node, then create the Railway project/service and set variables.
   The Anthropic key stays in the browser, so it never lives on the server.

### Findings from the experiments
- **Audio capture works.** `Buffer.write(fifo, "raw", "int16", 0, 0, true)` + `DiskOut.ar` into a FIFO gave
  190 KB/s, matching real-time 48 kHz stereo int16 (188 KB/s), in about 43 ms chunks, with the right level.
- **sclang has no restricted mode.** Unrestricted, all 9 test attacks ran (`unixCmd`, `prUnixCmd`,
  `unixCmdGetStdOut`, `Pipe`, `File` write, method name built from strings, `interpret`, raw primitives).
- **A class extension can override the dangerous methods** (a `+ String { … }` file in an `includePaths`
  directory, loaded with `sclang -l conf.yaml`), but it is a denylist and cannot be proven complete: shell
  entry points exist on `String`, `Array`, `Pipe`, `File` and `Platform`, and primitives can be called from
  interpreted code. Blocking `File` entirely breaks sclang's own startup (it reads `archive.sctxar`), so the
  override must be selective. Treat it as a second layer; the container is the real boundary.
- Railway is a CPU-limited, always-on container: expect some audio glitching on heavy patches, and a small
  running cost. The Docker build is untested.

## Bundle SuperCollider in the app (tabled 2026-10-19)

Goal: nobody has to install SuperCollider separately. Not started; the numbers are from SuperCollider
3.14.1 on this Mac (universal binaries, signed by the SuperCollider team).

- **The catch:** the stock `sclang` (9.9 MB) is linked against Qt, including `QtWebEngineCore` (425 MB), and
  won't start without those frameworks. The app is 556 MB, 504 MB of it `Frameworks/`. `scsynth` is small
  (1.5 MB, plus `libsndfile` 4.9 MB and 10 MB of plugins), and `SCClassLibrary` is 2.6 MB.
- **Options:** (1) build a headless `sclang` from source (`-DSC_QT=OFF -DSC_IDE=OFF`; loses only the GUI
  classes, which the app doesn't use) and bundle it with `scsynth`, plugins and class library, about
  35-40 MB (download 98 MB -> about 135 MB); (2) bundle the whole SuperCollider.app thinned to arm64, about
  +250-280 MB; (3) a "Download SuperCollider for me" button that installs the official DMG on first run.
- **Option 1 plan:** copy SuperCollider's bundle layout (`MacOS/sclang`, `Resources/scsynth`, `plugins`,
  `SCClassLibrary`, `Frameworks`) into the app's resources, so it finds everything relative to `sclang`;
  `findSclang()` in `server.js` tries the bundled copy first and falls back to an installed one. Prototype
  first: a headless arm64 `sclang` running one of the `.scd` pieces, on a separate OSC port (see CLAUDE.md).
- **Watch for:** every binary and plugin must be re-signed with our Developer ID, hardened runtime and
  timestamp, or notarization fails (the fiddly part); a hardened-runtime app without the audio-input
  entitlement gets silence from audio input with no prompt (set input channels to 0, or add the entitlement
  and `NSMicrophoneUsageDescription`); SuperCollider is GPL v3, so ship the license text and a source link or
  offer (the app is ISC; separate processes are the usual arrangement, but check before selling it).

## Sliders in the parts strip (tabled 2026-10-19)

Goal: drag sliders for a part's controls, next to mute/unmute. Not started.

- **Not SuperCollider's own `Window`/`Slider`:** those are Qt windows owned by `sclang`, separate from the
  page, and don't exist in a headless `sclang`. Draw HTML sliders in the page instead.
- **Design:** `parts.scd` also reports each Ndef's controls (name, current value, range); the page draws a
  slider per control; a drag posts the part key, control name and number to the server, which validates them
  (like `PART_KEY`) and runs `Ndef(\x).set(\name, v)`. The page never sends free-form code. Throttle to about
  30 updates a second, and use a lag in the sound (`\cutoff.kr(1000, 0.05)`) to avoid zipper noise.
- **Ranges:** SuperCollider's own way is `Ndef(\x).addSpec(\cutoff, [200, 8000, \exp])`; add a line to the
  system prompt so Claude writes a spec for each musical control. Without one, fall back to 0-1.
- **Open questions:** Pdefs need the pattern to read a value the slider changes, so start with Ndefs. A
  re-run (or live mode) resets controls to the code's defaults: either the slider jumps back, or the app
  re-applies slider values after each Run (keeps tweaks, but edited defaults then do nothing until reset).
  Saved sessions could store slider positions along with the code.

## An iOS version (idea, 2026-10-19)

Goal: use the instrument on an iPhone or iPad. Not started and not researched in depth; what follows is
from general knowledge of iOS and SuperCollider, not verified against current docs.

- **Why it isn't a port:** the app is Node plus Electron, and `server.js` spawns `sclang` and `scsynth` as
  separate processes. iOS allows no subprocesses, no Node and no shell, so the engine would have to be
  linked into the app as libraries. `scsynth` has been embedded in iOS apps as `libscsynth`; running
  `sclang` (which executes Claude's code) on iOS is the unknown, and I know of no supported way.
- **App Store:** guideline 2.5.2 restricts executing downloaded or generated code. Programming apps
  (Pythonista, Scriptable) exist, but code generated by an API and run on the device is a gray area; expect
  review questions.
- **Routes:** (1) iPhone/iPad as a remote control for the Mac app or a hosted engine: the page is already
  HTML, sound plays on the Mac. The server must stop being loopback-only, and `/run` can execute shell
  commands, so this needs real authentication first: the same work as the Railway entry above. (2) A native
  app with an embedded `libscsynth` plus an embeddable `sclang`: a research spike first (can `sclang` run
  inside an iOS app at all?), then weeks of work. (3) A different engine (Web Audio, AudioKit, Faust) with
  Claude generating that language: runs on iOS but is a different product and drops the SuperCollider prompt.
- **Suggested order:** route 1 after the hosting/auth work; route 2 only if the `sclang` spike succeeds.

## Smaller ideas
- Syntax highlighting for sclang in the editor.
- Code history / undo for Generate and Fix, which currently overwrite the editor.
- Stream Claude's output into the editor as it is generated.
