import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdtemp, mkdir, access, open, rm, rename, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import Anthropic from '@anthropic-ai/sdk';
import { WebSocketServer } from 'ws';

const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
// Where sclang may be: SCLANG from .env if set (then only there), else SuperCollider.app in
// /Applications or ~/Applications.
const SCLANG_PATHS = process.env.SCLANG ? [process.env.SCLANG] : [
  '/Applications/SuperCollider.app/Contents/MacOS/sclang',
  join(homedir(), 'Applications', 'SuperCollider.app', 'Contents', 'MacOS', 'sclang'),
];
async function findSclang() {
  for (const p of SCLANG_PATHS) {
    try { await access(p, constants.X_OK); return p; } catch {}
  }
  return null;
}
// ⤴ Share posts the code (and the last take) here and gets a public link back; see share/.
// Override with SHARE_URL in .env to point at your own deployment.
const SHARE_URL = (process.env.SHARE_URL || 'https://share.aninstrument.jono.solutions').replace(/\/+$/, '');
const MAX_SHARE_CODE = 256 * 1024;   // the share service's own caps, so we fail before uploading
const MAX_SHARE_AUDIO = 20 * 1024 * 1024;

const SCOPE_PORT = 57200; // UDP: scope.scd and midi.scd send OSC here
// .scd files are handed to sclang by path, so they must be real files (unpacked when the app is packaged)
const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url)).replace('app.asar', 'app.asar.unpacked');

const SYSTEM = `You write SuperCollider (sclang) code for a live-coding instrument. The server \`s\` is already booted.
Rules:
- Reply with ONLY runnable sclang code, no markdown fences, no prose. Explain with short // comments.
- The code is run as a whole file inside a Routine (fork), so s.sync and .wait are allowed at top level; no outer ( ) needed.
- Use \`s\` for the server. Do not call s.boot, s.quit or s.waitForBoot.
- Define SynthDefs with .add (not .send) and call s.sync before playing them. Use Pdef/Ndef/Pbind/Routine for patterns.
- Give every ongoing sound its own named Pdef or Ndef, one per musical part (e.g. Pdef(\\kick), Pdef(\\bass), Ndef(\\pad)), started with .play. Don't play ongoing sound with bare Synth(...), {...}.play or a loose Routine. The app shows each Pdef/Ndef as a toggle, re-runs replace them in place, and commenting one out stops it.
- The UI's MIDI tile shows every note played by a pattern (Pbind's default note events) automatically, so play notes, melodies, bass lines, chords and drum hits as Pbind patterns in Pdefs (not Synth(...) in a Routine) and they show up there. Don't add ~midi just to display notes.
- To send MIDI to a device or DAW (only when the user asks for MIDI), use the pre-made port ~midi (never create MIDIClient or MIDIOut yourself): Pbind(\\type, \\midi, \\midiout, ~midi, \\midinote, Pseq([...]), \\dur, 0.25, \\amp, 0.6) wrapped in Pdef(\\name, ...).play, or ~midi.noteOn(chan, note, vel) / ~midi.noteOff(chan, note) / ~midi.control(chan, cc, value) inside a Routine. MIDI alone makes no sound, so pair it with a SynthDef pattern when the user wants to hear it (add \\midiTap, false to that synth pattern so its notes aren't shown twice).
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

const GEAR_SYSTEM = `You advise someone learning synthesis on what physical instruments (hardware synths, drum machines, samplers, grooveboxes, effects pedals and units) could recreate a sound they made in SuperCollider.
You get the SuperCollider code and the requests that produced it. Work out the sound's parts (e.g. the detuned saw pad, the sub bass, the 808-style kick, the shimmering reverb) and suggest 3-6 instruments:
- Each one names which part(s) it covers and why it suits them, in terms a beginner can follow.
- Prefer well-known, currently available gear; mix budget and higher-end choices, and include one instrument that covers most of the sound on its own when one exists.
- Prices are estimates in USD from your knowledge: typical new street price and typical used price, as ranges. They may be out of date; don't claim precision.
- "tip" says how to get this patch's sound on that instrument (oscillators, filter, envelope settings, effects).
- "name" is the model name only, without the maker (name "minilogue xd", maker "Korg").
- "search" is the exact query to type into a music store's search, usually maker plus model.
- "rigs" are 1-3 complete setups (e.g. budget, all-in-one, studio) listing instrument names from your list and their total estimated new price.`;

const GEAR_SCHEMA = (() => {
  const range = { type: 'object', additionalProperties: false, required: ['low', 'high'],
    properties: { low: { type: 'integer' }, high: { type: 'integer' } } };
  const str = { type: 'string' };
  return {
    type: 'object', additionalProperties: false, required: ['summary', 'items', 'rigs'],
    properties: {
      summary: { type: 'string', description: "One or two sentences naming the sound's parts." },
      items: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'maker', 'category', 'tier', 'covers', 'why', 'synthesis', 'voices', 'form', 'price_new_usd', 'price_used_usd', 'tip', 'search'],
        properties: {
          name: str, maker: str,
          category: { type: 'string', enum: ['synth', 'drum machine', 'sampler', 'groovebox', 'effects pedal', 'effects unit', 'other'] },
          tier: { type: 'string', enum: ['budget', 'mid', 'high-end'] },
          covers: { type: 'string', description: 'Which part(s) of this sound it plays' },
          why: str,
          synthesis: { type: 'string', description: 'e.g. "analog subtractive", "FM", "sample playback"' },
          voices: { type: 'string', description: 'e.g. "mono", "4-voice poly", "n/a"' },
          form: { type: 'string', description: 'e.g. "37 mini keys", "desktop module", "pedal"' },
          price_new_usd: range, price_used_usd: range, tip: str, search: str,
        },
      } },
      rigs: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['name', 'items', 'total_new_usd', 'note'],
        properties: { name: str, items: { type: 'array', items: str }, total_new_usd: { type: 'integer' }, note: str },
      } },
    },
  };
})();

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
  return { input, output, cost, model, cacheRead, cacheWrite };
}

// The usage history: start() points this at usage.jsonl in the data folder, and ask() adds a line for
// every call that comes back, whatever feature made it. Calls made outside start() (tests) aren't recorded.
let recordUsage = null;

const stripFences = (t) => t.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '').trim();

// Key comes from the page's settings (per request, never stored); .env is only a fallback.
// Speed settings from the page's ⚙ dialog. Effort trades depth of reasoning for speed: low answers
// quickest, which suits short sound sketches. The model list is the PRICES table plus MODEL from .env.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const pickModel = (m) => (m && (m in PRICES || m === MODEL) ? m : MODEL);

// --- the API key ---
// .env's ANTHROPIC_API_KEY, unless it's the placeholder from .env.example
const envKey = () => { const k = process.env.ANTHROPIC_API_KEY; return k && !k.endsWith('...') ? k : null; };
const keyHint = (k) => `${k.slice(0, 7)}…${k.slice(-4)}`; // enough to recognise a key without revealing it
// An Error with a code the page acts on: no_key, bad_key, no_credit
const coded = (message, code) => Object.assign(new Error(message), { code });

// Checks a key with a free request (listing models). Credit isn't checked: that only shows on a real call.
export async function checkKey(key) {
  if (typeof key !== 'string' || !/^sk-ant-[\w-]{20,}$/.test(key.trim())) {
    return { ok: false, error: "That doesn't look like an Anthropic API key. They start with sk-ant-." };
  }
  try {
    await new Anthropic({ apiKey: key.trim(), maxRetries: 1, timeout: 15000 }).models.list({ limit: 1 });
    return { ok: true };
  } catch (e) {
    if (e.status === 401) return { ok: false, error: 'Anthropic rejected this key. Copy it again from the Console (it is only shown once, when created).' };
    if (e.status === 403) return { ok: false, error: "This key isn't allowed to use the API. Check its workspace in the Console." };
    return { ok: false, error: `Couldn't check the key: ${e.message}` };
  }
}

