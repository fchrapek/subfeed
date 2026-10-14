# Subfeed

A distraction-free YouTube subscriptions reader. It merges the **public RSS upload feeds** of
the channels you add into one reverse-chronological list of unwatched videos, played through
the official embedded player. No recommendations, related videos, trending, end screens,
autoplay-next or Shorts. No Google account and no API key.

Single user, self-hosted. Install it on your phone's home screen and it behaves like an app.

## Features

- **New:** the newest unwatched videos from your channels, capped at a number you choose.
- **Hide Shorts** and a minimum video length.
- **Playlists:** Watch later, your own named lists (they play through in order), and History.
- **Daily budget:** stop after N videos or N minutes a day, with a deliberate "continue anyway".
- **Resume:** an accidentally closed video picks up where it stopped.
- **Works offline** for what was already loaded. Installable as a PWA on iOS and Android.

## Run it locally

Needs Node 24 or newer.

```bash
npm install
cp .env.example .env
npm run hash-password            # paste the printed line into .env
# in .env set SUBFEED_ORIGIN=http://localhost:5173
npm run dev                      # UI on :5173, API on :8787 (proxied)
```

Open http://localhost:5173, sign in, go to **Channels** and paste a channel URL, `@handle`
or channel ID (`UC…`).

## Self-host with Docker

You need a reverse proxy that terminates HTTPS (Caddy, Traefik, nginx and so on) and forwards to
port 8787.

```bash
docker build -t subfeed .
docker run --rm -it subfeed node scripts/hash-password.mjs   # prints SUBFEED_PASSWORD_HASH=...
cp .env.example .env    # paste the hash, set SUBFEED_ORIGIN to your https address
docker compose up -d
```

`compose.yaml` binds the app to `127.0.0.1:8787`, runs it read-only as an unprivileged user and
keeps the database in the `subfeed_data` volume (`db.sqlite` plus its `-wal` and `-shm` files;
back up with `sqlite3 db.sqlite ".backup copy.sqlite"`).

### Configuration

| Variable | Required | |
| --- | --- | --- |
| `SUBFEED_PASSWORD_HASH` | yes | Output of `npm run hash-password`. The password itself is never stored. |
| `SUBFEED_ORIGIN` | yes | The exact address you open Subfeed at, e.g. `https://subfeed.example.com`. Plain `http` only for localhost. |
| `SUBFEED_DB` | no | SQLite file path. Default `server/db.sqlite`, `/data/db.sqlite` in Docker. |
| `PORT` | no | Default `8787`. |

The server refuses to start if either required variable is missing or malformed.

## Security model

- **One password, no username.** Stored only as an scrypt hash. Signing in creates a random
  session token; the browser keeps it in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie
  (`__Host-` prefixed; on `http://localhost` it is a plain `subfeed-session` cookie without
  `Secure`) and the database keeps only its SHA-256.
- **Sessions** last 90 days from last use, at most a year, up to 20 devices. Settings has
  "Sign out" and "Sign out everywhere". Changing the password hash signs every device out.
- **Wrong passwords** are free five times, then each further attempt doubles a lockout, up to
  15 minutes. Only one password check runs at a time, and the lockout survives restarts.
- **API writes** must come from `SUBFEED_ORIGIN` and send `Content-Type: application/json`
  (a `DELETE` may send no body), which blocks cross-site requests. Request bodies are capped at
  16 KB and every field is validated. Signing out wipes the device's local copy.
- **Outbound requests** go to YouTube only (`youtube.com`, `www.` and `m.`, over https), with
  every redirect checked, a 10 second deadline for the whole request and a 5 MB cap. Pasted URLs
  on other hosts are refused. Channels are added one at a time, up to 500.
- **Headers:** a Content Security Policy that allows only this app plus the YouTube player and
  thumbnails, `frame-ancestors 'none'`, `nosniff`, HSTS on https.
- The built app (HTML, JS, icons, service worker) is public on purpose. It holds no data, and an
  installed app has to load and update itself before you sign in.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## How it works

- **Server** (`server/`, Hono on Node): resolves channels, fetches and parses each channel's
  Atom feed (`youtube.com/feeds/videos.xml?channel_id=…`), detects Shorts from the feed's
  `/shorts/` links, fills in durations from each channel's public video list, and owns the watched and budget
  rules. State lives in **SQLite** (`node:sqlite`).
- **Client** (`client/`, React PWA): every change goes through the API; the returned state is
  mirrored into IndexedDB (Dexie), so the UI is reactive and stays browsable offline.
- **Player:** the official `youtube-nocookie.com` embed via the IFrame API. A video counts as
  watched at 90% (configurable) or when marked; outside playlists nothing autoplays next.
  Every watch credits the creator with a real view.

Design notes live in [`docs/`](docs/); [`prd.md`](prd.md) and [`goal.md`](goal.md) are the
original product brief.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | UI and API with hot reload |
| `npm run build` | Build the PWA into `dist/client` |
| `npm start` | Serve the built app and the API |
| `npm test` | Parser, URL-guard and auth tests |
| `npm run typecheck` | Type-check client and server |
| `npm run hash-password` | Make a `SUBFEED_PASSWORD_HASH` |
| `scripts/make-icons.sh` | Rebuild the PNG app icons from `public/icon.svg` (ImageMagick) |

## Known limitations

- Durations are scraped from each channel's public video and live-stream lists (with the
  watch page as a fallback), the most fragile part. Unknown durations are never hidden.
- Single user by design.
- Videos published over a year ago are dropped unless they are in Watch later or a playlist.

## License

[MIT](LICENSE)
