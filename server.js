import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import Anthropic from '@anthropic-ai/sdk';
import { WebSocketServer } from 'ws';

const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const SCLANG = process.env.SCLANG || '/Applications/SuperCollider.app/Contents/MacOS/sclang';
const SCOPE_PORT = 57200; // UDP: scope.scd and midi.scd send OSC here
// .scd files are handed to sclang by path, so they must be real files (unpacked when the app is packaged)
const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url)).replace('app.asar', 'app.asar.unpacked');

const SYSTEM = `You write SuperCollider (sclang) code for a live-coding instrument. The server \`s\` is already booted.
Rules:
- Reply with ONLY runnable sclang code, no markdown fences, no prose. Explain with short // comments.
- The code is run as a whole file inside a Routine (fork), so s.sync and .wait are allowed at top level; no outer ( ) needed.
- Use \`s\` for the server. Do not call s.boot, s.quit or s.waitForBoot.
- Define SynthDefs with .add (not .send) and call s.sync before playing them. Use Pdef/Ndef/Pbind/Routine for patterns.
- Assign long-running things to Ndef/Pdef names or ~variables so re-running replaces rather than stacks sound.
- To send MIDI, use the pre-made port ~midi (the UI shows a MIDI tile; never create MIDIClient or MIDIOut yourself): Pbind(\\type, \\midi, \\midiout, ~midi, \\midinote, Pseq([...]), \\dur, 0.25, \\amp, 0.6) wrapped in Pdef(\\name, ...).play, or ~midi.noteOn(chan, note, vel) / ~midi.noteOff(chan, note) / ~midi.control(chan, cc, value) inside a Routine. MIDI alone makes no sound, so pair it with a SynthDef pattern when the user wants to hear it.
- When the code plays chords (always when the user asks for chords, a progression or harmony), annotate each chord with a // comment giving its name, its notes and its role in the key, e.g. // Am7: A C E G (ii in G major), next to where it is defined. For a progression, also add a one-line comment above it naming the key and the progression in Roman numerals.
- Whenever notes are written as numbers in an array, put a // comment on the same line naming each note in order, so the numbers can be read as music. MIDI note numbers (\\midinote, .midicps): absolute names with octave, where 60 = C4, e.g. Pseq([60, 63, 67, 70]) // C4 Eb4 G4 Bb4. Scale degrees (\\degree with \\scale, \\root, \\octave): the notes they produce in that key, e.g. Pseq([0, 2, 4]) // C E G (degrees 1 3 5 of C major). Semitone offsets added to a root: the notes for that root, e.g. [0, 4, 7] // C E G on root C. Spell sharps or flats to suit the key, and use "rest" for \\rest or Rest().
- Use current SuperCollider (3.14) names, not deprecated ones that print warnings: Pdup, not Pstutter. This includes code from earlier turns.
- Keep output safe: end every signal chain with a limiter or modest amp (<= 0.3) and never produce DC or runaway feedback.
- This is a conversation about one piece of code that you and the user refine together. Every reply is the complete current code (never a fragment or diff), because it replaces the editor. Keep what earlier turns built unless the user asks to change it.
- The user may edit the code between turns. When a message includes the current code, that is the latest version: build on it, including their edits.`;

const ANALYZE_SYSTEM = `You help someone learning SuperCollider understand why their code failed or printed a warning.
You get the sclang code that was run (line numbers match sclang's) and the sclang output it produced.
Do NOT rewrite the code. Explain what is wrong:
- Start with one plain sentence naming the root cause. The first ERROR is usually it; later ones often cascade, so say so if they do.
- If there are only WARNINGs, the code ran: say what the warning means and whether it changes the sound (e.g. a deprecated name that still works, a missing SynthDef that silences a voice).
- Then 1-3 short sentences on why it happens in SuperCollider terms (what the language or server is doing), citing the line number and the offending expression.
- End with a line starting "Try:" giving the smallest change to make, described in words or a tiny inline snippet.
Plain text only: no markdown headings, bullets or code fences. Keep it under 120 words.`;

// --- Claude ---------------------------------------------------------------
// $ per 1M tokens [input, output], from Anthropic's published list prices (Haiku 5.5's are for prompts
// up to 100K tokens). Override with PRICE_IN / PRICE_OUT in .env, e.g. when MODEL isn't listed here.
const PRICES = {
  'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25],
  'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
};
function summarizeUsage(u, model) {
  const cacheWrite = u.cache_creation_input_tokens || 0; // billed at 1.25x input
  const cacheRead = u.cache_read_input_tokens || 0;      // billed at 0.1x input
  const input = (u.input_tokens || 0) + cacheWrite + cacheRead;
  const output = u.output_tokens || 0;
  const [pin, pout] = process.env.PRICE_IN && process.env.PRICE_OUT && model === MODEL
    ? [Number(process.env.PRICE_IN), Number(process.env.PRICE_OUT)]
    : PRICES[model] || [];
  const cost = pin == null ? null
    : ((u.input_tokens || 0) * pin + cacheWrite * pin * 1.25 + cacheRead * pin * 0.1 + output * pout) / 1e6;
  return { input, output, cost, model };
}