// `content` is a single user message, or a full messages array for a conversation.
// `format` is a JSON schema the reply must follow (structured output).
// `kind` names the feature for the usage history (generate, fix, analysis, gear).
async function ask(apiKey, system, content, maxTokens, { model, effort, format, kind = 'other' } = {}) {
  model = pickModel(model);
  const key = apiKey || envKey();
  if (!key) throw coded('No API key yet: connect your Anthropic account under ⚙', 'no_key');
  const client = new Anthropic({ apiKey: key });
  const messages = Array.isArray(content) ? content : [{ role: 'user', content }];
  const output_config = {
    ...(EFFORTS.has(effort) && { effort }),
    ...(format && { format: { type: 'json_schema', schema: format } }),
  };
  const t0 = Date.now();
  try {
    // Stream and collect: large max_tokens values can exceed the SDK's limit for non-streaming requests.
    const res = await client.messages
      .stream({
        model, max_tokens: maxTokens, system, messages,
        ...(Object.keys(output_config).length && { output_config }),
      })
      .finalMessage();
    const usage = summarizeUsage(res.usage, model);
    recordUsage?.({
      at: new Date().toISOString(), kind, model, effort: output_config.effort ?? null,
      input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
      cost: usage.cost, ms: Date.now() - t0,
    });
    return {
      text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      truncated: res.stop_reason === 'max_tokens', // hit the output cap mid-reply
      usage,
    };
  } catch (e) {
    if (e.status === 401) {
      const source = apiKey ? 'the ⚙ setting' : '.env';
      throw coded(`Anthropic rejected the API key from ${source} (${keyHint(key)}). It may have been deleted or mistyped: connect again under ⚙.`, 'bad_key');
    }
    if (/credit balance/i.test(e.message)) throw coded('Your Anthropic account is out of credit. Add some in the Claude Console (Settings → Billing), then try again.', 'no_credit');
    throw e;
  }
}

// --- requests to Claude that don't need sclang (exported for tests) ---------
// history: earlier turns, oldest first, as [{ user, code }]: the message that was sent and the code
// Claude returned. The page keeps it and sends it back each time; the server stores nothing.
export async function generate(prompt, currentCode, history, apiKey, opts) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t) => typeof t?.user === 'string' && typeof t?.code === 'string'); // all of them, for generate and fix alike
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
  const { text, truncated, usage } = await ask(apiKey, SYSTEM, messages, 16000, { ...opts, kind: opts?.kind === 'fix' ? 'fix' : 'generate' });
  return { code: stripFences(text), user, truncated, usage };
}

