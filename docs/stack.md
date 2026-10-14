# Architecture & Stack (recommended)

A builder may substitute equivalents, but these choices match the constraints:
single-user, self-hosted, installable, offline-browsable, no Google account.

## Why a server is unavoidable
YouTube's RSS feed endpoint and channel pages do **not** send permissive CORS headers,
so the browser cannot fetch them directly. A thin server-side proxy is required for feed
fetch, channel resolution, and Shorts/duration enrichment. Everything else is client-side.

## Recommended shape
- **Language:** TypeScript end to end.
- **Client:** Vite + React SPA. Installable + offline via `vite-plugin-pwa` (service worker
  caches the app shell and lets previously loaded data render offline).
- **Server:** one small Node process (Hono or Express) that (a) serves the built client and
  (b) exposes `/api/*`. Single process → trivial to self-host / Dockerise.
- **Persistence:** IndexedDB on the client (Dexie wrapper) for channels, watched state, queue,
  settings, and the cached feed. The server is stateless except for a feed/enrichment cache.

(Equivalent single-process full-stack frameworks — SvelteKit, Next.js, Remix — are fine
substitutes; the split below still applies.)

## Responsibility split
- **Server owns:** outbound network. Resolve channel → ID, fetch + parse RSS to JSON,
  enrich videos with duration/Shorts flag, cache responses. No user state.
- **Client owns:** all user state (channels, watched, queue, settings, budget usage),
  feed merge/filter/sort, UI, the embedded player, PWA/offline.

## Suggested API
- `POST /api/channels/resolve` — body: raw URL/handle/ID → `{ channelId, title }` or an
  error telling the UI to ask for the canonical channel ID.
- `GET  /api/feed?channelId=...` — recent uploads as JSON (cached for the refresh interval).
- `GET  /api/video/:id/meta` — `{ durationSec, isShort }` (cached permanently per video).

## Suggested structure
```
/server   feed proxy, channel resolution, enrichment + cache
/client   React app, IndexedDB store, player, PWA
/shared   TS types shared across both (Video, Channel, Settings…)
```

See `docs/ingest.md` for the fetch/parse details and `docs/data-model.md` for the types.
