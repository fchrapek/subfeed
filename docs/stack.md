# Architecture & Stack

These choices match the constraints:
single-user, self-hosted, installable, offline-browsable, no Google account.

## Why a server is unavoidable
YouTube's RSS feed endpoint and channel pages do **not** send permissive CORS headers,
so the browser cannot fetch them directly. A thin server-side proxy is required for feed
fetch, channel resolution, and Shorts/duration enrichment.

## Shape
- **Language:** TypeScript end to end.
- **Client:** Vite + React SPA. Installable + offline via `vite-plugin-pwa` (service worker
  caches the app shell and lets previously loaded data render offline).
- **Server:** one small Node process (Hono) that (a) serves the built client and
  (b) exposes `/api/*`. Single process → trivial to self-host / Dockerise.
- **Persistence:** SQLite on the server (`node:sqlite`) is the source of truth. The client
  mirrors it into IndexedDB (Dexie) so the UI is reactive and loaded data stays browsable
  offline.
- **Auth:** one password (scrypt hash in env), random sessions in SQLite. See the README's
  security model.

## Responsibility split
- **Server owns:** outbound network (YouTube only), all user state and its rules (watched,
  budget, resume, playlists), sessions.
- **Client owns:** feed filtering and sorting for display, UI, the embedded player, PWA/offline.

## API (as built)
All under `/api`, all but login need a session; writes must be same-origin JSON.
- `POST /auth/login`, `POST /auth/logout`, `POST /auth/logout-all`
- `GET /state`: the full snapshot the client mirrors
- `POST /channels` (URL, handle or id) · `DELETE /channels/:id` · `POST /refresh`
- `POST /watch/watched` · `POST /watch/unwatched` · `POST /watch/position`
- `POST /queue` · `DELETE /queue/:videoId`
- `POST /playlists` · `PATCH /playlists/:id` · `DELETE /playlists/:id`
- `POST /playlists/:id/items` · `DELETE /playlists/:id/items/:videoId`
- `PUT /settings` · `POST /budget/override`

## Suggested structure
```
/server   API, auth, SQLite store, feed fetch, channel resolution, enrichment
/client   React app, IndexedDB mirror, player, PWA
/shared   TS types shared across both (Video, Channel, Settings…)
```

See `docs/ingest.md` for the fetch/parse details and `docs/data-model.md` for the types.
