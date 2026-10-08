# instrument

A live-"coding" instrument for learning SuperCollider. Describe a sound in plain language, Claude writes
sclang code, and you run it on a real local SuperCollider server. Edit the code, run it, break it, and ask
Claude to explain what went wrong.

## Features

- **Prompt to code**: Claude writes runnable sclang into an editable editor. Follow-up prompts modify the current code.
- **Run / Stop** (⌘↵ / ⌘.) against a local `sclang` + `scsynth`.
- **Oscilloscope** of the master output, triggered on a rising zero crossing.
- **MIDI tile**: a piano roll of anything sent to `~midi` (visualization only unless you set `MIDI_PORT`).
- **Error tile**: when a run errors, Claude explains why (without rewriting your code); **Fix** asks for a corrected version.
- **Cost and tokens** for each request, with a running session total.
- **♡ Saved**: keep code you like under a short name (browser localStorage).

## Requirements

- macOS with [SuperCollider](https://supercollider.github.io/) installed at `/Applications/SuperCollider.app`
  (set `SCLANG` to use another path)
- Node 22+
- An Anthropic API key from console.anthropic.com

## Run

```
npm install
npm start          # then open http://127.0.0.1:3000
```

Wait about 10 seconds for scsynth to boot. Click ⚙ and paste your API key. It is stored in your browser only
and sent to the local server per request. Alternatively copy `.env.example` to `.env`.

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
so `s.sync` works anywhere. `scope.scd` and `midi.scd` run inside sclang at startup.

The server listens on `127.0.0.1` only. It runs whatever sclang code you send it, so don't expose it to a network.
