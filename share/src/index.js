// AnInstrument's share service: the app posts the code in the editor plus the last recorded take,
// and this serves a permalink page anyone can open. One Worker, one R2 bucket, no database.
//
//   POST   /api/share        multipart: code, title?, audio?, seconds?, parts?, notes?, app?
//                            -> { id, url, token, expiresAt }
//   DELETE /api/share/:id    with the token from the POST -> 204
//   GET    /s/:id            the share page
//   GET    /s/:id.scd        the code, wrapped so it runs in SuperCollider on its own
//   GET    /a/:id.mp3        the audio, with Range support so the player can seek
//
// R2 layout: s/<id>.json holds the metadata and the code, s/<id>.mp3 holds the audio. Both are
// written under the same random id, which is the only thing standing between a share and the
// public: there is no listing endpoint, and the pages ask not to be indexed.
//
// Uploads are open to any copy of the app, so everything the app sends is treated as hostile:
// sizes are capped before the body is read, the audio must actually look like an MP3, it is always
// served back as audio/mpeg whatever was uploaded, and the page escapes every interpolation and
// runs under a CSP that only allows its own nonced script.

const MAX_CODE = 256 * 1024; //   256 KB of sclang is far more than any sketch
const MAX_AUDIO = 20 * 1024 * 1024; // 20 MB, about 8 minutes of the app's 320 kbps MP3
const MAX_BODY = MAX_AUDIO + MAX_CODE + 64 * 1024; // plus multipart overhead
const MAX_TITLE = 120;
const TTL_DAYS = 90;

const SITE = 'https://jonowar.github.io/instrument/';
const DOWNLOAD = 'https://github.com/jonowar/instrument/releases/latest/download/AnInstrument-arm64.dmg';
const OG_IMAGE = 'https://jonowar.github.io/instrument/og.png';

// No l/o/0/1, so an id read off a screen can't be mistyped. 12 chars of 32 is 60 bits.
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(12))].map((b) => ID_ALPHABET[b & 31]).join('');

const metaKey = (id) => `s/${id}.json`;
const audioKey = (id) => `s/${id}.mp3`;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Control characters would end up in HTML attributes and HTTP headers; strip them everywhere.
const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

