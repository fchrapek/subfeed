import * as store from './db'
import { fetchChannelFeed, fetchChannelVideoLengths, fetchVideoMeta } from './youtube'

// Server owns feed refresh and enrichment now that SQLite is the source of truth.

const FEED_CONCURRENCY = 4
const REFRESH_COOLDOWN_MS = 60_000

let inFlight: Promise<void> | null = null

/**
 * Fetch every channel's feed. Concurrent callers share one run, and a run
 * within a minute of the last one is skipped (`force` bypasses that, e.g. right
 * after adding a channel).
 */
export function refreshAllFeeds({ force = false } = {}): Promise<void> {
  // A forced run (new channel) must not settle for a run that started without it.
  if (inFlight) return force ? inFlight.then(() => refreshAllFeeds({ force })) : inFlight
  const last = store.getLastRefresh() ?? 0
  if (!force && Date.now() - last < REFRESH_COOLDOWN_MS) return Promise.resolve()
  inFlight = (async () => {
    const channels = store.listChannels()
    let i = 0
    const worker = async () => {
      while (i < channels.length) {
        const channel = channels[i++]
        try {
          store.upsertVideos(await fetchChannelFeed(channel.id))
        } catch {
          // one broken feed must not sink the rest
        }
      }
    }
    await Promise.all(Array.from({ length: FEED_CONCURRENCY }, worker))
    store.pruneOldVideos()
    store.setLastRefresh(Date.now())
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

let enriching = false

const LENGTH_LOOKBACK_MS = 60 * 24 * 3600 * 1000
const MAX_CHANNEL_LISTS = 25

/**
 * One request per channel that has recent videos of unknown length. Cached for
 * an hour per channel, so a live stream or premiere that never gets a length
 * badge can't trigger a fetch on every refresh.
 */
async function fillLengthsFromChannelLists(): Promise<void> {
  const channels = store.listChannelsMissingDurations(Date.now() - LENGTH_LOOKBACK_MS, MAX_CHANNEL_LISTS)
  let i = 0
  const worker = async () => {
    while (i < channels.length) {
      const channelId = channels[i++]
      try {
        store.setDurations(channelId, await fetchChannelVideoLengths(channelId))
      } catch {
        // no lengths this time; the per-video probe below may still find some
      }
    }
  }
  await Promise.all([worker(), worker()])
}

/**
 * Fill in duration / Shorts for the newest un-enriched videos. Runs in the
 * background (fire-and-forget) so refresh stays fast; the client re-pulls state.
 */
export async function enrichPending(limit = 80): Promise<void> {
  if (enriching) return
  enriching = true
  try {
    await fillLengthsFromChannelLists()
    const pending = store.listPendingEnrichment(limit)
    let i = 0
    const worker = async () => {
      while (i < pending.length) {
        const videoId = pending[i++]
        try {
          const meta = await fetchVideoMeta(videoId)
          store.setEnrichment(videoId, meta.durationSec, meta.isShort)
        } catch {
          store.setEnrichment(videoId, null, null)
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
  } finally {
    enriching = false
  }
}
