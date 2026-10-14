# Data Model & Persistence

All user state is persisted on-device (IndexedDB). Types are shared between client and server.

## Entities
```ts
Channel       { id: string /*UC…*/, title: string, addedAt: number }

Video         { videoId: string, channelId: string, channelTitle: string,
                title: string, thumbnailUrl: string, publishedAt: number,
                durationSec?: number, isShort?: boolean, enrichedAt?: number }

WatchState    { videoId: string, status: 'new' | 'watched', watchedAt?: number }

QueueItem     { videoId: string, order: number }   // watch-later, ordered

Settings      { refreshIntervalMin: number /*30*/, hideShorts: boolean /*true*/,
                minDurationSec: number /*120*/, watchedThresholdPct: number /*90*/,
                dailyBudget: { unit: 'count' | 'minutes', value: number /*5*/ } }

BudgetUsage   { date: string /*YYYY-MM-DD*/, count: number, minutes: number }
```

## Derived "new" feed
Filter cached `Video`s where **all** hold, then sort by `publishedAt` desc:
- `WatchState.status !== 'watched'`
- its `channelId` is still in the channel list
- not a Short, when `hideShorts` is on (unknown ⇒ keep)
- `durationSec >= minDurationSec`, when duration is known (unknown ⇒ keep)

Watch-later queue and watched history are independent views over the same `Video` cache
and are **not** subject to the daily budget. History = `status === 'watched'`.

## Watched transition
Set `status: 'watched'` (with `watchedAt`) when playback reaches `watchedThresholdPct`
(default 90%) **or** on manual mark. Manual toggle can also move watched → new.
A watched video must never reappear in "new".

## Daily budget
Increment `BudgetUsage` for today when a "new" video is watched. When usage reaches
`dailyBudget.value` for its unit, show a soft "done for today" state on the **new** feed
with an explicit override. Resets at local midnight. Never gates history/queue re-watching.

## Embedded player config (no rabbit hole)
- Embed via `https://www.youtube-nocookie.com/embed/<videoId>?rel=0&modestbranding=1&autoplay=1`.
- `rel=0` now only limits related results to the same channel — suppress as far as the embed
  allows; the guarantee is **we never render any related/recommended UI ourselves**.
- Use the IFrame Player API: on `ENDED` (state 0), return to the feed and load nothing next.
  No autoplay-next, ever.
- Playback is the official embed only → the creator gets a real view (hard guardrail).