// Gear that could play this sound: the code plus the prompts behind it, answered as GEAR_SCHEMA JSON.
export async function gear(apiKey, { code, prompts, model, effort } = {}) {
  if (!code?.trim()) throw new Error('Nothing in the editor to find gear for');
  const asked = (Array.isArray(prompts) ? prompts : []).filter((p) => typeof p === 'string').slice(-20);
  const content = (asked.length ? `Requests that produced it:\n${asked.map((p) => '- ' + p).join('\n')}\n\n` : '')
    + `SuperCollider code:\n${code}`;
  const { text, truncated, usage } = await ask(apiKey, GEAR_SYSTEM, content, 8000, { model, effort, format: GEAR_SCHEMA, kind: 'gear' });
  if (truncated) throw new Error('The gear list was cut off; try again');
  return { gear: JSON.parse(text), usage };
}

// --- server ---------------------------------------------------------------
// --- recordings: record.scd writes WAV; MP3s are made from it here (exported for tests) ---
// The layout of a WAV file's samples, from its fmt and data chunks.
export async function wavInfo(fh) {
  const { size } = await fh.stat();
  const head = Buffer.alloc(Math.min(size, 65536));
  await fh.read(head, 0, head.length, 0);
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  for (let off = 12; off + 8 <= head.length;) {
    const id = head.toString('latin1', off, off + 4), len = head.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      let format = head.readUInt16LE(off + 8);
      if (format === 0xfffe) format = head.readUInt16LE(off + 32); // WAVE_FORMAT_EXTENSIBLE: the subformat
      fmt = { format, channels: head.readUInt16LE(off + 10), rate: head.readUInt32LE(off + 12), bits: head.readUInt16LE(off + 22) };
    } else if (id === 'data' && fmt) {
      const start = off + 8;
      // an unfinished file (the app quit mid-take) has no size yet: take everything after the header
      const bytes = len && start + len <= size ? len : size - start;
      const frameBytes = fmt.channels * fmt.bits / 8;
      return { ...fmt, start, frameBytes, frames: Math.floor(bytes / frameBytes) };
    }
    off += 8 + len + (len & 1);
  }
  throw new Error('no audio in the WAV file');
}

// Encodes a WAV (16/24/32-bit integer or 32-bit float) as a 320 kbps MP3, a block at a time so the
// server stays responsive. Writes to a temporary name first, so a half-made MP3 is never served.
export async function wavToMp3(wavPath, mp3Path) {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const fh = await open(wavPath);
  const tmpPath = mp3Path + '.part';
  const out = await open(tmpPath, 'w');
  try {
    const w = await wavInfo(fh);
    const int = w.format === 1 && [16, 24, 32].includes(w.bits), float = w.format === 3 && w.bits === 32;
    if (!int && !float) throw new Error(`can't convert this WAV (format ${w.format}, ${w.bits}-bit)`);
    if (w.rate > 48000) throw new Error(`MP3 only goes up to 48 kHz; this recording is ${w.rate / 1000} kHz. Save the WAV instead.`);
    const enc = new Mp3Encoder(2, w.rate, 320);
    const bytesPer = w.bits / 8, BLOCK = 1152 * 64;
    const buf = Buffer.alloc(BLOCK * w.frameBytes), l = new Int16Array(BLOCK), r = new Int16Array(BLOCK);
    const sample = (o) => {
      if (float) return Math.max(-32768, Math.min(32767, Math.round(buf.readFloatLE(o) * 32767)));
      if (w.bits === 16) return buf.readInt16LE(o);
      return w.bits === 24 ? buf.readIntLE(o, 3) >> 8 : buf.readInt32LE(o) >> 16;
    };
    for (let done = 0; done < w.frames;) {
      const n = Math.min(BLOCK, w.frames - done);
      await fh.read(buf, 0, n * w.frameBytes, w.start + done * w.frameBytes);
      for (let i = 0; i < n; i++) {
        const o = i * w.frameBytes;
        l[i] = sample(o);
        r[i] = w.channels > 1 ? sample(o + bytesPer) : l[i]; // mono plays on both sides
      }
      const mp3 = enc.encodeBuffer(l.subarray(0, n), r.subarray(0, n));
      if (mp3.length) await out.write(mp3);
      done += n;
    }
    const tail = enc.flush();
    if (tail.length) await out.write(tail);
  } catch (e) {
    await out.close(); await rm(tmpPath, { force: true });
    throw e;
  } finally {
    await fh.close();
  }
  await out.close();
  await rename(tmpPath, mp3Path);
}

