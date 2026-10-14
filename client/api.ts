import type { BudgetUsage, Playlist, QueueItem, Settings, StateSnapshot, WatchState } from '../shared/types'

type PlaylistState = Pick<StateSnapshot, 'playlists' | 'playlistItems'>

/** Fired when the server no longer recognises this device; App offers to sign in. */
export const SIGNED_OUT_EVENT = 'subfeed:signed-out'

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
  return data
}

const postJson = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ---- Auth ----

export class LoginError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message)
  }
}

/** Not routed through jsonOrThrow: a wrong password is a 401 that must not mean "signed out". */
export async function login(password: string): Promise<void> {
  const res = await postJson('/api/auth/login', { password })
  if (res.ok) return
  const data = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number }
  throw new LoginError(data.error ?? `Sign-in failed (${res.status})`, data.retryAfterSec)
}

export const logout = () => postJson('/api/auth/logout', {}).then((r) => jsonOrThrow<{ ok: true }>(r))
export const logoutAll = () => postJson('/api/auth/logout-all', {}).then((r) => jsonOrThrow<{ ok: true }>(r))

export const getState = () => fetch('/api/state').then((r) => jsonOrThrow<StateSnapshot>(r))

export const addChannel = (input: string) =>
  postJson('/api/channels', { input }).then((r) => jsonOrThrow<StateSnapshot>(r))

export const removeChannel = (id: string) =>
  fetch(`/api/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => jsonOrThrow<StateSnapshot>(r))

export const refresh = () => postJson('/api/refresh', {}).then((r) => jsonOrThrow<StateSnapshot>(r))

export const setWatched = (videoId: string) =>
  postJson('/api/watch/watched', { videoId }).then((r) => jsonOrThrow<{ watch: WatchState; budget: BudgetUsage }>(r))

export const setUnwatched = (videoId: string) =>
  postJson('/api/watch/unwatched', { videoId }).then((r) => jsonOrThrow<{ watch: WatchState }>(r))

export const setPosition = (videoId: string, positionSec: number) =>
  postJson('/api/watch/position', { videoId, positionSec }).then((r) => jsonOrThrow<unknown>(r))

export const addToQueue = (videoId: string) =>
  postJson('/api/queue', { videoId }).then((r) => jsonOrThrow<{ queue: QueueItem[] }>(r))

export const removeFromQueue = (videoId: string) =>
  fetch(`/api/queue/${encodeURIComponent(videoId)}`, { method: 'DELETE' }).then((r) =>
    jsonOrThrow<{ queue: QueueItem[] }>(r),
  )

export const createPlaylist = (name: string) =>
  postJson('/api/playlists', { name }).then((r) => jsonOrThrow<PlaylistState & { playlist: Playlist }>(r))

export const renamePlaylist = (id: number, name: string) =>
  fetch(`/api/playlists/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => jsonOrThrow<PlaylistState>(r))

export const deletePlaylist = (id: number) =>
  fetch(`/api/playlists/${id}`, { method: 'DELETE' }).then((r) => jsonOrThrow<PlaylistState>(r))

export const addToPlaylist = (id: number, videoId: string) =>
  postJson(`/api/playlists/${id}/items`, { videoId }).then((r) => jsonOrThrow<PlaylistState>(r))

export const removeFromPlaylist = (id: number, videoId: string) =>
  fetch(`/api/playlists/${id}/items/${encodeURIComponent(videoId)}`, { method: 'DELETE' }).then((r) =>
    jsonOrThrow<PlaylistState>(r),
  )

export const putSettings = (settings: Settings) =>
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  }).then((r) => jsonOrThrow<{ settings: Settings }>(r))

export const overrideBudget = () =>
  postJson('/api/budget/override', {}).then((r) => jsonOrThrow<{ budget: BudgetUsage }>(r))
