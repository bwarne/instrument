import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import Anthropic from '@anthropic-ai/sdk';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const SCLANG = process.env.SCLANG || '/Applications/SuperCollider.app/Contents/MacOS/sclang';

const SYSTEM = `You write SuperCollider (sclang) code for a live-coding instrument. The server \`s\` is already booted.
Rules:
- Reply with ONLY runnable sclang code, no markdown fences, no prose. Explain with short // comments.
- The code is run as a whole file inside a Routine (fork), so s.sync and .wait are allowed at top level; no outer ( ) needed.
- Use \`s\` for the server. Do not call s.boot, s.quit or s.waitForBoot.
- Define SynthDefs with .add (not .send) and call s.sync before playing them. Use Pdef/Ndef/Pbind/Routine for patterns.
- Assign long-running things to Ndef/Pdef names or ~variables so re-running replaces rather than stacks sound.
- To send MIDI, use the pre-made port ~midi (the UI shows a MIDI tile; never create MIDIClient or MIDIOut yourself): Pbind(\\type, \\midi, \\midiout, ~midi, \\midinote, Pseq([...]), \\dur, 0.25, \\amp, 0.6) wrapped in Pdef(\\name, ...).play, or ~midi.noteOn(chan, note, vel) / ~midi.noteOff(chan, note) / ~midi.control(chan, cc, value) inside a Routine. MIDI alone makes no sound, so pair it with a SynthDef pattern when the user wants to hear it.
- Keep output safe: end every signal chain with a limiter or modest amp (<= 0.3) and never produce DC or runaway feedback.
- If the user asks to modify the current code, return the full updated code.`;

const clients = new Set();
const broadcast = (type, data) => {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) ws.readyState === 1 && ws.send(msg);
};

// --- sclang ---------------------------------------------------------------
// sclang ignores stdin when it's Node's default socketpair; a real pipe (via cat) works.
// detached => own process group, so we can kill sh, cat and sclang together.
const sc = spawn('/bin/sh', ['-c', 'cat | "$0"', SCLANG], { detached: true });
sc.stdout.on('data', (d) => { process.stdout.write(d); broadcast('log', d.toString()); });
sc.stderr.on('data', (d) => { process.stderr.write(d); broadcast('log', d.toString()); });
// Output since the last run, so a failed run's errors can be sent to Claude with the next request.
let sinceRun = '';
let lastRunCode = '';
const capture = (d) => { sinceRun = (sinceRun + d).slice(-20000); };
sc.stdout.on('data', capture);
sc.stderr.on('data', capture);
sc.on('exit', (code) => broadcast('log', `sclang exited (${code})\n`));
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
scEval(`("${fileURLToPath(new URL('./scope.scd', import.meta.url))}").load;`);
// midi.scd defines ~midi, a MIDIOut stand-in whose traffic is relayed to the browser's MIDI tile
scEval(`("${fileURLToPath(new URL('./midi.scd', import.meta.url))}").load;`);

