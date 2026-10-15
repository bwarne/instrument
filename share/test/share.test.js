// Tests the share Worker over HTTP against a local `npm run dev`, which uses local R2 and needs no
// Cloudflare account:
//
//   npm run dev     # one terminal
//   npm test        # another
//
// These are local only. Uploads are rate limited per IP, and each case needs its own IP to stay
// independent, which only works locally: Cloudflare refuses a request whose client set
// cf-connecting-ip with its own 403 (error 1000). That is exactly why the Worker can trust the
// header for rate limiting. Use `npm run smoke` against a deployment instead.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.SHARE_TEST_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

// Rate limit counters live for a whole minute, so a fixed set of addresses would make a second
// run inside that window fail. Two random octets per run keep the runs apart, the sequence keeps
// the cases within a run apart.
const RUN = crypto.getRandomValues(new Uint8Array(2));
let seq = 0;
const nextIp = () => `10.${RUN[0]}.${RUN[1]}.${++seq & 255}`;

// A real chain of MPEG1 Layer III frames: 128 kbps, 44.1 kHz, so each frame is 417 bytes
// (floor(1152/8 * 128000 / 44100) = 417) and 1152/44100 seconds long. The Worker walks this chain,
// so a lone header followed by filler is not enough.
const FRAME_BYTES = 417;
const FRAME_SECONDS = 1152 / 44100;
function realMp3(frames = 40) {
  const b = new Uint8Array(frames * FRAME_BYTES);
  for (let f = 0; f < frames; f++) {
    const o = f * FRAME_BYTES;
    b[o] = 0xff;     // sync
    b[o + 1] = 0xfb; // MPEG1, Layer III, no CRC
    b[o + 2] = 0x90; // 128 kbps, 44.1 kHz, no padding
    b[o + 3] = 0xc0; // stereo
    for (let i = 4; i < FRAME_BYTES; i++) b[o + i] = (o + i * 7) & 0xff;
  }
  return b;
}
// What the old two-byte sniff would have accepted: one header, then anything at all.
const fakeMp3 = (size = 64) => {
  const b = new Uint8Array(size);
  b[0] = 0xff;
  b[1] = 0xfb;
  b[2] = 0x90;
  for (let i = 3; i < size; i++) b[i] = i & 0xff;
  return b;
};

async function share({ audio, ip = nextIp(), appHeader = '1', ...fields } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (audio) form.append('audio', new Blob([audio], { type: 'audio/mpeg' }), 'take.mp3');
  const headers = { 'cf-connecting-ip': ip };
  if (appHeader !== null) headers['x-aninstrument'] = appHeader;
  return fetch(`${BASE}/api/share`, { method: 'POST', headers, body: form });
}

before(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE)) {
    throw new Error(`${BASE} is not local. These tests give each case its own cf-connecting-ip, which `
      + 'Cloudflare refuses at the edge, and the upload rate limit would cover the whole run. '
      + 'Use "npm run smoke" for a deployment.');
  }
  try {
    await fetch(`${BASE}/robots.txt`);
  } catch (e) {
    throw new Error(`can't reach ${BASE} (start it with "npm run dev"): ${e.message}`);
  }
});

test('refuses a post that does not come from the app', async () => {
  const res = await share({ code: '// x', appHeader: null });
  assert.equal(res.status, 403);
});

test('refuses an empty share', async () => {
  const res = await share({ code: '   ' });
  assert.equal(res.status, 400);
});

test('refuses audio that is not an MP3', async () => {
  const res = await share({ code: '// x', audio: new TextEncoder().encode('this is not audio at all') });
  assert.equal(res.status, 415);
});

test('refuses a payload wearing an MP3 header', async () => {
  // 0xFFFB and then 2 MB of anything: what a two-byte sniff would have waved through
  const res = await share({ code: '// x', audio: fakeMp3(2 * 1024 * 1024) });
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /has to be an MP3/);
});

test('refuses an MP3 with a payload stapled to the end', async () => {
  const real = realMp3(40);
  const padded = new Uint8Array(real.length + 64 * 1024);
  padded.set(real, 0);
  padded.fill(0x41, real.length);
  const res = await share({ code: '// x', audio: padded });
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /and nothing else/);
});

test('refuses too few frames to be a recording', async () => {
  const res = await share({ code: '// x', audio: realMp3(3) });
  assert.equal(res.status, 415);
});

