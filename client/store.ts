import * as api from './api'
import { db } from './db'
import type { BudgetUsage, Settings, StateSnapshot, Video, WatchStatus } from '../shared/types'

// SQLite on the server is the source of truth. Every mutation goes through the API;
// the result is mirrored into IndexedDB so the UI stays reactive and offline-readable.

async function mirror(s: StateSnapshot): Promise<void> {
  const tables = [db.channels, db.videos, db.watch, db.queue, db.playlists, db.playlistItems, db.kv]
  await db.transaction('rw', tables, async () => {
    await db.channels.clear()
    await db.channels.bulkPut(s.channels)
    await db.videos.clear()
    await db.videos.bulkPut(s.videos)
    await db.watch.clear()
    await db.watch.bulkPut(s.watch)
    await db.queue.clear()
    await db.queue.bulkPut(s.queue)
    await putPlaylists(s)
    await db.kv.bulkPut([
      { key: 'settings', value: s.settings },
      { key: 'budget', value: s.budget },
      { key: 'lastRefresh', value: s.lastRefresh },
    ])
  })
}

// Bumped by wipeLocal. A response requested before a wipe (a refresh still in
// flight at sign-out) must not write the signed-out data back.
let generation = 0

async function fromServer<T>(request: Promise<T>, write: (res: T) => Promise<unknown>): Promise<T> {
  const gen = generation
  const res = await request
  if (gen === generation) await write(res)
  return res
}

/**
 * Forget everything this device knows: the IndexedDB mirror and cached
 * thumbnails. Runs on sign-out and whenever the server says the session is gone.
 */
export async function wipeLocal(): Promise<void> {
  generation++
  await db.transaction('rw', [db.channels, db.videos, db.watch, db.queue, db.playlists, db.playlistItems, db.kv], () =>
    Promise.all(
      [db.channels, db.videos, db.watch, db.queue, db.playlists, db.playlistItems, db.kv].map((t) => t.clear()),
    ),
  )
  try {
    await caches?.delete('thumbnails')
  } catch {
    /* Cache Storage unavailable (private mode): nothing cached either */
  }
}

/** Pull the full server snapshot into the local mirror. Offline: keeps the existing mirror. */
export async function pullState(): Promise<void> {
  await fromServer(api.getState(), mirror)
}

// ---- Channels ----

export async function addChannel(input: string): Promise<void> {
  await fromServer(api.addChannel(input), mirror)
}

export async function removeChannel(channelId: string): Promise<void> {
  await fromServer(api.removeChannel(channelId), mirror)
}

// ---- Refresh ----

export async function refreshAll(): Promise<void> {
  await fromServer(api.refresh(), mirror)
}

// ---- Watch state + queue ----

export async function markWatched(videoId: string): Promise<void> {
  await fromServer(api.setWatched(videoId), ({ watch, budget }) =>
    Promise.all([db.watch.put(watch), db.kv.put({ key: 'budget', value: budget })]),
  )
}

export async function markUnwatched(videoId: string): Promise<void> {
  await fromServer(api.setUnwatched(videoId), ({ watch }) => db.watch.put(watch))
}

export async function addToQueue(videoId: string): Promise<void> {
  await fromServer(api.addToQueue(videoId), ({ queue }) => replaceQueue(queue))
}

export async function removeFromQueue(videoId: string): Promise<void> {
  await fromServer(api.removeFromQueue(videoId), ({ queue }) => replaceQueue(queue))
}

async function replaceQueue(queue: StateSnapshot['queue']): Promise<void> {
  await db.transaction('rw', db.queue, async () => {
    await db.queue.clear()
    await db.queue.bulkPut(queue)
  })
}

// ---- Playlists ----

async function putPlaylists(s: Pick<StateSnapshot, 'playlists' | 'playlistItems'>): Promise<void> {
  await db.playlists.clear()
  await db.playlists.bulkPut(s.playlists ?? [])
  await db.playlistItems.clear()
  await db.playlistItems.bulkPut(s.playlistItems ?? [])
}

async function replacePlaylists(s: Pick<StateSnapshot, 'playlists' | 'playlistItems'>): Promise<void> {
  await db.transaction('rw', db.playlists, db.playlistItems, () => putPlaylists(s))
}

/** Creates the playlist and returns its id. */
export async function createPlaylist(name: string): Promise<number> {
  const res = await fromServer(api.createPlaylist(name), replacePlaylists)
  return res.playlist.id
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  await fromServer(api.renamePlaylist(id, name), replacePlaylists)
}

export async function deletePlaylist(id: number): Promise<void> {
  await fromServer(api.deletePlaylist(id), replacePlaylists)
}

export async function addToPlaylist(id: number, videoId: string): Promise<void> {
  await fromServer(api.addToPlaylist(id, videoId), replacePlaylists)
}

export async function removeFromPlaylist(id: number, videoId: string): Promise<void> {
  await fromServer(api.removeFromPlaylist(id, videoId), replacePlaylists)
}

const RESUME_MIN_SEC = 10

/** Persist where playback currently is, so an accidental close can resume. */
export async function savePosition(videoId: string, positionSec: number): Promise<void> {
  const w = await db.watch.get(videoId)
  if (w?.status === 'watched') return
  // Optimistic local update so the resume badge reflects it immediately.
  await db.watch.put({ ...(w ?? { videoId, status: 'new' }), videoId, status: 'new', positionSec })
  try {
    await api.setPosition(videoId, positionSec)
  } catch {
    /* offline: the local mirror is ahead until the next online pull */
  }
}

/** The second to resume from, or 0 if there's no meaningful saved position. */
export function resumeAt(w?: { status: WatchStatus; positionSec?: number }): number {
  if (!w || w.status === 'watched') return 0
  return (w.positionSec ?? 0) >= RESUME_MIN_SEC ? Math.floor(w.positionSec!) : 0
}

// ---- Settings & budget ----

export async function updateSettings(settings: Settings): Promise<void> {
  await fromServer(api.putSettings(settings), ({ settings: saved }) => db.kv.put({ key: 'settings', value: saved }))
}

export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function getBudgetUsage(): Promise<BudgetUsage> {
  const key = todayKey()
  const row = await db.kv.get('budget')
  const usage = row?.value as BudgetUsage | undefined
  if (usage?.date === key) return usage
  return { date: key, count: 0, minutes: 0 }
}

export async function overrideBudgetToday(): Promise<void> {
  await fromServer(api.overrideBudget(), ({ budget }) => db.kv.put({ key: 'budget', value: budget }))
}

/** Returns the used amount and limit in the configured unit, plus block state. */
export function budgetStatus(usage: BudgetUsage, settings: Settings) {
  const used = settings.dailyBudget.unit === 'count' ? usage.count : Math.round(usage.minutes)
  const limit = settings.dailyBudget.value
  return {
    used,
    limit,
    unit: settings.dailyBudget.unit,
    blocked: limit > 0 && used >= limit && !usage.overridden,
  }
}

// ---- Feed filtering ----

/** Distraction filters (US-06). Unknown duration/Shorts is never hidden. */
export function isHidden(v: Video, s: Settings): boolean {
  if (s.hideShorts && v.isShort === true) return true
  if (v.durationSec != null && v.durationSec < s.minDurationSec) return true
  return false
}
