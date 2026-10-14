# Feed Ingestion

All ingestion uses **public pages only** — no account, no API key, no quota.

## Per-channel feed
- URL: `https://www.youtube.com/feeds/videos.xml?channel_id=<CHANNEL_ID>`
- Returns Atom XML, ~15 most recent uploads. Parse each `<entry>`:
  - `yt:videoId` → video id
  - `title` → title
  - `author/name` → channel name
  - `published` → publish time (ISO 8601)
  - `media:group/media:thumbnail@url` → thumbnail (only `*.ytimg.com` is accepted)
  - `link[rel=alternate]@href` → **Shorts flag**: Shorts link to `/shorts/<id>`, other
    videos to `/watch?v=<id>`
- **The feed gives no duration** — see enrichment below.
- Dedup by `videoId`. Every video appears exactly once in the merged feed.

## Channel resolution
Accept any of: channel ID, channel URL, handle, custom/legacy URL.
1. **Channel ID** (`UC…`, 24 chars) → use directly to build the feed URL.
2. **`/channel/UC…` URL** → extract the ID from the path.
3. **`@handle`, `/c/<custom>`, `/user/<name>`** → server fetches the channel page HTML and
   extracts the canonical ID from one of: `"channelId":"UC…"`, `<meta itemprop="identifier">`,
   or the `<link rel="canonical" href=".../channel/UC…">` tag.
4. If extraction fails → return an error; the UI tells the user to paste the canonical
   channel ID (acceptable MVP fallback per `docs/scope.md`).

## Duration & Shorts (the brittle part — no Data API)
RSS provides neither, so enrich each new `videoId` once and cache the result:
- **Duration, first choice:** the channel's `/videos` page. Its `ytInitialData` lists the ~30
  newest long-form videos, each (`lockupViewModel`) with a length badge like `57:59` on the
  thumbnail. One request fills many videos, and it still answers datacenter IPs that YouTube
  asks to sign in. Fetched only for channels with recent videos of unknown length, at most
  once an hour per channel.
- **Duration, fallback:** the watch page's `lengthSeconds`, `approxDurationMs` or
  `<meta itemprop="duration">` (ISO 8601). From many datacenter IPs this page answers
  `LOGIN_REQUIRED` without a length.
- **Shorts:** the feed's link (above) is authoritative. Only when it's missing, request
  `https://www.youtube.com/shorts/<videoId>`: a Short returns 200, a normal video redirects
  to `/watch`. Any other redirect (consent or sign-in wall) proves nothing. Duration ≤ ~60s
  is a weak last resort.
- **EU consent wall:** from an EU IP, youtube.com first redirects to `consent.youtube.com`.
  Every request sends the cookie `SOCS=CAI` ("reject all"), which skips it.
- **Degrade gracefully:** if duration/Shorts can't be determined, treat duration as unknown
  and **do not** hide the video. Never drop a real upload because enrichment failed.

This scraping is the most fragile surface in the app. It runs server-side in the background
after each refresh (`server/refresh.ts`), and the selectors live in `server/youtube.ts`.
Live streams and premieres have no length badge; their duration stays unknown.

## Outbound safety
Every request goes through one guard in `server/youtube.ts`: https only, hosts `youtube.com`,
`www.youtube.com` and `m.youtube.com` only (redirects re-checked, at most 3), one 10 second
deadline, 5 MB body cap. Pasted input is rebuilt into a canonical YouTube URL or refused.

## Caching & politeness
- Feeds are cached per channel for 5 minutes and fetched four at a time; a refresh within a
  minute of the last one is skipped.
- Per-video enrichment is cached for a day in memory and stored in SQLite once found.
- A normal browser-like User-Agent is sent.
