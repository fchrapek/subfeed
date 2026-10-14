// Loaded at runtime rather than imported: Vite 5 (vitest) strips the node:
// prefix from node:sqlite and then can't find "sqlite".
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
import {
  DEFAULT_SETTINGS,
  type BudgetUsage,
  type Channel,
  type Playlist,
  type PlaylistItem,
  type QueueItem,
  type Settings,
  type StateSnapshot,
  type Video,
  type WatchState,
} from '../shared/types'

// The single source of truth: one SQLite file on disk. node:sqlite is synchronous,
// which is ideal for a single-user, low-QPS personal tool.
const DB_PATH = process.env.SUBFEED_DB ?? new URL('./db.sqlite', import.meta.url).pathname
export const db = new DatabaseSync(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    addedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS videos (
    videoId TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    channelTitle TEXT NOT NULL,
    title TEXT NOT NULL,
    thumbnailUrl TEXT NOT NULL,
    publishedAt INTEGER NOT NULL,
    durationSec INTEGER,
    isShort INTEGER,
    enrichedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channelId);
  CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(publishedAt);
  CREATE TABLE IF NOT EXISTS watch (
    videoId TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    watchedAt INTEGER,
    fromNew INTEGER,
    positionSec REAL
  );
  CREATE TABLE IF NOT EXISTS queue (
    videoId TEXT PRIMARY KEY,
    ord INTEGER NOT NULL,
    addedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playlist_items (
    playlistId INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    videoId TEXT NOT NULL,
    ord INTEGER NOT NULL,
    addedAt INTEGER NOT NULL,
    PRIMARY KEY (playlistId, videoId)
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

db.exec('PRAGMA foreign_keys = ON')

// node:sqlite's DatabaseSync has no transaction() helper, so wrap manually.
function tx<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ---- row <-> domain conversions (node:sqlite only stores null/number/bigint/string) ----

const bool = (v: boolean | null | undefined) => (v == null ? null : v ? 1 : 0)

interface VideoRow {
  videoId: string
  channelId: string
  channelTitle: string
  title: string
  thumbnailUrl: string
  publishedAt: number
  durationSec: number | null
  isShort: number | null
  enrichedAt: number | null
}

function toVideo(r: VideoRow): Video {
  return {
    videoId: r.videoId,
    channelId: r.channelId,
    channelTitle: r.channelTitle,
    title: r.title,
    thumbnailUrl: r.thumbnailUrl,
    publishedAt: r.publishedAt,
    durationSec: r.durationSec,
    isShort: r.isShort == null ? null : Boolean(r.isShort),
    enrichedAt: r.enrichedAt ?? undefined,
  }
}

interface WatchRow {
  videoId: string
  status: string
  watchedAt: number | null
  fromNew: number | null
  positionSec: number | null
}

function toWatch(r: WatchRow): WatchState {
  return {
    videoId: r.videoId,
    status: r.status as WatchState['status'],
    watchedAt: r.watchedAt ?? undefined,
    fromNew: r.fromNew == null ? undefined : Boolean(r.fromNew),
    positionSec: r.positionSec ?? undefined,
  }
}

// ---- kv helpers (settings, budget, lastRefresh) ----

function kvGet<T>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as T) : undefined
}

function kvSet(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  )
}

// Enrichment v1 read every EU consent redirect as "not a Short", so all stored
// isShort values are suspect. Clear them once; the next refreshes re-enrich.
if ((kvGet<number>('enrichVersion') ?? 1) < 2) {
  db.exec('UPDATE videos SET isShort = NULL, durationSec = NULL, enrichedAt = NULL')
  kvSet('enrichVersion', 2)
}

function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function getSettings(): Settings {
  const stored = kvGet<Partial<Settings>>('settings') ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    dailyBudget: { ...DEFAULT_SETTINGS.dailyBudget, ...(stored.dailyBudget ?? {}) },
  }
}