// ID3 tag or an MPEG frame sync. Not proof it decodes, but it stops the endpoint being general
// purpose file hosting for anything that sets the right content type.
function looksLikeMp3(bytes) {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

// A file name for the .scd download, from the share's title.
const scdName = (title, id) => {
  const base = clean(title, 48).replace(/[^\w -]+/g, '').replace(/\s+/g, '-').toLowerCase().replace(/^-+|-+$/g, '');
  return `${base || 'aninstrument'}-${id}.scd`;
};

// --- the share page -------------------------------------------------------
// Rendered here rather than fetched as JSON by a static page, so a link preview crawler (which
// runs no JavaScript) still sees the title, and the page works with scripting turned off.
function page(meta, id, url, nonce) {
  const title = meta.title || 'An AnInstrument sketch';
  const when = new Date(meta.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const facts = [when];
  if (meta.audio && meta.seconds > 0) facts.push(mmss(meta.seconds));
  if (meta.parts?.length) facts.push(`${meta.parts.length} part${meta.parts.length === 1 ? '' : 's'}`);
  if (meta.notes > 0) facts.push(`${meta.notes} note${meta.notes === 1 ? '' : 's'}`);

  const lines = meta.code.split('\n');
  const nums = lines.map((_, i) => i + 1).join('\n');
  const desc = `${meta.audio && meta.seconds > 0 ? mmss(meta.seconds) + ' of SuperCollider' : 'SuperCollider code'}`
    + ` made with AnInstrument${meta.parts?.length ? `: ${meta.parts.slice(0, 6).join(', ')}` : ''}.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AnInstrument</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex, nofollow">
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="AnInstrument">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
${meta.audio ? `<meta property="og:audio" content="${esc(new URL(`/a/${id}.mp3`, url).href)}">
<meta property="og:audio:type" content="audio/mpeg">` : ''}
<link rel="icon" href="https://jonowar.github.io/instrument/icon.png">
<style>
  :root { --bg:#0c0f10; --fg:#e8f3f1; --dim:#93a8a5; --accent:#7fd; --panel:#141c1d; --line:#23393b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
  .glow { position:fixed; inset:-40vh auto auto -30vw; width:90vw; height:90vw; pointer-events:none;
          background:radial-gradient(circle, #7fd1 0%, #7fd0 60%); }
  main { position:relative; max-width:860px; margin:0 auto; padding:40px 16px 56px; }
  a { color:var(--accent); }
  .brand { display:flex; gap:10px; align-items:center; text-decoration:none; color:var(--dim); font-size:14px; }
  .brand img { width:28px; height:28px; }
  h1 { font-size:clamp(26px, 4.5vw, 36px); letter-spacing:-.015em; margin:22px 0 6px; line-height:1.15; }
  .facts { color:var(--dim); font-size:14px; margin:0 0 22px; }
  audio { width:100%; margin:0 0 6px; }
  .noaudio { color:var(--dim); font-size:14px; background:var(--panel); border:1px solid var(--line);
             border-radius:8px; padding:12px 14px; margin-bottom:18px; }
  .parts { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 24px; }
  .part { font-size:12px; padding:2px 10px; border-radius:11px; background:#13282a; color:var(--accent);
          border:1px solid var(--line); }
  .part .k { opacity:.55; margin-right:3px; font-size:10px; }
  .codeWrap { background:#0d1415; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .code { display:flex; max-height:60vh; overflow:auto; }
  pre { margin:0; font:13px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .nums { padding:14px 10px 14px 14px; color:#3b5355; text-align:right; user-select:none;
          border-right:1px solid var(--line); font-variant-numeric:tabular-nums; flex:none; }
  .src { padding:14px 16px; color:#cde8e4; white-space:pre; flex:1; }
  .bar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:14px 0 0; }
  button, .btn { background:var(--panel); color:var(--fg); border:1px solid #2f4446; border-radius:7px;
                 padding:8px 14px; font:inherit; font-size:14px; cursor:pointer; text-decoration:none; }
  button:hover, .btn:hover { border-color:var(--accent); }
  footer { margin-top:40px; padding-top:22px; border-top:1px solid var(--line); color:var(--dim); font-size:14px; }
  footer .cta { display:inline-block; background:var(--accent); color:#06201c; font-weight:650;
                text-decoration:none; padding:10px 18px; border-radius:8px; margin-top:10px; }
  .expires { color:var(--dim); font-size:12px; margin-top:16px; }
</style>
</head>
<body>
<div class="glow"></div>
<main>
  <a class="brand" href="${SITE}"><img src="https://jonowar.github.io/instrument/icon.png" alt="">AnInstrument</a>
  <h1>${esc(title)}</h1>
  <p class="facts">${esc(facts.join(' · '))}</p>
  ${meta.audio
    ? `<audio controls preload="metadata" src="/a/${esc(id)}.mp3"></audio>`
    : '<div class="noaudio">No audio in this share: just the code.</div>'}
  ${meta.parts?.length
    ? `<div class="parts">${meta.parts
        .map((p) => `<span class="part"><span class="k">${p.startsWith('ndef:') ? 'N' : 'P'}</span>${esc(p.replace(/^[pn]def:/, ''))}</span>`)
        .join('')}</div>`
    : ''}
  <div class="codeWrap">
    <div class="code"><pre class="nums" aria-hidden="true">${esc(nums)}</pre><pre class="src" id="src">${esc(meta.code)}</pre></div>
  </div>
  <div class="bar">
    <button id="copy">Copy code</button>
    <a class="btn" href="/s/${esc(id)}.scd">Download .scd</a>
  </div>
  <p class="expires">This link expires on ${esc(new Date(meta.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}.</p>
  <footer>
    Made with <a href="${SITE}">AnInstrument</a>: describe a sound, Claude writes the SuperCollider, you play it live.
    <br><a class="cta" href="${DOWNLOAD}">Download for Mac</a>
  </footer>
</main>
<script nonce="${nonce}">
document.getElementById('copy').onclick = async (e) => {
  const b = e.currentTarget;
  try { await navigator.clipboard.writeText(document.getElementById('src').textContent); b.textContent = 'Copied'; }
  catch { b.textContent = 'Copy failed'; }
  setTimeout(() => { b.textContent = 'Copy code'; }, 1500);
};
</script>
</body>
</html>`;
}

// --- reading a share ------------------------------------------------------
async function readMeta(env, id) {
  const obj = await env.SHARES.get(metaKey(id));
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

const gone = () =>
  text('This share has expired. Shares are kept for ' + TTL_DAYS + ' days.', 410, { 'cache-control': 'no-store' });

// --- serving the audio ----------------------------------------------------
// workers.dev responses don't go through Cloudflare's cache, so Range has to be handled here or
// the player can't seek. On a custom domain the cache would serve ranges from a full 200 instead.
async function serveAudio(env, request, id) {
  const object = await env.SHARES.get(audioKey(id), { range: request.headers, onlyIf: request.headers });
  if (!object) return text('No audio for that share.', 404, { 'cache-control': 'no-store' });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-type', 'audio/mpeg'); // never the uploaded content type
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-disposition', `inline; filename="aninstrument-${id}.mp3"`);
  headers.set('accept-ranges', 'bytes');
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable'); // the id never points elsewhere

  // No body means a precondition failed: a matching If-None-Match is a 304, anything else a 412.
  if (!('body' in object)) {
    return new Response(null, { status: request.headers.has('if-none-match') ? 304 : 412, headers });
  }

  const r = object.range;
  if (request.headers.has('range') && r) {
    // R2 hands back whichever of offset/length/suffix it resolved, and the keys it didn't use may
    // be present but undefined, so go by value rather than by `in`.
    const size = object.size;
    let start;
    let length;
    if (typeof r.offset === 'number') {
      start = r.offset;
      length = typeof r.length === 'number' ? r.length : size - start;
    } else if (typeof r.suffix === 'number') {
      length = Math.min(r.suffix, size);
      start = size - length;
    } else {
      start = 0;
      length = typeof r.length === 'number' ? r.length : size;
    }
    length = Math.max(0, Math.min(length, size - start));
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(object.body, { headers });
}

// --- creating a share -----------------------------------------------------
async function createShare(env, request, url) {
  // multipart/form-data needs no CORS preflight, so a cross-origin page could post here without
  // the user knowing. A custom header can't be set cross-origin without a preflight we never
  // grant, and the app (which posts from Node, with no Origin) sends it.
  if (request.headers.get('x-aninstrument') !== '1') return json({ error: 'forbidden' }, 403);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'forbidden' }, 403);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.SHARE_LIMIT.limit({ key: `share:${ip}` });
  if (!success) return json({ error: 'Too many shares from here just now. Wait a minute and try again.' }, 429);

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return json({ error: 'That share is too big.' }, 413);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'expected multipart/form-data' }, 400);
  }

  const code = String(form.get('code') ?? '');
  if (!code.trim()) return json({ error: 'nothing to share: the code is empty' }, 400);
  if (code.length > MAX_CODE) return json({ error: 'That code is too long to share.' }, 413);

  const title = clean(form.get('title'), MAX_TITLE);
  const seconds = Math.max(0, Math.min(86400, Number(form.get('seconds')) || 0));
  const notes = Math.max(0, Math.min(1e6, Number(form.get('notes')) || 0));
  const app = clean(form.get('app'), 24);
  const parts = clean(form.get('parts'), 400)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^(pdef|ndef):[A-Za-z_][A-Za-z0-9_]*$/.test(p))
    .slice(0, 16);

  const audio = form.get('audio');
  let audioBytes = null;
  if (audio && typeof audio === 'object' && typeof audio.arrayBuffer === 'function') {
    if (audio.size > MAX_AUDIO) {
      return json({ error: `That take is ${(audio.size / 1e6).toFixed(1)} MB; shares are capped at ${MAX_AUDIO / 1e6} MB. Try a shorter take.` }, 413);
    }
    if (audio.size > 0) {
      audioBytes = new Uint8Array(await audio.arrayBuffer());
      if (!looksLikeMp3(audioBytes)) return json({ error: 'the audio must be an MP3' }, 415);
    }
  }

  const id = newId();
  const token = hex(crypto.getRandomValues(new Uint8Array(24)));
  const at = Date.now();
  const meta = {
    v: 1,
    title,
    code,
    at,
    seconds,
    notes,
    parts,
    app,
    audio: !!audioBytes,
    expiresAt: at + TTL_DAYS * 86400_000,
    tokenHash: await sha256(token),
  };

  if (audioBytes) {
    await env.SHARES.put(audioKey(id), audioBytes, {
      httpMetadata: { contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000, immutable' },
    });
  }
  // The metadata goes last: until it exists there is no share, so a failed audio write can't
  // leave a page that plays nothing.
  await env.SHARES.put(metaKey(id), JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  });

  return json({ id, url: new URL(`/s/${id}`, url).href, token, expiresAt: meta.expiresAt }, 201);
}