test('takes the duration from the audio, not from the request', async () => {
  const frames = 40;
  const expected = Math.round(frames * FRAME_SECONDS); // 1 second
  // the request claims 1:42; the frames say otherwise
  const res = await share({ code: '// timing', title: 'claimed length', seconds: 102, audio: realMp3(frames) });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const html = await (await fetch(`${BASE}/s/${id}`)).text();
  assert.ok(html.includes(`0:0${expected}`), `shows the real ${expected}s, not the claimed 1:42`);
  assert.ok(!html.includes('1:42'), 'the claimed duration is ignored');
});

// A multipart body built by hand and sent as an async iterable, so there is no content-length for
// the Worker to check: the cap has to come from the bytes that actually arrive.
async function* streamedUpload(boundary, megabytes) {
  const enc = new TextEncoder();
  yield enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="t.mp3"\r\n` +
      'Content-Type: audio/mpeg\r\n\r\n',
  );
  const chunk = new Uint8Array(1024 * 1024).fill(0x41);
  for (let i = 0; i < megabytes; i++) yield chunk;
  yield enc.encode(`\r\n--${boundary}--\r\n`);
}

test('refuses a text field sent as a file', async () => {
  const form = new FormData();
  form.append('code', new Blob(['// sneaky'], { type: 'text/plain' }), 'code.txt');
  const res = await fetch(`${BASE}/api/share`, {
    method: 'POST',
    headers: { 'x-aninstrument': '1', 'cf-connecting-ip': nextIp() },
    body: form,
  });
  assert.equal(res.status, 400);
});

test('refuses audio sent as a text field', async () => {
  const form = new FormData();
  form.append('code', '// x');
  form.append('audio', 'not a file');
  const res = await fetch(`${BASE}/api/share`, {
    method: 'POST',
    headers: { 'x-aninstrument': '1', 'cf-connecting-ip': nextIp() },
    body: form,
  });
  assert.equal(res.status, 400);
});

test('caps a streamed body that never declares a length', async () => {
  const boundary = '----aninstrumenttest';
  let status = null;
  let threw = null;
  try {
    const res = await fetch(`${BASE}/api/share`, {
      method: 'POST',
      duplex: 'half',
      body: streamedUpload(boundary, 25), // over the ~20.9 MB cap
      headers: {
        'x-aninstrument': '1',
        'cf-connecting-ip': nextIp(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
    status = res.status;
    await res.text().catch(() => '');
  } catch (e) {
    threw = e; // the Worker stops reading, so the connection may be cut before the response lands
  }
  assert.ok(status !== 201, `the upload must not succeed (status ${status}, threw ${threw?.message ?? 'no'})`);
  if (status !== null) assert.equal(status, 413);
});

test('strips invisible and direction-flipping characters from a title', async () => {
  // a bidi override makes a title read backwards; zero-width spaces pad it invisibly
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);
  const SOFT_HYPHEN = String.fromCharCode(0x00ad);
  const title = `quiet${RLO}pad${ZWSP.repeat(3)}  p${SOFT_HYPHEN}ad`;
  const res = await share({ code: '// x', title });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const html = await (await fetch(`${BASE}/s/${id}`)).text();
  for (const [name, ch] of [['RLO', RLO], ['ZWSP', ZWSP], ['soft hyphen', SOFT_HYPHEN]]) {
    assert.ok(!html.includes(ch), `${name} does not survive`);
  }
  assert.ok(html.includes('quiet pad p ad'), 'what is left is readable and collapsed');
});


test('tells the reader the code is not theirs', async () => {
  const res = await share({ code: 'unixCmd("echo hi");' });
  const { id } = await res.json();
  const html = await (await fetch(`${BASE}/s/${id}`)).text();
  assert.match(html, /Read it before you run it/);
});

test('refuses code over the size cap', async () => {
  const res = await share({ code: 'x'.repeat(256 * 1024 + 1) });
  assert.equal(res.status, 413);
});

test('shares code on its own', async () => {
  const code = 'Pdef(\\kick, Pbind(\\degree, 0)).play;';
  const res = await share({ code, title: 'code only', parts: 'pdef:kick' });
  assert.equal(res.status, 201);
  const { id, url, token } = await res.json();
  assert.match(id, /^[a-z0-9]{12}$/);
  assert.ok(url.endsWith(`/s/${id}`));
  assert.match(token, /^[0-9a-f]{48}$/);

  const pageRes = await fetch(`${BASE}/s/${id}`);
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.ok(html.includes('code only'), 'shows the title');
  assert.ok(html.includes('Pdef(\\kick'), 'shows the code');
  assert.ok(!html.includes('<audio'), 'no player when there is no audio');
  assert.ok(html.includes('No audio in this share'));
  assert.ok(html.includes('kick'), 'shows the part');
  assert.match(pageRes.headers.get('content-security-policy'), /script-src 'nonce-[0-9a-f]+'/);
  assert.match(pageRes.headers.get('x-content-type-options'), /nosniff/);

  // the .scd download runs in SuperCollider on its own
  const scd = await fetch(`${BASE}/s/${id}.scd`);
  assert.equal(scd.status, 200);
  const scdText = await scd.text();
  assert.ok(scdText.includes('s.waitForBoot {'), 'wrapped for standalone use');
  assert.ok(scdText.includes(code));
  assert.match(scd.headers.get('content-disposition'), /attachment; filename="code-only-[a-z0-9]{12}\.scd"/);

  // no audio was uploaded, so there is nothing to play
  assert.equal((await fetch(`${BASE}/a/${id}.mp3`)).status, 404);
});

test('shares code with a take, and serves byte ranges so the player can seek', async () => {
  const bytes = realMp3(40);
  const size = bytes.length; // 40 frames of 417 bytes
  const res = await share({ code: '// with audio', title: 'a take', seconds: '102', notes: '48', audio: bytes });
  assert.equal(res.status, 201);
  const { id } = await res.json();

  const html = await (await fetch(`${BASE}/s/${id}`)).text();
  assert.ok(html.includes(`<audio id="au" preload="metadata" src="/a/${id}.mp3">`), 'has a player');
  assert.ok(html.includes('id="seek"') && html.includes('id="pp"'), 'with seek and play controls');
  assert.ok(html.includes('0:01'), 'shows the duration measured from the frames, not the claimed 1:42');
  assert.ok(html.includes('48 notes'));

  const full = await fetch(`${BASE}/a/${id}.mp3`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), String(size));
  assert.equal(new Uint8Array(await full.arrayBuffer())[0], 0xff);

  const ranged = await fetch(`${BASE}/a/${id}.mp3`, { headers: { range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 10-19/${size}`);
  const slice = new Uint8Array(await ranged.arrayBuffer());
  assert.equal(slice.length, 10);
  assert.deepEqual([...slice], [...bytes.slice(10, 20)]);

  // open-ended and suffix ranges, which players use when scrubbing
  const toEnd = await fetch(`${BASE}/a/${id}.mp3`, { headers: { range: `bytes=${size - 4}-` } });
  assert.equal(toEnd.status, 206);
  assert.equal(toEnd.headers.get('content-range'), `bytes ${size - 4}-${size - 1}/${size}`);

  const tail = await fetch(`${BASE}/a/${id}.mp3`, { headers: { range: 'bytes=-8' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), `bytes ${size - 8}-${size - 1}/${size}`);
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...bytes.slice(size - 8)]);
});

