# Scope & MVP Defaults

The MVP path. `prd.md` is the source of truth; this file resolves the Open Questions
into concrete defaults so the build is not blocked. Anything here that conflicts with
`prd.md` should be flagged, not silently changed.

## Must-have requirements (all of these ship in the MVP)
- Channel management: FR-001…FR-005
- Feed: FR-010…FR-014
- Playback: FR-020…FR-022
- State & queue: FR-030, FR-031, FR-033 (FR-032 manual toggle is nice-to-have but cheap — include)
- Distraction controls: FR-040…FR-043

## Resolved open questions → MVP defaults
1. **Name** — keep working title "Subfeed".
2. **Timeline** — 1 week part-time; vertical slices, ship per user story.
3. **Refresh** — default interval 30 min. Refresh on app open + a manual refresh button.
   Background/scheduled refresh is optional polish, not required for MVP.
4. **Watched threshold** — mark watched when playback reaches **90%**, OR manual mark.
   Manual toggle works both directions (watched ↔ unwatched).
5. **Daily budget** — default **5 videos** (unit = count). Unit and value are configurable
   (count or minutes). Soft block, user can override. Applies to "new" only, not re-watching.
6. **Channel-ID resolution** — acceptable for MVP to require pasting the canonical channel ID
   when a handle/custom URL cannot be auto-resolved.
7. **Hosted access** — a single password login guards the API (see the README's security model).
8. **State portability** — single device, on-device state. No cross-device sync in MVP.

Other defaults:
- **Hide Shorts** — ON by default.
- **Minimum duration** — default 120s (only applied when known; never hide on unknown duration).

## Non-goals (do not build)
- No algorithmic recommendations, trending, or discovery.
- No comments, likes, or social interaction.
- No multi-user, accounts, or cross-person sync.
- No live Google-account subscription sync; no YouTube Data API; no API key.
- No video downloading or offline video storage (playback is in-app official embed only).
- No separate Shorts surface — Shorts are filtered out, not displayed.
- No native mobile apps — an installable web app (PWA) is the target.
- No hard lockout — the daily budget is always a soft, overridable nudge.
