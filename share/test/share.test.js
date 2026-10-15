// Tests the share Worker over HTTP, so they run against either `npm run dev` (local R2, the
// default) or a deployed URL via SHARE_TEST_URL. Start the Worker first:
//
//   npm run dev                     # in one terminal
//   npm test                        # in another
//   SHARE_TEST_URL=https://… npm test
//
// Uploads are rate limited per IP. Cloudflare overwrites cf-connecting-ip at the edge, so a real
// client can't choose its own bucket, but in local dev these tests can, which keeps each case
// independent. One test deliberately exhausts a single IP's limit.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.SHARE_TEST_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

// Rate limit counters live for a whole minute, so a fixed set of addresses would make a second
// run inside that window fail. Two random octets per run keep the runs apart, the sequence keeps
// the cases within a run apart.
const RUN = crypto.getRandomValues(new Uint8Array(2));
let seq = 0;
const nextIp = () => `10.${RUN[0]}.${RUN[1]}.${++seq & 255}`;

// A plausible MPEG frame header followed by filler: enough for the Worker's sniff test.
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
  const bytes = fakeMp3(64);
  const res = await share({ code: '// with audio', title: 'a take', seconds: '102', notes: '48', audio: bytes });
  assert.equal(res.status, 201);
  const { id } = await res.json();

  const html = await (await fetch(`${BASE}/s/${id}`)).text();
  assert.ok(html.includes(`<audio controls preload="metadata" src="/a/${id}.mp3">`), 'has a player');
  assert.ok(html.includes('1:42'), 'shows the duration');
  assert.ok(html.includes('48 notes'));

  const full = await fetch(`${BASE}/a/${id}.mp3`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), '64');
  assert.equal(new Uint8Array(await full.arrayBuffer())[0], 0xff);

  const ranged = await fetch(`${BASE}/a/${id}.mp3`, { headers: { range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 10-19/64');
  const slice = new Uint8Array(await ranged.arrayBuffer());
  assert.equal(slice.length, 10);
  assert.deepEqual([...slice], [...bytes.slice(10, 20)]);

  // open-ended and suffix ranges, which players use when scrubbing
  const toEnd = await fetch(`${BASE}/a/${id}.mp3`, { headers: { range: 'bytes=60-' } });
  assert.equal(toEnd.status, 206);
  assert.equal(toEnd.headers.get('content-range'), 'bytes 60-63/64');

  const tail = await fetch(`${BASE}/a/${id}.mp3`, { headers: { range: 'bytes=-8' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), 'bytes 56-63/64');
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...bytes.slice(56)]);
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
  const res = await share({ code: '// temporary', audio: fakeMp3() });
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