// --- scope: sclang sends /scope <floats...> over UDP; relay as a binary Float32 frame to browsers
const SCOPE_PORT = 57200;
const udp = dgram.createSocket('udp4');
const padded = (n) => (n + 4) & ~3; // OSC strings are NUL-terminated and padded to 4 bytes
udp.on('message', (msg) => {
  if (![...clients].some((ws) => ws.readyState === 1)) return;
  const addrEnd = msg.indexOf(0);
  const address = msg.toString('latin1', 0, addrEnd);
  const tagStart = padded(addrEnd);
  const tagEnd = msg.indexOf(0, tagStart);
  const tags = msg.toString('latin1', tagStart + 1, tagEnd); // typetag is ",fff…" without the comma
  let off = padded(tagEnd);
  if (address === '/scope') {
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
  }
});
udp.bind(SCOPE_PORT, '127.0.0.1');
process.on('exit', () => { try { process.kill(-sc.pid); } catch {} spawn('pkill', ['scsynth']); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit());

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

// The slice of sclang output worth showing Claude: from just before the first ERROR, capped.
function errorContext() {
  const i = sinceRun.search(/ERROR|FAILURE/);
  if (i < 0) return null;
  return sinceRun.slice(Math.max(0, i - 300), i + 4000).trim();
}

// --- Claude ---------------------------------------------------------------
const ANALYZE_SYSTEM = `You help someone learning SuperCollider understand why their code failed.
You get the sclang code that was run (line numbers match sclang's) and the sclang output it produced.
Do NOT rewrite the code. Explain what is wrong:
- Start with one plain sentence naming the root cause. The first ERROR is usually it; later ones often cascade, so say so if they do.
- Then 1-3 short sentences on why it happens in SuperCollider terms (what the language or server is doing), citing the line number and the offending expression.
- End with a line starting "Try:" giving the smallest change to make, described in words or a tiny inline snippet.
Plain text only: no markdown headings, bullets or code fences. Keep it under 120 words.`;

// $ per 1M tokens [input, output], from Anthropic's published list prices (Haiku 5.5's are for prompts
// up to 100K tokens). Override with PRICE_IN / PRICE_OUT in .env, e.g. when MODEL isn't listed here.
const PRICES = {
  'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25],
  'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
};
function summarizeUsage(u) {
  const cacheWrite = u.cache_creation_input_tokens || 0; // billed at 1.25x input
  const cacheRead = u.cache_read_input_tokens || 0;      // billed at 0.1x input
  const input = (u.input_tokens || 0) + cacheWrite + cacheRead;
  const output = u.output_tokens || 0;
  const [pin, pout] = process.env.PRICE_IN && process.env.PRICE_OUT
    ? [Number(process.env.PRICE_IN), Number(process.env.PRICE_OUT)]
    : PRICES[MODEL] || [];
  const cost = pin == null ? null
    : ((u.input_tokens || 0) * pin + cacheWrite * pin * 1.25 + cacheRead * pin * 0.1 + output * pout) / 1e6;
  return { input, output, cost, model: MODEL };
}

const stripFences = (t) => t.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '').trim();

// Key comes from the browser's settings (per request, never stored); .env is only a fallback.
async function ask(apiKey, system, content, maxTokens) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key || key.endsWith('...')) throw new Error('No API key: click ⚙ and paste your Anthropic API key');
  const client = new Anthropic({ apiKey: key });
  try {
    // Stream and collect: large max_tokens values can exceed the SDK's limit for non-streaming requests.
    const res = await client.messages
      .stream({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
      .finalMessage();
    return {
      text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      truncated: res.stop_reason === 'max_tokens', // hit the output cap mid-reply
      usage: summarizeUsage(res.usage),
    };
  } catch (e) {
    if (e.status === 401) {
      const source = apiKey ? 'the ⚙ setting' : '.env';
      throw new Error(`401 invalid key from ${source}: ${key.slice(0, 10)}…${key.slice(-4)} (${key.length} chars)`);
    }
    throw e;
  }
}

async function generate(prompt, currentCode, apiKey) {
  const content = currentCode ? `Current code:\n${currentCode}\n\nRequest: ${prompt}` : prompt;
  const { text, truncated, usage } = await ask(apiKey, SYSTEM, content, 16000);
  return { code: stripFences(text), truncated, usage };
}

async function analyze(apiKey) {
  const errors = errorContext();
  if (!errors) return { analysis: null };
  const content = `Code that was run:\n${lastRunCode}\n\nsclang output:\n${errors}`;
  const { text, usage } = await ask(apiKey, ANALYZE_SYSTEM, content, 1000);
  return { analysis: text.trim(), usage };
}

// --- HTTP + WS ------------------------------------------------------------
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
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(await readFile(new URL('./index.html', import.meta.url)));
    }
    if (req.method === 'POST' && req.url === '/generate') {
      const { prompt, code } = await readBody(req);
      return json(res, 200, await generate(prompt, code, req.headers['x-api-key']));
    }
    if (req.method === 'POST' && req.url === '/analyze') {
      return json(res, 200, await analyze(req.headers['x-api-key']));
    }
    if (req.method === 'POST' && req.url === '/run') {
      await runCode((await readBody(req)).code);
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

new WebSocketServer({ server }).on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}`));