// Conversation turns sent back to Claude; older ones are dropped to bound the cost of each request.
const HISTORY_TURNS = 20;

const stripFences = (t) => t.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '').trim();

// Key comes from the page's settings (per request, never stored); .env is only a fallback.
// Speed settings from the page's ⚙ dialog. Effort trades depth of reasoning for speed: low answers
// quickest, which suits short sound sketches. The model list is the PRICES table plus MODEL from .env.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const pickModel = (m) => (m && (m in PRICES || m === MODEL) ? m : MODEL);

// `content` is a single user message, or a full messages array for a conversation.
async function ask(apiKey, system, content, maxTokens, { model, effort } = {}) {
  model = pickModel(model);
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key || key.endsWith('...')) throw new Error('No API key: click ⚙ and paste your Anthropic API key');
  const client = new Anthropic({ apiKey: key });
  const messages = Array.isArray(content) ? content : [{ role: 'user', content }];
  try {
    // Stream and collect: large max_tokens values can exceed the SDK's limit for non-streaming requests.
    const res = await client.messages
      .stream({
        model, max_tokens: maxTokens, system, messages,
        ...(EFFORTS.has(effort) && { output_config: { effort } }),
      })
      .finalMessage();
    return {
      text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      truncated: res.stop_reason === 'max_tokens', // hit the output cap mid-reply
      usage: summarizeUsage(res.usage, model),
    };
  } catch (e) {
    if (e.status === 401) {
      const source = apiKey ? 'the ⚙ setting' : '.env';
      throw new Error(`401 invalid key from ${source}: ${key.slice(0, 10)}…${key.slice(-4)} (${key.length} chars)`);
    }
    throw e;
  }
}

