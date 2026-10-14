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

## Smaller ideas
- Syntax highlighting for sclang in the editor.
- Code history / undo for Generate and Fix, which currently overwrite the editor.
- Stream Claude's output into the editor as it is generated.
