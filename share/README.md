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
| POST | `/api/share` | multipart: `code`, and optionally `title`, `audio` (MP3), `seconds`, `notes`, `parts`, `app`. Returns `{ id, url, token, expiresAt }`. |
| DELETE | `/api/share/:id` | Removes the share. Needs the `x-share-token` header with the token from the POST. |
| GET | `/s/:id` | The share page: player, code, copy and `.scd` download, link preview tags. |
| GET | `/s/:id.scd` | The code wrapped in `s.waitForBoot { … }`, so it runs in SuperCollider on its own. |
| GET | `/a/:id.mp3` | The audio, with `Range` support so the player can seek. |
| GET | `/robots.txt` | Disallows everything: shares are unlisted, not published. |

## Limits

Uploads are open to every copy of the app, so the endpoint assumes bad input:

- 256 KB of code, 20 MB of audio (about 8 minutes of the app's 320 kbps MP3), checked against
  `content-length` before the body is read.
- The audio must start with an ID3 tag or an MPEG frame sync, and is always served back as
  `audio/mpeg` with `nosniff`, whatever was uploaded.
- 5 shares per minute per IP, via the `SHARE_LIMIT` rate limit binding. `cf-connecting-ip` is set
  by Cloudflare at the edge, so a client can't pick its own bucket.
- `x-aninstrument: 1` is required. `multipart/form-data` needs no CORS preflight, so without this a
  page on another origin could post here in a visitor's name; a custom header can't be set
  cross-origin without a preflight, which this Worker never grants.
- Shares expire after 90 days. Reads return 410 after that; see below for deleting the objects.
- The page escapes every interpolation and runs under a CSP that allows only its own nonced script.

An id is 60 bits of randomness and there is no listing endpoint, so a share is unlisted rather than
secret. Treat it like a Google Doc "anyone with the link" share, and say so in the UI (the app
does).

## Deploy

```sh
npm install
npx wrangler login          # once, opens a browser
npx wrangler r2 bucket create aninstrument-shares   # once, if it doesn't exist yet
npm run deploy
```

Then point the app at it, in `.env` at the repo root:

```
SHARE_URL=https://aninstrument-share.<your-subdomain>.workers.dev
```

`server.js` has the deployed URL as its default, so this is only needed for your own deployment.

### Expiry

The 90-day cutoff is enforced on read, but the objects need a bucket lifecycle rule to actually go
away:

```sh
npx wrangler r2 bucket lifecycle add aninstrument-shares \
  --name expire-shares --prefix s/ --expire-days 90
```

Without it, reads still 410 on time and nothing is served, but storage grows.

## Test

The tests run over HTTP against a local Worker with local R2, so they need no account:

```sh
npm run dev     # one terminal
npm test        # another
```

Point them at a deployment with `SHARE_TEST_URL=https://… npm test`. They create real shares, so
prefer the local server.

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
