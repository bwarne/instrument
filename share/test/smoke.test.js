// A production-safe subset of the tests, for checking a real deployment:
//
//   npm run smoke
//   SHARE_TEST_URL=https://… npm run smoke
//
// It can't be the full suite. Cloudflare rejects a client-set cf-connecting-ip at the edge with its
// own 403 (error 1000), which is exactly why the Worker can trust that header for rate limiting, so
// these tests can't give each case its own IP. That means the 5-uploads-a-minute limit covers the
// whole run, so this does two uploads and deletes both. Run share.test.js locally for the rest.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.SHARE_TEST_URL || 'https://aninstrument.share.jono.solutions').replace(/\/$/, '');

// A real chain of MPEG1 Layer III frames: 128 kbps, 44.1 kHz, 417 bytes each. The Worker walks the
// chain, so a bare header with filler behind it is not an MP3 as far as it is concerned.
const FRAME_BYTES = 417;
function realMp3(frames = 40) {
  const b = new Uint8Array(frames * FRAME_BYTES);
  for (let f = 0; f < frames; f++) {
    const o = f * FRAME_BYTES;
    b[o] = 0xff;
    b[o + 1] = 0xfb;
    b[o + 2] = 0x90;
    b[o + 3] = 0xc0;
    for (let i = 4; i < FRAME_BYTES; i++) b[o + i] = (o + i * 7) & 0xff;
  }
  return b;
}
// One header, then anything: what a two-byte sniff would have accepted.
const fakeMp3 = (size = 2048) => {
  const b = new Uint8Array(size);
  b[0] = 0xff;
  b[1] = 0xfb;
  b[2] = 0x90;
  for (let i = 3; i < size; i++) b[i] = (i * 7) & 0xff;
  return b;
};

async function share({ audio, appHeader = '1', ...fields }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (audio) form.append('audio', new Blob([audio], { type: 'audio/mpeg' }), 'take.mp3');
  const headers = {};
  if (appHeader !== null) headers['x-aninstrument'] = appHeader;
  return fetch(`${BASE}/api/share`, { method: 'POST', headers, body: form });
}

const remove = (id, token) =>
  fetch(`${BASE}/api/share/${id}`, { method: 'DELETE', headers: { 'x-share-token': token } });

before(async () => {
  const res = await fetch(`${BASE}/robots.txt`).catch((e) => {
    throw new Error(`can't reach ${BASE}: ${e.message}`);
  });
  assert.equal(res.status, 200, `${BASE} does not look like the share service`);
  console.log(`# testing ${BASE}`);
});

// Refused before the rate limit is touched, so this costs nothing from the upload budget.
test('refuses a post that does not come from the app', async () => {
  const res = await share({ code: '// x', appHeader: null });
  assert.equal(res.status, 403);
});

// This one does count against the upload limit: the body is only inspected after limit() is
// called. Three uploads in this file, against a limit of five a minute.
test('refuses a payload wearing an MP3 header', async () => {
  const res = await share({ code: '// x', audio: fakeMp3(512 * 1024) });
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /has to be an MP3/);
});

test('publishes a share, serves it, and takes it down again', async () => {
  const bytes = realMp3(40);
  const code = 'Pdef(\\kick, Pbind(\\degree, 0, \\dur, 0.5)).play; // smoke test';
  const res = await share({ code, title: 'smoke test', seconds: 102, notes: 12, parts: 'pdef:kick', audio: bytes });
  // read the body once: a Response can only be consumed once, and an assert message is eager
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 201, JSON.stringify(body));
  const { id, url, token, expiresAt } = body;
  assert.equal(url, `${BASE}/s/${id}`);
  assert.ok(expiresAt > Date.now(), 'expires in the future');

  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('smoke test'), 'shows the title');
    assert.ok(html.includes('Pdef(\\kick'), 'shows the code');
    assert.ok(html.includes(`src="/a/${id}.mp3"`), 'has the player');
    assert.ok(html.includes('0:01'), 'shows the duration read from the frames');
    assert.ok(!html.includes('1:42'), 'not the 1:42 the request claimed');
    assert.match(html, /Read it before you run it/, 'warns that the code is someone else\'s');
    assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-[0-9a-f]+'/);
    assert.match(page.headers.get('cache-control'), /max-age=60/);

    const audio = await fetch(`${BASE}/a/${id}.mp3`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal(audio.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [...bytes], 'comes back byte for byte');

    const ranged = await fetch(`${BASE}/a/${id}.mp3`, { headers: { range: 'bytes=100-199' } });
    assert.equal(ranged.status, 206, 'serves byte ranges, so the player can seek');
    assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
    assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())], [...bytes.slice(100, 200)]);

    const scd = await fetch(`${BASE}/s/${id}.scd`);
    assert.equal(scd.status, 200);
    const scdText = await scd.text();
    assert.ok(scdText.includes('s.waitForBoot {') && scdText.includes(code), 'the .scd runs on its own');
    assert.match(scd.headers.get('content-disposition'), /attachment; filename="smoke-test-[a-z0-9]{12}\.scd"/);

    assert.equal((await remove(id, 'f'.repeat(48))).status, 403, 'a wrong token cannot delete it');
    assert.equal((await fetch(url)).status, 200, 'still there');
  } finally {
    assert.equal((await remove(id, token)).status, 204);
  }

  assert.equal((await fetch(url)).status, 404, 'the page is gone');
  assert.equal((await fetch(`${BASE}/a/${id}.mp3`)).status, 404, 'the audio is gone');
});

test('escapes HTML in what it is given', async () => {
  const nasty = '</pre><img src=x onerror="alert(1)">';
  const res = await share({ code: `// ${nasty}`, title: nasty });
  assert.equal(res.status, 201);
  const { id, url, token } = await res.json();
  try {
    const html = await (await fetch(url)).text();
    assert.ok(!html.includes('<img src=x'), 'the tag is not live');
    assert.ok(html.includes('&lt;img src=x'), 'it is shown as text');
  } finally {
    await remove(id, token);
  }
});

test('says no to a share id that does not exist', async () => {
  assert.equal((await fetch(`${BASE}/s/zzzzzzzzzzzz`)).status, 404);
  assert.equal((await fetch(`${BASE}/a/zzzzzzzzzzzz.mp3`)).status, 404);
});

test('asks not to be indexed', async () => {
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  assert.match(robots, /Disallow: \//);
});