// A Standard MIDI File (format 1) of the MIDI heard during a take. events: [{ t (ms into the take), cmd,
// args }] as relayed from sclang: noteOn [chan, note, vel, instrument?, tempo?], noteOff [chan, note],
// control [chan, cc, value], program [chan, n], bend [chan, value 0–16383], allNotesOff [chan].
// Each instrument (or ~midi channel) gets its own track. The file's tempo is the music's, so a DAW's bars
// line up with its beats (though not with its downbeats, since the take starts wherever it started).
export function takeToMidi(events, seconds) {
  const PPQ = 480;
  const bps = events.find((e) => e.cmd === 'noteOn' && e.args[4] > 0)?.args[4] ?? 2; // 120 bpm if unknown
  const tick = (ms) => Math.max(0, Math.round((ms / 1000) * bps * PPQ));
  const end = tick(seconds * 1000);
  const tracks = new Map(); // key → { name, chan, ev: [[tick, order, bytes]] }
  const held = new Map(); // `${chan}:${note}` → the track a sounding note was started on
  const trackFor = (chan, name) => {
    const key = name ? `i:${name}` : `c:${chan}`;
    if (!tracks.has(key)) tracks.set(key, { name: name || `~midi channel ${chan + 1}`, chan, ev: [] });
    return tracks.get(key);
  };
  const off = (tr, chan, note, at) => tr.ev.push([at, 0, [0x80 | chan, note, 0]]);
  for (const { t, cmd, args } of events) {
    const chan = (args[0] | 0) & 15, at = Math.min(tick(t), end);
    if (cmd === 'noteOn' && args[2] > 0) {
      const k = `${chan}:${args[1]}`;
      if (held.has(k)) off(held.get(k), chan, args[1], at); // a repeat of a sounding note ends it first
      const tr = trackFor(chan, typeof args[3] === 'string' ? args[3] : null);
      tr.ev.push([at, 1, [0x90 | chan, args[1] & 127, Math.max(1, args[2] & 127)]]);
      held.set(k, tr);
    } else if (cmd === 'noteOff' || cmd === 'noteOn') {
      const k = `${chan}:${args[1]}`;
      if (held.has(k)) { off(held.get(k), chan, args[1], at); held.delete(k); }
    } else if (cmd === 'allNotesOff') {
      for (const [k, tr] of held) if (+k.split(':')[0] === chan) { off(tr, chan, +k.split(':')[1], at); held.delete(k); }
    } else if (cmd === 'control') trackFor(chan).ev.push([at, 1, [0xb0 | chan, args[1] & 127, args[2] & 127]]);
    else if (cmd === 'program') trackFor(chan).ev.push([at, 1, [0xc0 | chan, args[1] & 127]]);
    else if (cmd === 'bend') trackFor(chan).ev.push([at, 1, [0xe0 | chan, args[1] & 127, (args[1] >> 7) & 127]]);
  }
  for (const [k, tr] of held) off(tr, +k.split(':')[0], +k.split(':')[1], end); // still sounding at the end

  const vlq = (n) => { const b = [n & 127]; while ((n >>= 7)) b.unshift((n & 127) | 128); return b; };
  const text = (type, s) => { const b = [...Buffer.from(s, 'utf8')]; return [0xff, type, ...vlq(b.length), ...b]; };
  const chunk = (id, bytes) => { const h = Buffer.alloc(8); h.write(id, 'latin1'); h.writeUInt32BE(bytes.length, 4); return Buffer.concat([h, Buffer.from(bytes)]); };
  const track = (head, ev) => {
    const out = [0, ...head];
    let last = 0;
    // by time; at the same time, note-offs first, so a repeated note ends before it starts again
    for (const [at, , bytes] of ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])) { out.push(...vlq(at - last), ...bytes); last = at; }
    out.push(...vlq(Math.max(0, end - last)), 0xff, 0x2f, 0); // end of track, at the end of the take
    return chunk('MTrk', out);
  };
  const usPerBeat = Math.round(1e6 / bps);
  const header = Buffer.alloc(6);
  header.writeUInt16BE(1, 0); header.writeUInt16BE(tracks.size + 1, 2); header.writeUInt16BE(PPQ, 4);
  return Buffer.concat([
    chunk('MThd', [...header]),
    track([...text(3, 'AnInstrument'), 0, 0xff, 0x51, 3, usPerBeat >> 16, (usPerBeat >> 8) & 255, usPerBeat & 255], []),
    ...[...tracks.values()].map((tr) => track(text(3, tr.name), tr.ev)),
  ]);
}

