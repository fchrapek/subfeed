# Data Model & Persistence

All user state lives in server-side SQLite (`server/db.ts`), the source of truth. The client
mirrors each API response into IndexedDB (Dexie) for a reactive UI and offline reading; writes
need a connection. Types are shared between client and server (`shared/types.ts`).

## Entities
```ts
Channel       { id: string /*UC…*/, title: string, addedAt: number }

Video         { videoId: string, channelId: string, channelTitle: string,
                title: string, thumbnailUrl: string, publishedAt: number,
                durationSec?: number, isShort?: boolean, enrichedAt?: number }

WatchState    { videoId: string, status: 'new' | 'watched', watchedAt?: number,
                fromNew?: boolean, positionSec?: number /*resume point*/ }

QueueItem     { videoId: string, order: number, addedAt: number }   // Watch later

Playlist      { id: number, name: string, createdAt: number }        // user-made
PlaylistItem  { playlistId: number, videoId: string, order: number, addedAt: number }

Settings      { refreshIntervalMin: number /*30, 5–1440*/, hideShorts: boolean /*true*/,
                minDurationSec: number /*120*/, watchedThresholdPct: number /*90*/,
                feedLimit: number /*20, 1–500*/,
                dailyBudget: { unit: 'count' | 'minutes', value: number /*5*/ } }

BudgetUsage   { date: string /*YYYY-MM-DD*/, count: number, minutes: number }
```

Server-only tables: `sessions` (SHA-256 of each session token, timestamps) and `auth_state`
(login failure count and lockout), see `server/auth.ts`. Videos published over a year ago
are pruned unless saved in Watch later or a playlist; their "watched" marks are kept.

## Derived "new" feed
Filter cached `Video`s where **all** hold, then sort by `publishedAt` desc:
- `WatchState.status !== 'watched'`
- its `channelId` is still in the channel list
- not a Short, when `hideShorts` is on (unknown ⇒ keep)
- `durationSec >= minDurationSec`, when duration is known (unknown ⇒ keep)

Only the newest `feedLimit` of these are shown; the rest appear as these are cleared.

Watch later, user playlists and watched history are views over the same `Video` cache and are
**not** subject to the daily budget. History = `status === 'watched'`.

## Watched transition
Set `status: 'watched'` (with `watchedAt`) when playback reaches `watchedThresholdPct`
(default 90%) **or** on manual mark. Manual toggle can also move watched → new.
A watched video must never reappear in "new".

## Daily budget
Increment `BudgetUsage` for today when a "new" video is watched. When usage reaches
`dailyBudget.value` for its unit, show a soft "done for today" state on the **new** feed
with an explicit override. Resets at local midnight. Never gates history/queue re-watching.

## Embedded player config (no rabbit hole)
- Embed via `https://www.youtube-nocookie.com/embed/<videoId>?rel=0&autoplay=1&playsinline=1`.
- `rel=0` now only limits related results to the same channel — suppress as far as the embed
  allows; the guarantee is **we never render any related/recommended UI ourselves**.
- Use the IFrame Player API: on `ENDED` (state 0), return to the feed and load nothing next.
  The one exception is a playlist the user chose to play: it continues to the next item in
  the same player (`loadVideoById`), never into anything YouTube suggests.
- Playback is the official embed only → the creator gets a real view (hard guardrail).
