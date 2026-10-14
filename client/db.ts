import Dexie, { type Table } from 'dexie'
import type { Channel, Playlist, PlaylistItem, QueueItem, Settings, Video, WatchState } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

// Local read mirror of the server's SQLite state, so the UI stays reactive
// (useLiveQuery) and previously-loaded data is browsable offline.

export interface KV {
  key: string
  value: unknown
}

export { DEFAULT_SETTINGS }

class SubfeedDB extends Dexie {
  channels!: Table<Channel, string>
  videos!: Table<Video, string>
  watch!: Table<WatchState, string>
  queue!: Table<QueueItem, string>
  playlists!: Table<Playlist, number>
  playlistItems!: Table<PlaylistItem, [number, string]>
  kv!: Table<KV, string>

  constructor() {
    super('subfeed')
    this.version(1).stores({
      channels: 'id, addedAt',
      videos: 'videoId, channelId, publishedAt',
      watch: 'videoId, status',
      queue: 'videoId, order',
      kv: 'key',
    })
    this.version(2).stores({
      playlists: 'id, createdAt',
      playlistItems: '[playlistId+videoId], playlistId, videoId, order',
    })
  }
}

export const db = new SubfeedDB()

export async function getSettings(): Promise<Settings> {
  const row = await db.kv.get('settings')
  const stored = (row?.value as Partial<Settings>) ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    dailyBudget: { ...DEFAULT_SETTINGS.dailyBudget, ...(stored.dailyBudget ?? {}) },
  }
}