export function setSettings(s: Settings): Settings {
  kvSet('settings', s)
  return getSettings()
}

export function getBudget(): BudgetUsage {
  const key = todayKey()
  const stored = kvGet<BudgetUsage>('budget')
  if (stored?.date === key) return stored
  return { date: key, count: 0, minutes: 0 }
}

export function overrideBudget(): BudgetUsage {
  const usage = { ...getBudget(), overridden: true }
  kvSet('budget', usage)
  return usage
}

// ---- channels ----

export function listChannels(): Channel[] {
  return db.prepare('SELECT id, title, addedAt FROM channels ORDER BY addedAt DESC').all() as unknown as Channel[]
}

export function getChannel(id: string): Channel | undefined {
  return db.prepare('SELECT id, title, addedAt FROM channels WHERE id = ?').get(id) as Channel | undefined
}

export function addChannel(c: Channel): void {
  db.prepare('INSERT OR IGNORE INTO channels(id, title, addedAt) VALUES(?, ?, ?)').run(c.id, c.title, c.addedAt)
}

export function removeChannel(id: string): void {
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  // Keep videos the user saved to Watch later or a playlist.
  db.prepare(
    `DELETE FROM videos WHERE channelId = ?
       AND videoId NOT IN (SELECT videoId FROM queue)
       AND videoId NOT IN (SELECT videoId FROM playlist_items)`,
  ).run(id)
  db.exec('DELETE FROM watch WHERE videoId NOT IN (SELECT videoId FROM videos)')
}

export function countChannels(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM channels').get() as { n: number }).n
}

/**
 * Keep the database (and the state snapshot every client mirrors) from growing
 * forever: drop videos published over a year ago unless they're saved in Watch
 * later or a playlist.
 */
export function pruneOldVideos(maxAgeMs = 365 * 24 * 3600 * 1000): void {
  db.prepare(
    `DELETE FROM videos WHERE publishedAt < ?
       AND videoId NOT IN (SELECT videoId FROM queue)
       AND videoId NOT IN (SELECT videoId FROM playlist_items)`,
  ).run(Date.now() - maxAgeMs)
  // A quiet channel's feed can still list a year-old video, which then comes
  // back on the next refresh. Keep "watched" marks so it doesn't return as new.
  db.exec(`DELETE FROM watch WHERE status = 'new' AND videoId NOT IN (SELECT videoId FROM videos)`)
}

// ---- videos ----

export function listVideos(): Video[] {
  const rows = db.prepare('SELECT * FROM videos ORDER BY publishedAt DESC').all() as unknown as VideoRow[]
  return rows.map(toVideo)
}

/** Insert new videos; for existing ones refresh display fields but keep enrichment. */
export function upsertVideos(videos: Video[]): void {
  const insert = db.prepare(
    `INSERT INTO videos(videoId, channelId, channelTitle, title, thumbnailUrl, publishedAt, isShort)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(videoId) DO UPDATE SET
       channelTitle = excluded.channelTitle,
       title = excluded.title,
       thumbnailUrl = excluded.thumbnailUrl,
       publishedAt = excluded.publishedAt,
       isShort = COALESCE(excluded.isShort, videos.isShort)`,
  )
  const ensureWatch = db.prepare(`INSERT OR IGNORE INTO watch(videoId, status) VALUES(?, 'new')`)
  tx(() => {
    for (const v of videos) {
      insert.run(v.videoId, v.channelId, v.channelTitle, v.title, v.thumbnailUrl, v.publishedAt, bool(v.isShort))
      ensureWatch.run(v.videoId)
    }
  })
}

export function videoExists(videoId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM videos WHERE videoId = ?').get(videoId))
}

