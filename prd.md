---
project: Subfeed (working title)
version: 1
status: draft
created: 2026-06-30
context_type: greenfield
product_type: web-app (installable, single-user)
target_scale:
  users: small
  qps: negligible (a handful of feed fetches per manual or scheduled refresh)
  data_volume: small (≤ ~100 channels × ~15 recent items, plus on-device state)
timeline_budget:
  mvp_weeks: 1
  hard_deadline: null
  part_time: true
---

# Subfeed — PRD

## Vision & Problem Statement

The user opens YouTube to watch one new upload from a creator they deliberately chose to follow, but the entrance to the platform is a homepage and recommendation surface engineered to maximise watch time. The subscriptions feed — the only thing they actually came for — is buried, while autoplay, end-screen suggestions, related videos, and Shorts pull a two-minute intention into an hour-long session. The cost is recurring, unintended consumption and the felt loss of control over time.

The insight: the subscriptions feed is the cure, not the disease. Every channel publicly publishes its own recent-uploads feed with no account and no quota. Merging only the channels the user explicitly added into one reverse-chronological list, and playing each video through the embedded official player, delivers exactly the content they want while removing every algorithmic surface. Watching deliberately becomes the default because there is nothing else in the interface to drift into.

## User & Persona

**Primary persona — the solo operator.** A technical person who follows a curated set of YouTube channels, self-hosts, and wants intentional access to new uploads without surrendering an evening to the algorithm. **Trigger moment:** they have 20 minutes and want to see what's new from people they chose, watch one or two things, queue the rest, and close the tab without having been pulled anywhere.

No secondary persona — this is a single-user personal tool.

## Success Criteria

### Primary

- On at least 5 of 7 days, the user consumes their new uploads entirely within the app and within the configured daily budget, without bouncing to youtube.com to keep watching.
- The feed contains only new uploads from explicitly-added channels — zero recommended, trending, related, or Shorts items ever appear.

### Secondary

- The user can reliably take the "new" feed to empty (an inbox-zero equivalent) in a session, deferring anything they can't watch now to the watch-later queue without losing it.
- Weekly self-reported YouTube watch time trends down versus the user's pre-tool baseline.

### Guardrails

- Every video the user watches still credits the creator with a real view — the tool never routes around creator monetisation.
- No recommended, related, end-screen, trending, or Shorts content is ever presented anywhere in the app.
- Watched state is never silently lost — a video the user already watched does not reappear in the "new" list as if unseen.
- The app never requires signing into a Google account and never requests or stores Google credentials.

## User Stories

### US-01: Add a channel to the feed

- **Given** the user has a channel's URL, handle, or channel ID
- **When** they paste it into the add-channel input
- **Then** the channel is added to their list and its recent uploads begin appearing in the merged feed on the next refresh

#### Acceptance Criteria

- A canonical channel URL or channel ID is accepted directly.
- A handle (`@name`) or custom URL is resolved to the channel; if it cannot be resolved automatically, the user is told to paste the canonical channel ID instead.
- Adding a duplicate channel is a no-op, not a second entry.

### US-02: Read the merged chronological feed

- **Given** the user has one or more added channels
- **When** they open the app
- **Then** they see a single reverse-chronological list of new (unwatched) uploads across all their channels, each showing title, channel name, thumbnail, duration, and publish time

#### Acceptance Criteria

- Each video appears exactly once.
- The list contains no items the system cannot attribute to an added channel.
- An empty feed shows a "nothing new" state, not a blank screen.

### US-03: Watch a video without the rabbit hole

- **Given** a video in the feed
- **When** the user plays it
- **Then** it plays in the embedded official player inside the app, the creator receives a view, and no recommended, related, or end-screen videos are surfaced, and nothing autoplays afterwards

#### Acceptance Criteria

- Playback occurs in-app via the embedded official player (real view credit).
- When the video ends, the app returns to the feed — it does not auto-advance to another video.
- The player surface suppresses related/end-screen content to the extent the embed permits.

### US-04: Watched state clears the feed

- **Given** the user has watched a video
- **When** it crosses the watched threshold (or they mark it watched manually)
- **Then** it leaves the "new" feed and moves to watched history, and never returns to "new"

#### Acceptance Criteria

- Watched and unwatched can both be set manually.
- Watched state persists across sessions and app restarts.
- A watched video is retrievable in history but absent from "new".

### US-05: Defer with a watch-later queue

- **Given** a video the user wants but can't watch now
- **When** they add it to watch-later
- **Then** it is saved to a queue they can return to, independent of the daily budget on the "new" feed

#### Acceptance Criteria

- Queue membership persists across sessions.
- A queued video can be played from the queue and then marked watched.

### US-06: Suppress Shorts and tiny clips

- **Given** the user has set a minimum-duration filter (and Shorts hiding on)
- **When** the feed is built
- **Then** Shorts and videos under the threshold are excluded from the feed

#### Acceptance Criteria

- Shorts hiding can be toggled on/off.
- The minimum-duration threshold is user-configurable.

### US-07: Daily budget soft block

- **Given** the user has set a daily budget (count of videos or minutes)
- **When** they reach it
- **Then** the app shows a soft "you've hit your budget for today" state instead of continuing to serve videos, which the user may override

#### Acceptance Criteria

- The budget resets daily.
- The block is soft — the user can choose to continue.
- The budget applies to the "new" feed, not to re-watching history.

## Functional Requirements

### Channel management

- FR-001: User can add a channel by pasting its URL, handle, or channel ID. Priority: must-have
- FR-002: System resolves a pasted URL or handle to a canonical channel identity, or prompts for the channel ID when resolution fails. Priority: must-have
- FR-003: User can remove an added channel. Priority: must-have
- FR-004: User can view the list of their added channels. Priority: must-have
- FR-005: System rejects or de-duplicates a channel already on the list. Priority: must-have