// The app's own version, for the share service's records. Read from package.json, which is inside
// app.asar in the packaged app (Electron's fs reads straight through it).
let appVersion;
async function version() {
  if (appVersion === undefined) {
    try {
      appVersion = JSON.parse(await readFile(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version || '';
    } catch {
      appVersion = '';
    }
  }
  return appVersion;
}

// Starts sclang (which boots scsynth) and the HTTP/WebSocket server the page talks to.
// Returns { port, stop }. Used by `node server.js` and by the Electron app (electron/main.js).
// dataDir holds settings.json (the chosen output device) and usage.jsonl (every Claude call's tokens and
// cost). It matches the Electron app's userData folder, so the app and `npm start` share them.
export async function start({
  port = 3000,
  log = (d) => process.stdout.write(d),
  dataDir = join(homedir(), 'Library', 'Application Support', 'Instrument'),
  // The UDP port sclang sends OSC to. The .scd files have 57200 compiled in, so overriding this
  // only makes sense when audio isn't wanted: the share tests do it to run beside the real app.
  scopePort = SCOPE_PORT,
} = {}) {
  const settingsFile = join(dataDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); } catch {}
  const saveSettings = async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  };
  const usageFile = join(dataDir, 'usage.jsonl'); // one JSON object per line, oldest first
  recordUsage = (entry) => mkdir(dataDir, { recursive: true })
    .then(() => appendFile(usageFile, JSON.stringify(entry) + '\n'))
    .catch((e) => log(`! couldn't record usage: ${e.message}\n`));

  const clients = new Set();
  const broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data });
    for (const ws of clients) ws.readyState === 1 && ws.send(msg);
  };

  // --- sclang ---
  // Output since the last run, so a failed run's errors can be sent to Claude.
  let sinceRun = '';
  let lastRunCode = '';
  const capture = (d) => { sinceRun = (sinceRun + d).slice(-20000); };
  // Audio status for the page: scsynth's output device (from its boot log) plus the /audio reports.
  let audio = { running: false, nominal: 0, actual: 0, device: null };
  let devices = { list: [], selected: settings.outDevice || null }; // selected null = system default
  let parts = []; // [{ kind: 'pdef'|'ndef', name, playing, muted }] from parts.scd
  let bootLog = '';
  // Input sent while the class library is still compiling gets lost, so queue until sclang's banner.
  let sc = null; // the sh | sclang process; null until SuperCollider is found
  let scReady = false;
  const scQueue = [];
  const scEval = (line) => (sc && scReady ? sc.stdin.write(line + '\n') : scQueue.push(line)); // one line = one statement

  // Without SuperCollider the page shows setup instructions instead, and asks again (/recheck) once
  // the user has installed it; then sclang starts without restarting the app.
  function launchSclang(path) {
    // sclang ignores stdin when it's Node's default socketpair; a real pipe (via cat) works.
    // detached => own process group, so sh, cat, sclang and the scsynth it boots can be killed together.
    // scope.scd reads the chosen output device from INSTRUMENT_OUT_DEVICE, so it boots on it directly
    const env = { ...process.env };
    if (settings.outDevice) env.INSTRUMENT_OUT_DEVICE = settings.outDevice; else delete env.INSTRUMENT_OUT_DEVICE;
    sc = spawn('/bin/sh', ['-c', 'cat | "$0"', path], { detached: true, env });
    sc.stdout.on('data', (d) => { log(d); broadcast('log', d.toString()); });
    sc.stderr.on('data', (d) => { log(d); broadcast('log', d.toString()); });
    sc.stdout.on('data', capture);
    sc.stderr.on('data', capture);
    sc.on('exit', (code) => broadcast('log', `sclang exited (${code})\n`));
    sc.stdout.on('data', (d) => {
      bootLog = (bootLog + d).slice(-4000);
      const m = [...bootLog.matchAll(/"([^"]+)" Output Device/g)].at(-1);
      if (m && m[1] !== audio.device) { audio = { ...audio, device: m[1] }; broadcast('audio', audio); }
    });
    sc.stdout.on('data', function onBanner(d) {
      if (!d.toString().includes('Welcome to SuperCollider')) return;
      sc.stdout.off('data', onBanner);
      setTimeout(() => { scReady = true; scQueue.splice(0).forEach(scEval); }, 1000);
    });
    // These go first; anything queued while SuperCollider was missing is dropped.
    scQueue.length = 0;
    // scope.scd boots the server (waitForBoot) and starts streaming the output to us
    scEval(`("${here('scope.scd')}").load;`);
    // midi.scd defines ~midi, a MIDIOut stand-in whose traffic is relayed to the page's MIDI tile
    scEval(`("${here('midi.scd')}").load;`);
    // parts.scd tracks Pdefs/Ndefs for the parts strip and stops the ones the code no longer mentions
    scEval(`("${here('parts.scd')}").load;`);
    // record.scd: the Record button's recorder (~recStart, ~recStop)
    scEval(`("${here('record.scd')}").load;`);
  }
  const found = await findSclang();
  if (found) launchSclang(found);
  else log(`SuperCollider not found (looked in ${SCLANG_PATHS.join(', ')}); the page shows setup steps.\n`);

  // --- scope + MIDI: sclang sends OSC over UDP; relay to the page ---
  const udp = dgram.createSocket('udp4');
  const padded = (n) => (n + 4) & ~3; // OSC strings are NUL-terminated and padded to 4 bytes
  udp.on('message', (msg) => {
    const addrEnd = msg.indexOf(0);
    const address = msg.toString('latin1', 0, addrEnd);
    // Streams are only worth decoding for a connected page; status (/audio, /devices) is kept for
    // the next page that connects, so it must always be read. /devices is only sent when it changes.
    const streaming = address === '/scope' || address === '/levels' || address === '/midi';
    const recording = address === '/midi' && rec.state === 'recording'; // MIDI is kept for the take
    if (streaming && !recording && ![...clients].some((ws) => ws.readyState === 1)) return;
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
      if (recording) recMidi.push({ t: Date.now() - rec.startedAt, cmd: args[0], args: args.slice(1) });
      broadcast('midi', { cmd: args[0], args: args.slice(1) });
    } else if (address === '/levels') { // peakL rmsL peakR rmsR
      broadcast('levels', [0, 1, 2, 3].map((i) => msg.readFloatBE(off + i * 4)));
    } else if (address === '/devices') { // one string per output device
      const list = [];
      for (const t of tags) { if (t !== 's') break; const e = msg.indexOf(0, off); list.push(msg.toString('utf8', off, e)); off = padded(e); }
      devices = { ...devices, list };
      broadcast('devices', devices);
    } else if (address === '/parts') { // kind name playing muted, repeated
      const vals = [];
      for (const t of tags) {
        if (t === 's') { const e = msg.indexOf(0, off); vals.push(msg.toString('utf8', off, e)); off = padded(e); }
        else if (t === 'i') { vals.push(msg.readInt32BE(off)); off += 4; }
        else break;
      }
      parts = [];
      for (let i = 0; i + 3 < vals.length; i += 4) {
        parts.push({ kind: vals[i], name: vals[i + 1], playing: vals[i + 2] === 1, muted: vals[i + 3] === 1 });
      }
      broadcast('parts', parts);
    } else if (address === '/audio') { // running(int) nominalRate actualRate
      audio = { ...audio, running: msg.readInt32BE(off) === 1, nominal: msg.readFloatBE(off + 4), actual: msg.readFloatBE(off + 8) };
      broadcast('audio', audio);
    } else if (address === '/record') { // "started"|"finished"|"failed", then a path or a reason
      const vals = [];
      for (const t of tags) { if (t !== 's') break; const e = msg.indexOf(0, off); vals.push(msg.toString('utf8', off, e)); off = padded(e); }
      onRecord(vals[0], vals[1]);
    } else if (address === '/fade') { // "started" seconds | "done" | "cancelled"
      const e = msg.indexOf(0, off), what = tags[0] === 's' ? msg.toString('utf8', off, e) : '';
      if (what === 'started') setFade({ fading: true, seconds: tags[1] === 'f' ? msg.readFloatBE(padded(e)) : 0, startedAt: Date.now() });
      else setFade({ fading: false, done: what === 'done' });
    }
  });

  const tmp = await mkdtemp(join(tmpdir(), 'instrument-'));
  let runCount = 0;

  // --- recording (record.scd) ---
  // A take is recorded to the temp folder as <id>.wav, the id being its start time; the page then
  // offers it as a WAV or MP3 download, along with <id>.mid, the MIDI notes heard during it. state: idle | starting | recording | stopping.
  // take: the last finished one, { id, seconds }. error: why the last start or stop failed.
  let rec = { state: 'idle', take: null, error: null };
  let recPath = null, recTimer = null;
  let recMidi = []; // the MIDI heard during the take, for its .mid file: [{ t (ms in), cmd, args }]
  const setRec = (r) => { rec = { ...rec, ...r }; broadcast('record', rec); };
  // Fade out (record.scd): fades the output over some seconds, then finishes the take and stops.
  let fade = { fading: false };
  const setFade = (f) => { fade = f; broadcast('fade', fade); };

  // Bound here, after the state its handler reads exists, and awaited: an unhandled bind error on
  // a dgram socket would otherwise take the whole process down with a bare stack trace. In use
  // almost always means a second copy, which is what the Electron dialog says for EADDRINUSE.
  let udpBound = false;
  udp.on('error', (e) => { if (udpBound) log(`! the scope/MIDI socket failed: ${e.message}\n`); });
  try {
    await new Promise((ok, fail) => {
      udp.once('error', (e) => fail(e.code === 'EADDRINUSE'
        ? Object.assign(new Error(`UDP port ${scopePort} is already in use: another copy of AnInstrument (or npm start) is running.`), { code: 'EADDRINUSE' })
        : e));
      udp.bind(scopePort, '127.0.0.1', () => { udpBound = true; ok(); });
    });
  } catch (e) {
    // sclang is already running by now; without this it would outlive the failed start
    if (sc) try { process.kill(-sc.pid); } catch {}
    try { udp.close(); } catch {}
    throw e;
  }
  const takePath = (id, ext) => join(tmp, `${id}.${ext}`);
  const mp3s = new Map(); // id → the promise of its MP3
  // sclang should answer within a few seconds; if it doesn't (audio not booted, scsynth hung), give up
  const recTimeout = (what) => {
    clearTimeout(recTimer);
    recTimer = setTimeout(() => setRec({ state: 'idle', error: `the recording didn't ${what}` }), 8000);
  };
  async function onRecord(what, arg) {
    clearTimeout(recTimer);
    if (what === 'started') { recMidi = []; return setRec({ state: 'recording', startedAt: Date.now(), error: null }); }
    if (what === 'failed') return setRec({ state: 'idle', error: arg || 'recording failed' });
    if (what !== 'finished' || arg !== recPath) return;
    const id = rec.id;
    let seconds = 0;
    try { const fh = await open(arg); try { const w = await wavInfo(fh); seconds = w.frames / w.rate; } finally { await fh.close(); } } catch {}
    const notes = recMidi.filter((e) => e.cmd === 'noteOn' && e.args[2] > 0).length;
    try { await writeFile(takePath(id, 'mid'), takeToMidi(recMidi, seconds)); } catch (e) { log(`! couldn't write the take's MIDI: ${e.message}\n`); }
    recMidi = [];
    setRec({ state: 'idle', take: { id, seconds, notes }, error: null });
  }
  function recordOn(on) {
    if (on && (rec.state === 'idle')) {
      const id = String(Date.now());
      recPath = takePath(id, 'wav');
      setRec({ state: 'starting', id, error: null });
      recTimeout('start: is the audio running?');
      scEval(`~recStart.value("${recPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}");`);
    } else if (!on && (rec.state === 'recording' || rec.state === 'starting')) {
      setRec({ state: 'stopping' });
      recTimeout('finish');
      scEval('~recStop.value;');
    }
  }
  // A take's download name, from when it started: "AnInstrument 2026-10-14 15.42.07.wav"
  const takeName = (id, ext) => {
    const d = new Date(Number(id)), p2 = (n) => String(n).padStart(2, '0');
    return `AnInstrument ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}.${ext}`;
  };
  // The page asks for the MP3 to be made first (POST /take-mp3), so it can show progress and errors,
  // then downloads it; a download link can't show an error.
  async function makeMp3(id) {
    const wav = takePath(id, 'wav');
    await stat(wav); // throws (404) if there's no such take
    if (!mp3s.has(id)) mp3s.set(id, wavToMp3(wav, takePath(id, 'mp3')).catch((e) => { mp3s.delete(id); throw e; }));
    await mp3s.get(id);
  }
  async function sendTake(res, id, ext) {
    if (ext === 'mp3') await makeMp3(id);
    const file = takePath(id, ext);
    const { size } = await stat(file);
    res.writeHead(200, {
      'content-type': { mp3: 'audio/mpeg', wav: 'audio/wav', mid: 'audio/midi' }[ext],
      'content-length': size,
      'content-disposition': `attachment; filename="${takeName(id, ext)}"`,
    });
    createReadStream(file).pipe(res);
  }
  // A part key names a Pdef or Ndef: 'pdef:drums', 'ndef:pad'. Checked strictly, since keys are
  // written into sclang source.
  const PART_KEY = /^(pdef|ndef):[A-Za-z_][A-Za-z0-9_]*$/;

  // --- ⤴ Share (share/, a Cloudflare Worker) ---
  // Publishes the editor's code, and the last take's MP3 if asked for, as a link anyone can open.
  // Nothing leaves the machine until the user presses Share in the dialog, which is where the
  // page explains that the link is public. The token comes back so the page can unshare later.
  async function shareSketch({ code, title, takeId, parts, audio = true }) {
    if (typeof code !== 'string' || !code.trim()) throw new Error('Nothing in the editor to share');
    if (code.length > MAX_SHARE_CODE) throw new Error('That code is too long to share');
    const form = new FormData();
    form.append('code', code);
    form.append('app', await version());
    if (typeof title === 'string' && title.trim()) form.append('title', title.trim().slice(0, 120));
    if (Array.isArray(parts)) {
      form.append('parts', parts.filter((k) => typeof k === 'string' && PART_KEY.test(k)).slice(0, 16).join(','));
    }

    if (audio && takeId != null) {
      const id = String(takeId);
      if (!/^\d{10,16}$/.test(id)) throw new Error('bad recording id');
      await makeMp3(id); // ENOENT if that take is gone; encodes it if it hasn't been yet
      const mp3 = takePath(id, 'mp3');
      const { size } = await stat(mp3);
      if (size > MAX_SHARE_AUDIO) {
        throw new Error(`That take is ${(size / 1e6).toFixed(1)} MB, over the ${MAX_SHARE_AUDIO / 1e6} MB share limit. `
          + 'Share the code on its own, or record a shorter take.');
      }
      form.append('audio', new Blob([await readFile(mp3)], { type: 'audio/mpeg' }), 'take.mp3');
      if (rec.take?.id === id) {
        form.append('seconds', String(Math.round(rec.take.seconds || 0)));
        form.append('notes', String(rec.take.notes || 0));
      }
    }

    let res;
    try {
      // x-aninstrument is what tells the service this came from the app and not from a web page
      res = await fetch(`${SHARE_URL}/api/share`, {
        method: 'POST',
        headers: { 'x-aninstrument': '1' },
        body: form,
        signal: AbortSignal.timeout(180_000), // a 20 MB take on a slow line
      });
    } catch (e) {
      throw new Error(`Couldn't reach the share service (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The share service returned ${res.status}.`);
    // The page shows this link, opens it and keeps it, so it has to be a share on the service we
    // posted to, not whatever the response says (a javascript: URL, another site).
    if (!/^[a-z0-9]{12}$/.test(String(body.id)) || typeof body.token !== 'string'
        || typeof body.url !== 'string' || !body.url.startsWith(`${SHARE_URL}/s/`)) {
      throw new Error('The share service sent back something unexpected, so the link was not used.');
    }
    return body;
  }

  async function unshareSketch({ id, token }) {
    if (!/^[a-z0-9]{12}$/.test(String(id ?? ''))) throw new Error('bad share id');
    let res;
    try {
      res = await fetch(`${SHARE_URL}/api/share/${id}`, {
        method: 'DELETE',
        headers: { 'x-share-token': String(token ?? '') },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`Couldn't reach the share service (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
    }
    if (res.status === 404) return { ok: true, gone: true }; // already deleted or expired
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The share service returned ${res.status}.`);
    return { ok: true };
  }

  // keep: the part keys the code mentions outside comments (the page works them out). After the code
  // runs, parts.scd stops every other part, so deleting or commenting out a part silences it.
  async function runCode(code, keep) {
    const keys = (Array.isArray(keep) ? keep : []).filter((k) => typeof k === 'string' && PART_KEY.test(k));
    // Write to a file and load it: avoids stdin line-by-line interpretation of multi-line code.
    const file = join(tmp, `run${runCount++ % 2}.scd`);
    sinceRun = '';
    lastRunCode = code;
    // `fork {` shares line 1 with the code so sclang's line numbers match the editor's, and its
    // Routine context makes s.sync / wait legal anywhere. The parts sync runs after the code, which
    // sits in its own function so the sync is a separate statement however the code ends (`; ;`,
    // an empty statement, is a syntax error in sclang). It only runs if the code finished cleanly.
    const sync = `~partsSync.value([${keys.map((k) => `'${k}'`).join(', ')}]);`;
    await writeFile(file, Array.isArray(keep) ? `fork { { ${code}\n}.value;\n${sync}\n}` : `fork { ${code}\n}`);
    scEval(`("${file}").load;`);
  }

  // The slice of sclang output worth showing Claude: from just before the first ERROR or WARNING, capped.
  function errorContext() {
    const i = sinceRun.search(/ERROR|FAILURE|WARNING/);
    if (i < 0) return null;
    return sinceRun.slice(Math.max(0, i - 300), i + 4000).trim();
  }

  async function analyze(apiKey, { model } = {}) {
    const errors = errorContext();
    if (!errors) return { analysis: null };
    const content = `Code that was run:\n${lastRunCode}\n\nsclang output:\n${errors}`;
    const { text, usage } = await ask(apiKey, ANALYZE_SYSTEM, content, 1000, { model, effort: 'low', kind: 'analysis' }); // a short explanation
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
  // The key for a Claude call: the page keeps it (in localStorage) and sends it with each request; without
  // one, ask() falls back to .env.
  const keyFor = (req) => req.headers['x-api-key'] || undefined;
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
      if (req.method === 'GET' && req.url === '/status') {
        return json(res, 200, { supercollider: !!sc, paths: SCLANG_PATHS });
      }
      if (req.method === 'POST' && req.url === '/recheck') { // the setup screen's "Check again"
        if (!sc) { const path = await findSclang(); if (path) launchSclang(path); }
        return json(res, 200, { supercollider: !!sc });
      }
      if (req.method === 'POST' && req.url === '/generate') {
        const { prompt, code, history, model, effort, kind } = await readBody(req);
        return json(res, 200, await generate(prompt, code, history, keyFor(req), { model, effort, kind }));
      }
      if (req.method === 'POST' && req.url === '/analyze') {
        return json(res, 200, await analyze(keyFor(req), await readBody(req)));
      }
      if (req.method === 'POST' && req.url === '/gear') {
        return json(res, 200, await gear(keyFor(req), await readBody(req)));
      }
      if (req.method === 'GET' && req.url === '/key') { // whether .env has a key, for the ⚙ and Connect screens
        return json(res, 200, { env: !!envKey() });
      }
      if (req.method === 'POST' && req.url === '/key') { // { key }: checks a key before the page keeps it
        const { key } = await readBody(req);
        const result = await checkKey(key);
        return json(res, 200, { ...result, hint: result.ok ? keyHint(key.trim()) : null });
      }
      if (req.method === 'GET' && req.url === '/usage') { // the 🧾 usage history
        let text = '';
        try { text = await readFile(usageFile, 'utf8'); } catch {}
        const entries = text.split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
        return json(res, 200, { entries, file: usageFile });
      }
      if (req.method === 'POST' && req.url === '/run') {
        const { code, keep } = await readBody(req);
        await runCode(code, keep);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/part') { // the parts strip's toggle
        const { key, on } = await readBody(req);
        if (typeof key !== 'string' || !PART_KEY.test(key)) return json(res, 400, { error: 'bad part' });
        scEval(`~partsSet.value('${key}', ${on ? 'true' : 'false'});`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/parts-all') { // Mute all / Unmute all: { on }
        const { on } = await readBody(req);
        scEval(`~partsSetAll.value(${on ? 'true' : 'false'});`);
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
      if (req.method === 'POST' && req.url === '/record') { // the Record button: { on }
        const { on } = await readBody(req);
        recordOn(!!on);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/take-mp3') { // { id }: make the take's MP3, for download
        const { id } = await readBody(req);
        if (typeof id !== 'string' || !/^\d{10,16}$/.test(id)) return json(res, 400, { error: 'bad recording id' });
        try { await makeMp3(id); } catch (e) {
          return json(res, e.code === 'ENOENT' ? 404 : 500, { error: e.code === 'ENOENT' ? 'that recording is gone' : e.message });
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/share') { // { code, title, takeId, parts, audio }
        return json(res, 200, await shareSketch(await readBody(req)));
      }
      if (req.method === 'POST' && req.url === '/unshare') { // { id, token } from the share
        return json(res, 200, await unshareSketch(await readBody(req)));
      }
      if (req.method === 'POST' && req.url === '/fade') { // { seconds } starts a fade out, { cancel: true } ends it
        const { seconds, cancel } = await readBody(req);
        if (cancel) { scEval('~fadeCancel.value;'); return json(res, 200, { ok: true }); }
        if (typeof seconds !== 'number' || !(seconds >= 0.5 && seconds <= 300)) return json(res, 400, { error: 'fade length must be 0.5 to 300 seconds' });
        scEval(`~fadeOut.value(${seconds});`);
        return json(res, 200, { ok: true });
      }
      const take = req.method === 'GET' && req.url.match(/^\/take\/(\d{10,16})\.(wav|mp3|mid)$/);
      if (take) {
        try { return await sendTake(res, take[1], take[2]); } catch (e) {
          return json(res, e.code === 'ENOENT' ? 404 : 500, { error: e.code === 'ENOENT' ? 'no such recording' : e.message });
        }
      }
      if (req.method === 'POST' && req.url === '/stop') {
        scEval('CmdPeriod.run;');
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message, code: e.code });
    }
  });

  new WebSocketServer({ server, verifyClient: ({ req }) => trusted(req) }).on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'audio', data: audio }));
    ws.send(JSON.stringify({ type: 'devices', data: devices }));
    ws.send(JSON.stringify({ type: 'parts', data: parts }));
    ws.send(JSON.stringify({ type: 'record', data: rec }));
    ws.send(JSON.stringify({ type: 'fade', data: fade }));
    ws.on('close', () => clients.delete(ws));
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
  // Ping every 15 s: keeps idle sockets from being dropped, and clears out ones that died silently.
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 15000);
  heartbeat.unref();

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    recordUsage = null;
    if (sc) try { process.kill(-sc.pid); } catch {} // the whole group: sh, cat, sclang and its scsynth
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
