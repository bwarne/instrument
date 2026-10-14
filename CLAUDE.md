# AnInstrument

A live-"coding" SuperCollider instrument: prompts go to the Claude API, the returned sclang runs on a
local scsynth. See README.md for features, architecture and the security model.

## Conventions

- **Every Claude API call shows its cost where it was made.** Each feature that calls Claude (generate,
  fix, error analysis, gear, and anything new) shows a small line under the part of the UI that made
  the call, with the call's tokens sent and received and its cost, using `usageText()` in index.html.
  It also goes into the session total via `showUsage()`. The server returns `usage` from
  `summarizeUsage()` for this, so new endpoints should return it too.
- Links shown to the user are built from data (e.g. store searches), never URLs written by the model.
- Test page changes in a hidden Electron window with `fetch` stubbed; test Claude calls through the
  exported functions in server.js (`generate`, `gear`) with `node --env-file=.env`, since the running
  app holds the audio ports.
