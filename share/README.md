# Share service

The Cloudflare Worker behind AnInstrument's **⤴ Share** button. The app posts the code in the
editor and, if there is one, the last recorded take; this stores them and serves a permalink that
plays the audio and shows the code.

It is deliberately small: one Worker, one R2 bucket, no database and no accounts. A share is two
objects under a random 12-character id.

```
app (server.js)  ──POST /api/share──▶  Worker  ──▶  R2: s/<id>.json  (metadata + code)
                                                    R2: s/<id>.mp3   (the take)
anyone           ──GET  /s/<id>─────▶  Worker  ──▶  the share page
```

## Endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/api/share` | multipart: `code`, and optionally `title`, `audio` (MP3), `notes`, `parts`, `app`. Returns `{ id, url, token, expiresAt }`. A `seconds` field is accepted and ignored: the duration is measured from the audio. |
| DELETE | `/api/share/:id` | Removes the share. Needs the `x-share-token` header with the token from the POST. |
| GET | `/s/:id` | The share page: player, code, copy and `.scd` download, link preview tags. |
| GET | `/s/:id.scd` | The code wrapped in `s.waitForBoot { … }`, so it runs in SuperCollider on its own. |
| GET | `/a/:id.mp3` | The audio, with `Range` support so the player can seek. |
| GET | `/robots.txt` | Disallows everything: shares are unlisted, not published. |

## Validation

Uploads are open to every copy of the app, so nothing that arrives is trusted.

**Size.** 256 KB of code and 20 MB of audio. The body is capped by the bytes that actually arrive,
not by `content-length`: that header can be wrong, or absent on a chunked request, and
`formData()` would otherwise buffer whatever was sent. The stream is piped through a counter that
errors past the cap, so the request is refused mid-upload.

**Audio.** The MPEG frame chain is walked from the start: every frame header has to be valid and
has to point at the next one, at least 10 frames have to parse, and no more than 4 KB of the file
may be left unaccounted for (room for an ID3v1 tag). A two-byte sniff would have accepted 20 MB of
anything behind an `0xFFFB`, which would make this file hosting for arbitrary payloads. The
duration shown on the page is computed from those frames, so the `seconds` the client sends is
irrelevant. Audio is always served back as `audio/mpeg` with `nosniff`, whatever was uploaded.

**Text.** Every field is length capped, NFC normalised, and stripped of control characters and of
the invisible and bidi-override characters that let a title render as something other than what it
is. A field that should be text can't be a file, and `audio` can't be text. Part keys must match
`(pdef|ndef):name`.

**Rate.** 5 uploads a minute per IP (`SHARE_LIMIT`), plus `SHARE_FLOOD` as a backstop for one
source spread across many addresses. Note that rate limit counters are per Cloudflare location,
not global, so the backstop slows a distributed flood rather than stopping it.

`cf-connecting-ip` is safe to key on: Cloudflare rejects a request whose client tried to set it,
with its own 403 and error 1000. That is also why the full test suite can only run locally.

**Origin.** `x-aninstrument: 1` is required. `multipart/form-data` needs no CORS preflight, so
without it a page on another origin could post here in a visitor's name; a custom header can't be
set cross-origin without a preflight, which this Worker never grants.

**Output.** The page escapes every interpolation and runs under a CSP that allows only its own
nonced script. Shares expire after 90 days; reads return 410 after that, and the lifecycle rule
below deletes the objects.

### What this does not do

It does not prove a request came from the app. `x-aninstrument` ships in a public DMG, so anyone
who looks can replay it; it stops drive-by abuse from a web page, not a determined uploader. The
validation above bounds what can be stored and served, but an open endpoint is still an open
endpoint. See "If it gets abused" below.

An id is 60 bits of randomness and there is no listing endpoint, so a share is unlisted rather than
secret. Treat it like a "anyone with the link" share, and say so in the UI (the app does).

The share page also warns the reader that the code is someone else's and that SuperCollider can run
shell commands, because `.scd` downloads are the obvious social-engineering route here.

## Deploy

```sh
npm install
npx wrangler login          # once, opens a browser
npx wrangler r2 bucket create aninstrument-shares   # once, if it doesn't exist yet
npm run deploy
```

The live one is `https://aninstrument-share.peter-clark.workers.dev`, which is what `server.js`
uses by default. To point the app somewhere else, set this in `.env` at the repo root:

```
SHARE_URL=https://aninstrument-share.<your-subdomain>.workers.dev
```

`server.js` reads it once, when it is first imported, so `.env` has to be in place before the app
starts. For a local Worker use `SHARE_URL=http://127.0.0.1:8787` alongside `npm run dev`.

### Expiry

The 90-day cutoff is enforced on read, but the objects need a bucket lifecycle rule to actually go
away:

```sh
npx wrangler r2 bucket lifecycle add aninstrument-shares \
  --name expire-shares --prefix s/ --expire-days 90
```

Without it, reads still 410 on time and nothing is served, but storage grows.

## Test

```sh
npm run dev     # one terminal: local Worker, local R2, no Cloudflare account needed
npm test        # another: 18 tests
```

`npm test` is local only. Each case needs its own `cf-connecting-ip` to keep the per-IP rate limits
from bleeding between tests, and Cloudflare refuses a client-set one at the edge.

For a deployment:

```sh
npm run smoke                              # the live service
SHARE_TEST_URL=https://… npm run smoke     # somewhere else
```

The smoke tests stay inside the 5-uploads-a-minute budget and delete the shares they create. If you
run them twice in quick succession, the second run will hit the limit; wait a minute.

## If it gets abused

In order of how much friction they add:

1. Lower `SHARE_LIMIT` in `wrangler.jsonc`, or shorten the expiry.
2. Add [Turnstile](https://developers.cloudflare.com/turnstile/): the app is an Electron window, so
   it can show the widget in the Share dialog and send the token for the Worker to verify.
3. Put the Worker behind a shared upload secret and move sharing behind a sign-in.

Nothing here is moderated. If that becomes a problem, the Worker is the right place to add a
blocklist, since every read already goes through it.

## Cost

R2 storage is about $0.015/GB/month with no egress fee, and the Workers free tier covers 100,000
requests a day. A thousand two-minute shares is roughly 5 GB, so under ten cents a month. The
cheapest knob if that ever matters is the MP3 bitrate in `server.js` (`wavToMp3` writes 320 kbps,
which is generous for a link).