test('escapes HTML in the code and the title', async () => {
  const nasty = '</pre><img src=x onerror="alert(1)">';
  const res = await share({ code: `// ${nasty}`, title: nasty });
  const { id } = await res.json();
  const html = await (await fetch(`${BASE}/s/${id}`)).text();
  assert.ok(!html.includes('<img src=x'), 'the tag is not live in the page');
  assert.ok(html.includes('&lt;img src=x'), 'it is shown as text');
  assert.ok(!html.includes('onerror="alert(1)"'));
});

test('unshares only with the right token', async () => {
  const res = await share({ code: '// temporary', audio: realMp3() });
  const { id, token } = await res.json();
  assert.equal((await fetch(`${BASE}/s/${id}`)).status, 200);

  const wrong = await fetch(`${BASE}/api/share/${id}`, {
    method: 'DELETE',
    headers: { 'x-share-token': 'f'.repeat(48) },
  });
  assert.equal(wrong.status, 403);
  assert.equal((await fetch(`${BASE}/s/${id}`)).status, 200, 'still there after a bad token');

  const right = await fetch(`${BASE}/api/share/${id}`, { method: 'DELETE', headers: { 'x-share-token': token } });
  assert.equal(right.status, 204);
  assert.equal((await fetch(`${BASE}/s/${id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/a/${id}.mp3`)).status, 404, 'the audio goes too');
});

test('rate limits one IP without affecting others', async () => {
  const ip = nextIp();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await share({ code: `// burst ${i}`, ip })).status);
  assert.deepEqual(codes.slice(0, 5), [201, 201, 201, 201, 201]);
  assert.equal(codes[5], 429, 'the sixth share from one IP is refused');
  assert.equal((await share({ code: '// someone else' })).status, 201);
});
