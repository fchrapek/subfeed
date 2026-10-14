# Goal: Build "Subfeed" — a distraction-free YouTube subscriptions reader

## Mission
Build an installable, single-user web app that merges the **public RSS upload feeds** of
channels the user explicitly adds into **one reverse-chronological inbox of unwatched
videos**, each played through the **official embedded player**. No recommendations, related,
trending, end-screen, autoplay-next, or Shorts anywhere. The user opens the app, sees what's
new from people they chose, watches one or two in-app (crediting the creator with a real
view), queues the rest, and closes the tab — without being pulled into the algorithm.

No Google account, no sign-in, no API key/quota. All user state lives on-device.

## Read first
- `prd.md` — full product intent, user stories, success criteria (source of truth).
- `docs/scope.md` — MVP scope, must-have requirements, resolved defaults, non-goals.
- `docs/stack.md` — recommended architecture & tech stack.
- `docs/ingest.md` — channel resolution, RSS parsing, Shorts/duration handling.
- `docs/data-model.md` — persisted entities, derived feed, player config.

Treat the `docs/*` defaults as the chosen MVP path. Flag — don't silently change — anything
that conflicts with `prd.md`.

## Done looks like
1. Add a channel by URL, handle, or channel ID; duplicates are a no-op; view/remove the
   channel list. (US-01, FR-001–005)
2. One merged reverse-chronological feed of unwatched uploads — each video once; shows
   title/channel/thumbnail/duration/publish-time; "nothing new" empty state. (US-02, FR-010–014)
3. Play in the embedded player; creator gets the view; no related/end-screen pushed; nothing
   autoplays after; control returns to the feed. (US-03, FR-020–022)
4. Watched (at 90% or manual toggle) leaves "new", lands in history, never returns; persists
   across restarts. (US-04, FR-030–032)
5. Watch-later queue persists and plays. (US-05, FR-033)
6. Hide Shorts + minimum-duration filter exclude short clips. (US-06, FR-040–041)
7. Soft daily budget that signals "done for today", is overridable, resets daily, and applies
   only to "new". (US-07, FR-042–043)
8. Installable PWA; previously loaded feed, queue, and history browsable offline; interactive
   within 2s on return.

## Hard rules (guardrails — never violate)
- Playback only via the official embedded player — every watch must credit the creator.
  No alternative front-ends, no downloads.
- Never present recommended/related/trending/end-screen/Shorts content anywhere.
- Never lose watched state — a watched video must not reappear as "new".
- Never require, request, or store Google credentials; never use the Data API.
- The daily budget is a soft, overridable nudge — never a hard lockout.

## Build order (vertical slices, ship per story)
1. Server feed proxy: channel resolution + RSS fetch/parse → JSON (`docs/ingest.md`).
2. On-device store + merged feed UI with watched + queue (`docs/data-model.md`).
3. Embedded player with autoplay-next disabled and return-to-feed.
4. Filters (Shorts, min-duration), refresh (manual + interval), daily budget soft block.
5. PWA: installable + offline browse of cached state.

Keep each user story shippable and verifiable against its acceptance criteria in `prd.md`.
