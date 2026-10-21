# AnInstrument

A live-"coding" SuperCollider instrument: prompts go to the Claude API, the returned sclang runs on a
local scsynth. See README.md for features, architecture and the security model.

## Conventions

- **Every Claude API call shows its cost where it was made.** Each feature that calls Claude (generate,
  fix, error analysis, gear, and anything new) shows a small line under the part of the UI that made
  the call, with the call's tokens sent and received and its cost, using `usageText()` in index.html.
  It also goes into the session total via `showUsage()`. The server returns `usage` from
  `summarizeUsage()` for this, so new endpoints should return it too.
- **Every Claude call is also recorded in the usage history** (usage.jsonl in the data folder, shown by
  🧾 Usage). `ask()` does this itself, so route new calls through `ask()` and give them a `kind`.
- **Providers.** `ask()` routes by provider: Claude through Anthropic's SDK, everything else (OpenAI, Meta's
  Llama API, Ollama, any OpenAI-compatible URL) through `askOpenAI()`, which returns the same `{ text,
  truncated, usage }`. New features keep calling `ask()` and must not assume Anthropic-only features (cache
  control, `output_config`); the adapter flattens those. Prices for non-Claude models come from the user
  (⚙), and are shown as unknown rather than guessed. Test it with a stand-in server, as no keys are needed.
- Links shown to the user are built from data (e.g. store searches), never URLs written by the model.
- **Anything new that sends the user's code or recordings off this machine is opt-in and says so where
  the user presses it.** Today that is ⤴ Share: the dialog explains that the link is public before the
  first upload, and the API key is never sent. Share links come from what the service returns, not
  assembled in the page. Model requests (to Anthropic, or the OpenAI-compatible provider the user picked in ⚙; cost shown beside each) and the update check against GitHub
  Releases (`electron/main.js`) are the other network use.
- The share service (`share/`) is a separate package with its own tests: `npm run dev` then
  `npm test` in that directory runs the Worker against local R2, so it needs no Cloudflare account.
  Its caps and abuse controls are listed in `share/README.md`; change them there, not in the app.
- Test page changes in a hidden Electron window with `fetch` stubbed (`npm run test:ui`, in `test/ui/`);
  test Claude calls through the
  exported functions in server.js (`generate`, `gear`) with `node --env-file=.env`, since the running
  app holds the audio ports.
- Any change to what gets sent to sclang (the run-file wrapper, .scd files) must be checked in sclang
  itself: a separate `sclang test.scd` with `thisProcess.interpreter.compile(...)` or silent `\rest`
  patterns, and any OSC port changed so it can't reach the running app. Page tests with `fetch`
  stubbed never reach sclang, which is how a `; ;` syntax error once shipped to the working copy.
