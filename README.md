# AnInstrument

A live-"coding" instrument for learning SuperCollider. Describe a sound in plain language, Claude writes
sclang code, and you run it on a real local SuperCollider server. Edit the code, run it, break it, and ask
Claude to explain what went wrong.

**Download** (Apple silicon Mac, always the latest release):
https://github.com/jonowar/instrument/releases/latest/download/AnInstrument-arm64.dmg

## Features

- **Prompt to code, as a conversation**: Claude writes runnable sclang into an editable editor, and each
  follow-up refines it. Claude sees the whole conversation (the last 20 turns, cached so follow-ups stay cheap)
  while the editor shows only the latest code. Your own edits between turns are sent along as the current
  version. **💬** shows the full history and can rewind to any earlier turn (Claude's context rewinds with it); **New** starts over.
  Chords are annotated with their name, notes and role in the key.
- **Run / Stop** (⌘↵ / ⌘.) against a local `sclang` + `scsynth`.
- **Live coding**: **● Live** re-runs the code a moment after you stop typing (once brackets balance). Each `Pdef`/`Ndef`
  appears in the **parts strip** as a toggle (lit while playing; click to mute or unmute, and mutes survive re-runs). A muted part keeps running
  silently, so it comes back in on the beat.
  Deleting or commenting out a part stops it on the next run; **⌘;** comments or uncomments the selected lines.
- **Oscilloscope** of the master output, triggered on a rising zero crossing, with **L/R level meters**
  (RMS, peak and held peak in dBFS) and a clip light that stays on for 3 s after any sample reaches full scale.
- **Output device** dropdown under the scope header (remembered between launches). **Audio health**: warns when the device's real sample rate drifts from scsynth's
  (e.g. Bluetooth headphones dropping into call mode), and **⟳ Restart audio** reboots scsynth on the current device.
- **MIDI tile**: a piano roll of anything sent to `~midi` (visualization only unless you set `MIDI_PORT`).
- **Error tile**: when a run errors, Claude explains why (without rewriting your code); **Fix** asks for a corrected version.
- **🎛 Gear**: which real instruments (synths, drum machines, pedals) could play the current sound, which part each
  covers, how to dial it in, estimated new/used prices, suggested rigs, and Sweetwater/Reverb search links.
- **Cost and tokens** for each request, with a running session total. **🧾 Usage** keeps the history of every
  request across sessions (tokens sent, cached and received, cost, time) with totals for today, this month and
  all time. It's stored in `usage.jsonl` in the app's data folder.
- **Speed settings** in ⚙: effort (low by default, for quick replies) and model (Haiku 5.5 for speed, Opus 5.5 for depth).
- **♡ Saved**: save the whole session (code and conversation) under a short name; loading it carries on with
  Claude seeing everything up to the save. Stored in localStorage. Each launch starts a new conversation.

## Requirements

- macOS with [SuperCollider](https://supercollider.github.io/) installed in `/Applications` or `~/Applications`
  (set `SCLANG` to use another path). Without it, the app shows setup steps and a **Check again** button, and starts
  SuperCollider as soon as it's found.
- Node 22+
- An Anthropic API key from console.anthropic.com

## Run

As a desktop app (Electron):

```
npm install
npm run app        # opens the app window
npm run dist       # optional: builds dist/mac-arm64/AnInstrument.app, drag it to /Applications
npm run release    # signed + notarized dist/AnInstrument-arm64.dmg and .zip for other Macs
npm run publish -- "notes"   # GitHub release with the dmg, plus the zip + latest-mac.yml for updates
```

Installed copies check GitHub Releases at launch (and **AnInstrument → Check for Updates…**), download a newer
version in the background and offer to restart into it. `publish` needs everything committed and pushed, and
retries uploads that time out; the release stays a draft until every file is there.

`dist` and `release` sign with the Developer ID certificate in your keychain, if there is one. `release` also
notarizes, using a notarytool keychain profile named `instrument-notary` (or set `APPLE_KEYCHAIN_PROFILE`).
Create the profile once with:

```
xcrun notarytool store-credentials instrument-notary --apple-id you@example.com --team-id YOURTEAMID
```

It asks for an app-specific password, which you can generate at account.apple.com → Sign-In and Security.

Or in a browser:

```
npm start          # then open http://127.0.0.1:3000
```

Wait about 10 seconds for scsynth to boot. Click ⚙ and paste your API key. It is stored on this machine only
(in the app's or browser's local storage) and sent to the local server per request. Alternatively copy
`.env.example` to `.env`; the packaged app also reads `~/Library/Application Support/Instrument/.env`.

Run one at a time: the app and `npm start` both start scsynth and use the same UDP port. Closing the app's
window quits it and shuts down sclang and scsynth.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Fallback key if none is set in the ⚙ dialog |
| `MODEL` | Claude model (default `claude-sonnet-5-5`) |
| `PRICE_IN`, `PRICE_OUT` | $ per million tokens, for models not in the built-in price table |
| `MIDI_PORT` | Part of a MIDI destination's name; also send `~midi` to that device |
| `SCLANG`, `PORT` | Path to `sclang`, HTTP port (default 3000) |

## How it works

```
browser ──HTTP──▶ server.js ──stdin──▶ sclang ──▶ scsynth ──▶ speakers
   ▲                 │  ▲                 │
   └───WebSocket─────┘  └──UDP/OSC────────┘   (scope.scd, midi.scd stream audio snapshots and MIDI)
```

`server.js` spawns `sclang`, calls the Claude API, and writes each run to a temp file wrapped in `fork { … }`
so `s.sync` works anywhere. `scope.scd` and `midi.scd` run inside sclang at startup. The desktop app
(`electron/main.js`) starts the same server on port 47800 and shows the page in its own window.

The server runs whatever sclang code it is sent, and sclang can run shell commands, so it only accepts its
own page: it listens on `127.0.0.1`, rejects requests whose `Host` or `Origin` isn't its own (so another
website open in your browser can't call it, including via DNS rebinding), and only accepts JSON POSTs.
Don't expose it to a network.

scsynth boots with audio input disabled, since nothing records; this also avoids a boot failure with
Bluetooth headphones whose mic and output run at different sample rates.