// --- server ---------------------------------------------------------------
// Starts sclang (which boots scsynth) and the HTTP/WebSocket server the page talks to.
// Returns { port, stop }. Used by `node server.js` and by the Electron app (electron/main.js).
// dataDir holds settings.json (the chosen output device). It matches the Electron app's userData folder,
// so the app and `npm start` share the choice.
export async function start({
  port = 3000,
  log = (d) => process.stdout.write(d),
  dataDir = join(homedir(), 'Library', 'Application Support', 'Instrument'),
} = {}) {
  const settingsFile = join(dataDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); } catch {}
  const saveSettings = async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  };

  const clients = new Set();
  const broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data });
    for (const ws of clients) ws.readyState === 1 && ws.send(msg);
  };

  // --- sclang ---
  // sclang ignores stdin when it's Node's default socketpair; a real pipe (via cat) works.
  // detached => own process group, so sh, cat, sclang and the scsynth it boots can be killed together.
  // scope.scd reads the chosen output device from INSTRUMENT_OUT_DEVICE, so it boots on it directly
  const env = { ...process.env };
  if (settings.outDevice) env.INSTRUMENT_OUT_DEVICE = settings.outDevice; else delete env.INSTRUMENT_OUT_DEVICE;
  const sc = spawn('/bin/sh', ['-c', 'cat | "$0"', SCLANG], { detached: true, env });
  sc.stdout.on('data', (d) => { log(d); broadcast('log', d.toString()); });
  sc.stderr.on('data', (d) => { log(d); broadcast('log', d.toString()); });
  // Output since the last run, so a failed run's errors can be sent to Claude.
  let sinceRun = '';
  let lastRunCode = '';
  const capture = (d) => { sinceRun = (sinceRun + d).slice(-20000); };
  sc.stdout.on('data', capture);
  sc.stderr.on('data', capture);
  sc.on('exit', (code) => broadcast('log', `sclang exited (${code})\n`));
  // Audio status for the page: scsynth's output device (from its boot log) plus the /audio reports.
  let audio = { running: false, nominal: 0, actual: 0, device: null };
  let devices = { list: [], selected: settings.outDevice || null }; // selected null = system default
  let bootLog = '';
  sc.stdout.on('data', (d) => {
    bootLog = (bootLog + d).slice(-4000);
    const m = [...bootLog.matchAll(/"([^"]+)" Output Device/g)].at(-1);
    if (m && m[1] !== audio.device) { audio = { ...audio, device: m[1] }; broadcast('audio', audio); }
  });
  // Input sent while the class library is still compiling gets lost, so queue until sclang's banner.
  let scReady = false;
  const scQueue = [];
  const scEval = (line) => (scReady ? sc.stdin.write(line + '\n') : scQueue.push(line)); // one line = one statement
  sc.stdout.on('data', function onBanner(d) {
    if (!d.toString().includes('Welcome to SuperCollider')) return;
    sc.stdout.off('data', onBanner);
    setTimeout(() => { scReady = true; scQueue.splice(0).forEach(scEval); }, 1000);
  });
  // scope.scd boots the server (waitForBoot) and starts streaming the output to us
  scEval(`("${here('scope.scd')}").load;`);
  // midi.scd defines ~midi, a MIDIOut stand-in whose traffic is relayed to the page's MIDI tile
  scEval(`("${here('midi.scd')}").load;`);

  // --- scope + MIDI: sclang sends OSC over UDP; relay to the page ---
  const udp = dgram.createSocket('udp4');
  const padded = (n) => (n + 4) & ~3; // OSC strings are NUL-terminated and padded to 4 bytes
  udp.on('message', (msg) => {
    const addrEnd = msg.indexOf(0);
    const address = msg.toString('latin1', 0, addrEnd);
    // Streams are only worth decoding for a connected page; status (/audio, /devices) is kept for
    // the next page that connects, so it must always be read. /devices is only sent when it changes.
    const streaming = address === '/scope' || address === '/levels' || address === '/midi';
    if (streaming && ![...clients].some((ws) => ws.readyState === 1)) return;
    const tagStart = padded(addrEnd);
    const tagEnd = msg.indexOf(0, tagStart);
    const tags = msg.toString('latin1', tagStart + 1, tagEnd); // typetag is ",fff…" without the comma
    let off = padded(tagEnd);
    if (address === '/scope') { // relay as a binary Float32 frame
      const out = new Float32Array(tags.length);
      for (let i = 0; i < tags.length; i++) out[i] = msg.readFloatBE(off + i * 4);
      const frame = Buffer.from(out.buffer);
      for (const ws of clients) ws.readyState === 1 && ws.send(frame);
    } else if (address === '/midi') { // /midi <cmd> <args…>
      const args = [];
      for (const t of tags) {
        if (t === 'i') { args.push(msg.readInt32BE(off)); off += 4; }
        else if (t === 'f') { args.push(msg.readFloatBE(off)); off += 4; }
        else if (t === 's') { const e = msg.indexOf(0, off); args.push(msg.toString('utf8', off, e)); off = padded(e); }
        else break; // other types aren't sent by midi.scd
      }
      broadcast('midi', { cmd: args[0], args: args.slice(1) });
    } else if (address === '/levels') { // peakL rmsL peakR rmsR
      broadcast('levels', [0, 1, 2, 3].map((i) => msg.readFloatBE(off + i * 4)));
    } else if (address === '/devices') { // one string per output device
      const list = [];
      for (const t of tags) { if (t !== 's') break; const e = msg.indexOf(0, off); list.push(msg.toString('utf8', off, e)); off = padded(e); }
      devices = { ...devices, list };
      broadcast('devices', devices);
    } else if (address === '/audio') { // running(int) nominalRate actualRate
      audio = { ...audio, running: msg.readInt32BE(off) === 1, nominal: msg.readFloatBE(off + 4), actual: msg.readFloatBE(off + 8) };
      broadcast('audio', audio);
    }
  });
  udp.bind(SCOPE_PORT, '127.0.0.1');

  const tmp = await mkdtemp(join(tmpdir(), 'instrument-'));
  let runCount = 0;
  async function runCode(code) {
    // Write to a file and load it: avoids stdin line-by-line interpretation of multi-line code.
    const file = join(tmp, `run${runCount++ % 2}.scd`);
    sinceRun = '';
    lastRunCode = code;
    // `fork {` shares line 1 with the code so sclang's line numbers match the editor's
    await writeFile(file, `fork { ${code}\n}`); // Routine context makes s.sync / wait legal anywhere
    scEval(`("${file}").load;`);
  }

  // The slice of sclang output worth showing Claude: from just before the first ERROR or WARNING, capped.
  function errorContext() {
    const i = sinceRun.search(/ERROR|FAILURE|WARNING/);
    if (i < 0) return null;
    return sinceRun.slice(Math.max(0, i - 300), i + 4000).trim();
  }

  // history: earlier turns, oldest first, as [{ user, code }]: the message that was sent and the code
  // Claude returned. The page keeps it and sends it back each time; the server stores nothing.
  async function generate(prompt, currentCode, history, apiKey, opts) {
    const turns = (Array.isArray(history) ? history : [])
      .filter((t) => typeof t?.user === 'string' && typeof t?.code === 'string')
      .slice(-HISTORY_TURNS);
    // Only include the editor's code when Claude hasn't seen it: the first turn, or after the user edited
    // it (or restored or loaded another version) since Claude's last reply.
    const last = turns.at(-1)?.code;
    const user = currentCode?.trim() && currentCode.trim() !== last?.trim()
      ? `Current code${last ? ' (I changed it since your last version)' : ''}:\n${currentCode}\n\nRequest: ${prompt}`
      : prompt;
    const messages = turns.flatMap((t) => [
      { role: 'user', content: t.user },
      { role: 'assistant', content: t.code },
    ]);
    // Cache everything up to the last reply, so each turn only pays full price for what's new.
    if (messages.length) {
      const m = messages.at(-1);
      m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
    }
    messages.push({ role: 'user', content: user });
    const { text, truncated, usage } = await ask(apiKey, SYSTEM, messages, 16000, opts);
    return { code: stripFences(text), user, truncated, usage };
  }

  async function analyze(apiKey, { model } = {}) {
    const errors = errorContext();
    if (!errors) return { analysis: null };
    const content = `Code that was run:\n${lastRunCode}\n\nsclang output:\n${errors}`;
    const { text, usage } = await ask(apiKey, ANALYZE_SYSTEM, content, 1000, { model, effort: 'low' }); // a short explanation
    return { analysis: text.trim(), usage };
  }

  // --- HTTP + WS ---
  // /run executes arbitrary sclang, which can run shell commands. Only this page may call it:
  // - Host must be loopback, which defeats DNS rebinding (evil.com resolving to 127.0.0.1).
  // - Origin, which browsers send on cross-site fetches and WebSocket handshakes, must be our own,
  //   so another website open in a browser can't drive the server.
  // - POSTs must be JSON, so a cross-site request would need a CORS preflight, which we never grant.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const trusted = (req) => hosts.has(req.headers.host)
    && (!req.headers.origin || hosts.has(req.headers.origin.replace(/^https?:\/\//, '')));

  const readBody = async (req) => {
    let b = '';
    for await (const c of req) b += c;
    return b ? JSON.parse(b) : {};
  };
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!trusted(req)) return json(res, 403, { error: 'forbidden' });
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(await readFile(fileURLToPath(new URL('./index.html', import.meta.url))));
      }
      if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
        return json(res, 415, { error: 'expected application/json' });
      }
      if (req.method === 'POST' && req.url === '/generate') {
        const { prompt, code, history, model, effort } = await readBody(req);
        return json(res, 200, await generate(prompt, code, history, req.headers['x-api-key'], { model, effort }));
      }
      if (req.method === 'POST' && req.url === '/analyze') {
        return json(res, 200, await analyze(req.headers['x-api-key'], await readBody(req)));
      }
      if (req.method === 'POST' && req.url === '/run') {
        await runCode((await readBody(req)).code);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/restart-audio') {
        audio = { ...audio, running: false, device: null };
        bootLog = '';
        broadcast('audio', audio);
        scEval('~audioRestart.value;');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/audio-device') {
        const { device } = await readBody(req);
        if (device != null && typeof device !== 'string') return json(res, 400, { error: 'device must be a string or null' });
        devices = { ...devices, selected: device || null };
        settings.outDevice = device || undefined;
        await saveSettings();
        broadcast('devices', devices);
        audio = { ...audio, running: false, device: null };
        bootLog = '';
        broadcast('audio', audio);
        // as an sclang string literal, on one line (scEval sends one line per statement)
        const lit = device ? '"' + device.replace(/[\x00-\x1f]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : 'nil';
        scEval(`~audioSetDevice.value(${lit});`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/stop') {
        scEval('CmdPeriod.run;');
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  new WebSocketServer({ server, verifyClient: ({ req }) => trusted(req) }).on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'audio', data: audio }));
    ws.send(JSON.stringify({ type: 'devices', data: devices }));
    ws.on('close', () => clients.delete(ws));
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    try { process.kill(-sc.pid); } catch {} // the whole group: sh, cat, sclang and its scsynth
    udp.close();
    server.close();
  }
  return { port, stop };
}

// `node server.js` (npm start): run standalone and open in a browser
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port, stop } = await start({ port: Number(process.env.PORT) || 3000 });
  console.log(`http://127.0.0.1:${port}`);
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit());
}