### Feed

- FR-010: System retrieves the recent uploads from each added channel's public per-channel feed, with no account and no access credentials required. Priority: must-have
- FR-011: System merges all channels' uploads into one reverse-chronological list. Priority: must-have
- FR-012: Each video appears exactly once across the merged feed. Priority: must-have
- FR-013: System refreshes the feed on demand and on a configurable periodic schedule. Priority: must-have
- FR-014: Feed entries display title, channel name, thumbnail, duration, and publish time. Priority: must-have

### Playback

- FR-020: User can play a video in the embedded official player inside the app. Priority: must-have
- FR-021: The player surface suppresses recommended, related, and end-screen videos as far as the embed allows. Priority: must-have
- FR-022: No video autoplays after the current one ends; control returns to the feed. Priority: must-have

### State & queue

- FR-030: A video is marked watched when it crosses a watched threshold during playback or when the user marks it manually. Priority: must-have
- FR-031: Watched videos leave the "new" feed and are retained in a watched history. Priority: must-have
- FR-032: User can manually toggle a video between watched and unwatched. Priority: nice-to-have
- FR-033: User can add a video to a watch-later queue and view that queue. Priority: must-have

### Distraction controls

- FR-040: User can hide Shorts. Priority: must-have
- FR-041: User can set a minimum-duration filter that excludes videos below the threshold. Priority: must-have
- FR-042: User can set a daily budget as a video count or a number of minutes. Priority: must-have
- FR-043: When the daily budget is reached, the app presents a soft block on the "new" feed that the user can override. Priority: must-have

## Non-Functional Requirements

- After a refresh of up to ~100 channels, new uploads are visible within 5 seconds.
- During active use, feed content is no older than the configured refresh interval (default 30 minutes).
- On a return visit, the feed is interactive within 2 seconds.
- Previously loaded feed entries, watch-later queue, and watched history remain browsable without a network connection.
- No Google account credentials are ever requested or stored, and no Google account is ever required.
- Watched state and watch-later queue survive app restarts and persist across sessions.
- The tool handles a curated list of up to ~100 channels without noticeable degradation.

## Business Logic

A video from an explicitly-added channel appears exactly once in a single reverse-chronological feed and is played through the embedded official player so the creator receives view credit, with no recommended, related, or Shorts content presented anywhere in the app.

**Inputs:** the set of channels the user has added and the recent uploads each one publishes; the user's per-video watched and queued state; and the user's filter and daily-budget configuration.

**Output:** a deduplicated, reverse-chronological list of unwatched uploads with Shorts and below-threshold videos removed, presented under a daily budget that gates how much "new" content is served before the app signals stop.

**User experience of the rule:** the feed behaves like an inbox. New uploads arrive; the user watches them in-app (crediting the creator) or queues them for later; watched items leave the "new" list and never return; and once the daily budget is hit the app gently signals "done for today" rather than serving more, which the user may override deliberately. The intentional friction of manual channel curation means nothing enters the feed that the user did not choose.

## Access Control

Single user. (Superseded in the implementation: state lives in server-side SQLite, and the API is behind a password login; see the README's security model.) The app reads only publicly available per-channel feeds and never accesses, or requires sign-in to, a Google account. If the hosted instance is reachable beyond the user's own machine, whether any access gate is needed is captured in Open Questions.

## Regulatory & Compliance

No financial or fintech-regulatory concerns apply to this single-user personal tool. The relevant compliance dimensions are:

- **Platform terms & creator monetisation.** Playback uses the embedded official player, which is the terms-compliant path that also credits creators with a genuine view — chosen deliberately over alternative front-ends that would deliver a cleaner interface but likely deny the creator the view and risk violating platform terms.
- **Data sensitivity.** The app collects no personal data, processes no third-party PII, and stores all state on-device. There are no accounts, so there is no credential or profile data at rest.
- **Data source.** The per-channel public feeds are a published, openly available source; no scraping of authenticated or gated surfaces is involved.

## Non-Goals

- No algorithmic recommendations, trending, or discovery — removing these is the entire point of the product.
- No comments, likes, or social interaction — out of scope for a quiet consumption tool.
- No multi-user support, accounts, or cross-person sync — this is a single-user personal tool.
- No live Google-account subscription sync — manual curation was chosen to avoid account sign-in and API quotas and to keep the channel list intentional.
- No video downloading or offline video storage — creator view credit and platform terms require official in-app playback.
- No Shorts surface — Shorts are deliberately filtered out, not displayed in a separate view.
- No native mobile apps — an installable web app covers the single-user need.
- No hard lockout — the daily budget is a soft nudge the user can override, never an enforced block.

## Open Questions

1. **Final product name.** "Subfeed" is a placeholder. — Owner: maintainer.
2. **MVP timeline.** `mvp_weeks: 1` (part-time) is an estimate — confirm scope and available time. — Owner: maintainer.
3. **Refresh behaviour.** Default refresh interval, and whether refresh runs on a background schedule or only when the app is opened. — Owner: maintainer.
4. **Watched threshold.** What counts as "watched" — a percentage watched, a number of seconds, or manual-only? — Owner: maintainer.
5. **Daily budget defaults.** Unit (video count vs minutes) and the default value. — Owner: maintainer.
6. **Channel-ID resolution.** Is it acceptable for the MVP to require pasting the canonical channel ID whenever a handle or custom URL can't be auto-resolved? — Owner: maintainer.
7. **Hosted-instance access.** If deployed and network-reachable, does the instance need any access gate, or is it restricted to a private network / loopback only? — Owner: maintainer.
8. **State portability.** On-device state is assumed for a single device in the MVP — is access from a second device needed (which would require a small synced store)? — Owner: maintainer.