export function listPendingEnrichment(limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT v.videoId FROM videos v
       JOIN channels c ON c.id = v.channelId
       WHERE v.enrichedAt IS NULL
       ORDER BY v.publishedAt DESC
       LIMIT ?`,
    )
    .all(limit) as { videoId: string }[]
  return rows.map((r) => r.videoId)
}

/**
 * Channels with recent non-Short videos whose length is still unknown. Their
 * video list page fills those in (the per-video watch page often comes back
 * without a length from datacenter IPs).
 */
export function listChannelsMissingDurations(sinceMs: number, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT v.channelId, MAX(v.publishedAt) AS newest FROM videos v
       JOIN channels c ON c.id = v.channelId
       WHERE v.durationSec IS NULL AND (v.isShort IS NULL OR v.isShort = 0) AND v.publishedAt >= ?
       GROUP BY v.channelId
       ORDER BY newest DESC
       LIMIT ?`,
    )
    .all(sinceMs, limit) as { channelId: string }[]
  return rows.map((r) => r.channelId)
}

export function countMissingDurations(channelId: string, sinceMs: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM videos
       WHERE channelId = ? AND durationSec IS NULL AND (isShort IS NULL OR isShort = 0) AND publishedAt >= ?`,
    )
    .get(channelId, sinceMs) as { n: number }
  return row.n
}

/** Fill in lengths that are still unknown; known lengths are left alone. */
export function setDurations(channelId: string, lengths: Map<string, number>): void {
  const update = db.prepare(
    'UPDATE videos SET durationSec = ? WHERE videoId = ? AND channelId = ? AND durationSec IS NULL',
  )
  tx(() => {
    for (const [videoId, sec] of lengths) update.run(sec, videoId, channelId)
  })
}

export function setEnrichment(videoId: string, durationSec: number | null, isShort: boolean | null): void {
  // The feed's /shorts/ link is authoritative, and a length already known (from
  // the channel's video list) is kept; the page probe only fills gaps.
  db.prepare(
    'UPDATE videos SET durationSec = COALESCE(?, durationSec), isShort = COALESCE(isShort, ?), enrichedAt = ? WHERE videoId = ?',
  ).run(durationSec, bool(isShort), Date.now(), videoId)
}

// ---- watch state + queue ----

export function listWatch(): WatchState[] {
  return (db.prepare('SELECT * FROM watch').all() as unknown as WatchRow[]).map(toWatch)
}

function getWatch(videoId: string): WatchRow | undefined {
  return db.prepare('SELECT * FROM watch WHERE videoId = ?').get(videoId) as unknown as WatchRow | undefined
}

/** Mark watched, applying the budget rule (US-04, US-07) and clearing the resume point. */
export function setWatched(videoId: string): { watch: WatchState; budget: BudgetUsage } {
  const prev = getWatch(videoId)
  const fromNew = !prev || prev.status === 'new'
  db.prepare(
    `INSERT INTO watch(videoId, status, watchedAt, fromNew, positionSec)
     VALUES(?, 'watched', ?, ?, NULL)
     ON CONFLICT(videoId) DO UPDATE SET
       status = 'watched', watchedAt = excluded.watchedAt, fromNew = excluded.fromNew, positionSec = NULL`,
  ).run(videoId, Date.now(), bool(fromNew))

  let budget = getBudget()
  if (fromNew) {
    const video = db.prepare('SELECT durationSec FROM videos WHERE videoId = ?').get(videoId) as
      { durationSec: number | null } | undefined
    budget = {
      ...budget,
      count: budget.count + 1,
      minutes: budget.minutes + (video?.durationSec ? video.durationSec / 60 : 0),
    }
    kvSet('budget', budget)
  }
  return { watch: toWatch(getWatch(videoId)!), budget }
}

export function setUnwatched(videoId: string): WatchState {
  db.prepare(
    `INSERT INTO watch(videoId, status) VALUES(?, 'new')
     ON CONFLICT(videoId) DO UPDATE SET status = 'new'`,
  ).run(videoId)
  return toWatch(getWatch(videoId)!)
}

export function setPosition(videoId: string, positionSec: number): void {
  const prev = getWatch(videoId)
  if (prev?.status === 'watched') return // finished videos don't track a resume point
  db.prepare(
    `INSERT INTO watch(videoId, status, positionSec) VALUES(?, 'new', ?)
     ON CONFLICT(videoId) DO UPDATE SET positionSec = excluded.positionSec`,
  ).run(videoId, positionSec)
}

export function listQueue(): QueueItem[] {
  const rows = db.prepare('SELECT videoId, ord, addedAt FROM queue ORDER BY ord').all() as {
    videoId: string
    ord: number
    addedAt: number
  }[]
  return rows.map((r) => ({ videoId: r.videoId, order: r.ord, addedAt: r.addedAt }))
}

export function addToQueue(videoId: string): QueueItem[] {
  const max = db.prepare('SELECT MAX(ord) AS m FROM queue').get() as { m: number | null }
  db.prepare('INSERT OR IGNORE INTO queue(videoId, ord, addedAt) VALUES(?, ?, ?)').run(
    videoId,
    (max.m ?? 0) + 1,
    Date.now(),
  )
  return listQueue()
}

export function removeFromQueue(videoId: string): QueueItem[] {
  db.prepare('DELETE FROM queue WHERE videoId = ?').run(videoId)
  return listQueue()
}

// ---- playlists ----

export function listPlaylists(): Playlist[] {
  return db.prepare('SELECT id, name, createdAt FROM playlists ORDER BY createdAt').all() as unknown as Playlist[]
}

export function listPlaylistItems(): PlaylistItem[] {
  const rows = db.prepare('SELECT playlistId, videoId, ord, addedAt FROM playlist_items ORDER BY ord').all() as {
    playlistId: number
    videoId: string
    ord: number
    addedAt: number
  }[]
  return rows.map((r) => ({ playlistId: r.playlistId, videoId: r.videoId, order: r.ord, addedAt: r.addedAt }))
}

export function createPlaylist(name: string): Playlist {
  const now = Date.now()
  const { lastInsertRowid } = db.prepare('INSERT INTO playlists(name, createdAt) VALUES(?, ?)').run(name, now)
  return { id: Number(lastInsertRowid), name, createdAt: now }
}

export function renamePlaylist(id: number, name: string): void {
  db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, id)
}

export function deletePlaylist(id: number): void {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
}

export function playlistExists(id: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id))
}

export function addToPlaylist(playlistId: number, videoId: string): void {
  const max = db.prepare('SELECT MAX(ord) AS m FROM playlist_items WHERE playlistId = ?').get(playlistId) as {
    m: number | null
  }
  db.prepare('INSERT OR IGNORE INTO playlist_items(playlistId, videoId, ord, addedAt) VALUES(?, ?, ?, ?)').run(
    playlistId,
    videoId,
    (max.m ?? 0) + 1,
    Date.now(),
  )
}

export function removeFromPlaylist(playlistId: number, videoId: string): void {
  db.prepare('DELETE FROM playlist_items WHERE playlistId = ? AND videoId = ?').run(playlistId, videoId)
}

export function getPlaylistState(): Pick<StateSnapshot, 'playlists' | 'playlistItems'> {
  return { playlists: listPlaylists(), playlistItems: listPlaylistItems() }
}

// ---- snapshot ----

export function getLastRefresh(): number | null {
  return kvGet<number>('lastRefresh') ?? null
}

export function setLastRefresh(ts: number): void {
  kvSet('lastRefresh', ts)
}

export function getSnapshot(): StateSnapshot {
  return {
    channels: listChannels(),
    videos: listVideos(),
    watch: listWatch(),
    queue: listQueue(),
    playlists: listPlaylists(),
    playlistItems: listPlaylistItems(),
    settings: getSettings(),
    budget: getBudget(),
    lastRefresh: getLastRefresh(),
  }
}
