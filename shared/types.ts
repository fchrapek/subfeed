// Types shared between the server (feed proxy) and the client (app + on-device store).

export interface Channel {
  id: string // canonical YouTube channel id, "UC..."
  title: string
  addedAt: number
}

export interface Video {
  videoId: string
  channelId: string
  channelTitle: string
  title: string
  thumbnailUrl: string
  publishedAt: number
  // Enrichment (filled in lazily by /api/video/:id/meta). null = looked up, unknown.
  durationSec?: number | null
  isShort?: boolean | null
  enrichedAt?: number
}

export type WatchStatus = 'new' | 'watched'

export interface WatchState {
  videoId: string
  status: WatchStatus
  watchedAt?: number
  // true when the video left "new" as a result of watching — counted against the daily budget.
  fromNew?: boolean
  // last playback position (seconds) so an accidentally-closed video resumes where it left off.
  positionSec?: number
}

export interface QueueItem {
  videoId: string
  order: number
  addedAt: number
}

export interface Playlist {
  id: number
  name: string
  createdAt: number
}

export interface PlaylistItem {
  playlistId: number
  videoId: string
  order: number
  addedAt: number
}

export type BudgetUnit = 'count' | 'minutes'

export interface Settings {
  refreshIntervalMin: number
  hideShorts: boolean
  minDurationSec: number
  watchedThresholdPct: number
  // How many videos the New feed shows at once.
  feedLimit: number
  dailyBudget: { unit: BudgetUnit; value: number }
}

export interface BudgetUsage {
  date: string // YYYY-MM-DD in local time
  count: number
  minutes: number
  overridden?: boolean
}

// ---- API payloads ----

export interface ChannelResolution {
  channelId: string
  title: string
}

export interface VideoMeta {
  durationSec: number | null
  isShort: boolean | null
}

/** Full on-device/server state snapshot exchanged via GET /api/state. */
export interface StateSnapshot {
  channels: Channel[]
  videos: Video[]
  watch: WatchState[]
  queue: QueueItem[]
  playlists: Playlist[]
  playlistItems: PlaylistItem[]
  settings: Settings
  budget: BudgetUsage
  lastRefresh: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  refreshIntervalMin: 30,
  hideShorts: true,
  minDurationSec: 120,
  watchedThresholdPct: 90,
  feedLimit: 20,
  dailyBudget: { unit: 'count', value: 5 },
}