async function deleteShare(env, request, id) {
  const meta = await readMeta(env, id);
  if (!meta) return json({ error: 'no such share' }, 404);
  const token = request.headers.get('x-share-token') || '';
  if (!token || (await sha256(token)) !== meta.tokenHash) return json({ error: 'wrong token' }, 403);
  await Promise.all([env.SHARES.delete(metaKey(id)), env.SHARES.delete(audioKey(id))]);
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/robots.txt') {
      return text('User-agent: *\nDisallow: /\n', 200, { 'cache-control': 'public, max-age=86400' });
    }
    if (path === '/' || path === '/index.html') return Response.redirect(SITE, 302);

    if (path === '/api/share') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
      return createShare(env, request, url);
    }

    const api = path.match(/^\/api\/share\/([a-z0-9]{12})$/);
    if (api) {
      if (request.method !== 'DELETE') return json({ error: 'method not allowed' }, 405, { allow: 'DELETE' });
      return deleteShare(env, request, api[1]);
    }

    const media = path.match(/^\/a\/([a-z0-9]{12})\.mp3$/);
    if (media && (request.method === 'GET' || request.method === 'HEAD')) {
      const meta = await readMeta(env, media[1]);
      if (!meta) return text('No such share.', 404, { 'cache-control': 'no-store' });
      if (Date.now() > meta.expiresAt) return gone();
      return serveAudio(env, request, media[1]);
    }

    const scd = path.match(/^\/s\/([a-z0-9]{12})\.scd$/);
    if (scd && (request.method === 'GET' || request.method === 'HEAD')) {
      const meta = await readMeta(env, scd[1]);
      if (!meta) return text('No such share.', 404, { 'cache-control': 'no-store' });
      if (Date.now() > meta.expiresAt) return gone();
      // Wrapped exactly as the app's own Export .scd does, so it runs in SuperCollider by itself
      // and the app's Import .scd takes the wrapper back off.
      const head = `// Exported from AnInstrument${meta.title ? `: "${meta.title.replace(/[\r\n]+/g, ' ')}"` : ''}.
// In SuperCollider: click inside the outer brackets and press Cmd-Return. Cmd-. stops it.`;
      return new Response(`${head}\n(\ns.waitForBoot {\n${meta.code}\n};\n)\n`, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="${scdName(meta.title, scd[1])}"`,
          'cache-control': 'public, max-age=300',
        },
      });
    }

    const share = path.match(/^\/s\/([a-z0-9]{12})$/);
    if (share && (request.method === 'GET' || request.method === 'HEAD')) {
      const id = share[1];
      const meta = await readMeta(env, id);
      if (!meta) {
        return new Response(notFoundPage(), {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (Date.now() > meta.expiresAt) return gone();
      const nonce = hex(crypto.getRandomValues(new Uint8Array(12)));
      return new Response(page(meta, id, url.href, nonce), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Only our own nonced script runs, and nothing can be loaded from anywhere but the
          // places the page actually uses.
          'content-security-policy': [
            "default-src 'none'",
            "img-src https://jonowar.github.io",
            "media-src 'self'",
            "style-src 'unsafe-inline'",
            `script-src 'nonce-${nonce}'`,
            "connect-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          // Short, so an Unshare takes effect quickly while a hot link still gets a cached page.
          'cache-control': 'public, max-age=60',
        },
      });
    }

    return text('Not found.', 404, { 'cache-control': 'no-store' });
  },
};

function notFoundPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Share not found · AnInstrument</title><meta name="robots" content="noindex, nofollow">
<style>body{margin:0;background:#0c0f10;color:#e8f3f1;font:16px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;
display:grid;place-items:center;height:100vh;text-align:center;padding:24px}a{color:#7fd}</style></head>
<body><div><h1>No such share</h1>
<p>This link is wrong, or the share was removed by whoever made it.</p>
<p><a href="${SITE}">AnInstrument</a></p></div></body></html>`;
}
