# Feed Ingestion

All ingestion uses **public pages only** — no account, no API key, no quota.

## Per-channel feed
- URL: `https://www.youtube.com/feeds/videos.xml?channel_id=<CHANNEL_ID>`
- Returns Atom XML, ~15 most recent uploads. Parse each `<entry>`:
  - `yt:videoId` → video id
  - `title` → title
  - `author/name` → channel name
  - `published` → publish time (ISO 8601)
  - `media:group/media:thumbnail@url` → thumbnail
- **The feed gives no duration and no Shorts flag** — see enrichment below.
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
- **Duration:** fetch the watch page and read `lengthSeconds` from the embedded player
  response, or `<meta itemprop="duration">` (ISO 8601). Convert to seconds.
- **Shorts:** request `https://www.youtube.com/shorts/<videoId>` — a Short returns 200 and
  stays on `/shorts/…`; a normal video redirects to `/watch`. (Duration ≤ ~60s is a weak
  secondary signal only.)
- **Degrade gracefully:** if duration/Shorts can't be determined, treat duration as unknown
  and **do not** hide the video. Never drop a real upload because enrichment failed.

This scraping is the most fragile surface in the app — isolate it behind `/api/video/:id/meta`,
cache permanently per video, and keep selectors easy to update.

## Caching & politeness
- Cache feed JSON per channel for the refresh interval (default 30 min).
- Cache per-video duration/Shorts permanently (it never changes).
- Set a normal browser-like User-Agent; fetch lazily (only enrich videos about to be shown).
