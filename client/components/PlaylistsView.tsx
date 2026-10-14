import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Video, WatchState } from '../../shared/types'
import { db } from '../db'
import { popLayer, pushLayer } from '../lib/layers'
import {
  createPlaylist,
  deletePlaylist,
  markUnwatched,
  markWatched,
  removeFromPlaylist,
  removeFromQueue,
  renamePlaylist,
  resumeAt,
} from '../store'
import { usePlayer } from './Player'
import type { CardAction } from './Sheet'
import { VideoCard } from './VideoCard'

// Watch later and History are built-in lists; the rest are the user's own playlists.
type ListId = 'later' | 'history' | number

const HISTORY_LIMIT = 100

export function PlaylistsView() {
  const [open, setOpen] = useState<ListId | null>(null)

  const openList = (id: ListId) => {
    pushLayer(() => setOpen(null))
    setOpen(id)
    window.scrollTo(0, 0)
  }

  return open == null ? <Overview onOpen={openList} /> : <ListDetail id={open} />
}

function Overview({ onOpen }: { onOpen: (id: ListId) => void }) {
  const data = useLiveQuery(async () => {
    const [playlists, items, queueCount] = await Promise.all([
      db.playlists.orderBy('createdAt').toArray(),
      db.playlistItems.toArray(),
      db.queue.count(),
    ])
    const counts = new Map<number, number>()
    for (const i of items) counts.set(i.playlistId, (counts.get(i.playlistId) ?? 0) + 1)
    return { playlists, counts, queueCount }
  })
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = name.trim()
    if (!value) return
    try {
      await createPlaylist(value)
      setName('')
      setNaming(false)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!data) return <p className="muted">Loading…</p>

  return (
    <div className="lists">
      <ListRow title="Watch later" sub={videosLabel(data.queueCount)} onClick={() => onOpen('later')} />
      {data.playlists.map((p) => (
        <ListRow key={p.id} title={p.name} sub={videosLabel(data.counts.get(p.id) ?? 0)} onClick={() => onOpen(p.id)} />
      ))}
      {naming ? (
        <form className="list-new" onSubmit={create}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Playlist name"
            enterKeyHint="done"
            maxLength={80}
          />
          <button className="btn primary" type="submit" disabled={!name.trim()}>
            Create
          </button>
          <button className="btn ghost" type="button" onClick={() => setNaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="list-row add" onClick={() => setNaming(true)}>
          + New playlist
        </button>
      )}
      {error && <p className="error">{error}</p>}
      <ListRow title="History" sub="Videos you finished" onClick={() => onOpen('history')} />
    </div>
  )
}

const videosLabel = (n: number) => (n === 1 ? '1 video' : `${n} videos`)

function ListRow({ title, sub, onClick }: { title: string; sub: string; onClick: () => void }) {
  return (
    <button className="list-row" onClick={onClick}>
      <span>
        <span className="list-title">{title}</span>
        <span className="list-sub">{sub}</span>
      </span>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  )
}

interface Entry {
  video: Video
  watch: WatchState | undefined
}

async function loadEntries(id: ListId): Promise<{ name: string; entries: Entry[] } | null> {
  let name: string
  let videoIds: string[]
  if (id === 'later') {
    name = 'Watch later'
    videoIds = (await db.queue.orderBy('order').toArray()).map((q) => q.videoId)
  } else if (id === 'history') {
    name = 'History'
    const watched = await db.watch.where('status').equals('watched').toArray()
    videoIds = watched
      .sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))
      .slice(0, HISTORY_LIMIT)
      .map((w) => w.videoId)
  } else {
    const playlist = await db.playlists.get(id)
    if (!playlist) return null
    name = playlist.name
    const items = await db.playlistItems.where('playlistId').equals(id).toArray()
    videoIds = items.sort((a, b) => a.order - b.order).map((i) => i.videoId)
  }
  const [videos, watch] = await Promise.all([db.videos.bulkGet(videoIds), db.watch.bulkGet(videoIds)])
  const entries = videoIds
    .map((_, i) => ({ video: videos[i], watch: watch[i] }))
    .filter((e): e is Entry => Boolean(e.video))
  return { name, entries }
}

function ListDetail({ id }: { id: ListId }) {
  const { play } = usePlayer()
  const data = useLiveQuery(() => loadEntries(id), [id])
  const custom = typeof id === 'number'

  if (data === undefined) return <p className="muted">Loading…</p>
  if (data === null) {
    // The playlist was deleted (here or on another device).
    return (
      <div className="block">
        <h2>Playlist not found</h2>
        <button className="btn" onClick={popLayer}>
          Back
        </button>
      </div>
    )
  }

  const { name, entries } = data
  const isWatched = (e: Entry) => e.watch?.status === 'watched'
  // Play through what's left; History is a record, so it plays one at a time.
  const playable = id === 'history' ? undefined : entries.filter((e) => !isWatched(e)).map((e) => e.video)

  const rename = async () => {
    const next = window.prompt('Rename playlist', name)?.trim()
    if (next && next !== name) await renamePlaylist(id as number, next)
  }

  const remove = async () => {
    if (!window.confirm(`Delete "${name}"? The videos stay in your feed and history.`)) return
    popLayer()
    await deletePlaylist(id as number)
  }

  const actionsFor = (e: Entry): CardAction[] => {
    const v = e.video
    const watchToggle: CardAction = isWatched(e)
      ? { label: 'Mark unwatched', onSelect: () => markUnwatched(v.videoId) }
      : { label: 'Mark watched', onSelect: () => markWatched(v.videoId) }
    if (id === 'later')
      return [
        watchToggle,
        { label: 'Remove from Watch later', onSelect: () => removeFromQueue(v.videoId), danger: true },
      ]
    if (id === 'history') return [watchToggle]
    return [
      watchToggle,
      { label: `Remove from ${name}`, onSelect: () => removeFromPlaylist(id, v.videoId), danger: true },
    ]
  }

  return (
    <div className="list-detail">
      <div className="list-head">
        <button className="icon-btn" onClick={popLayer} aria-label="Back to playlists">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
        <h2>{name}</h2>
        {playable && playable.length > 0 && (
          <button className="btn primary" onClick={() => play(playable[0], playable)}>
            ▶ Play
          </button>
        )}
      </div>
      {custom && (
        <div className="list-tools">
          <button className="btn ghost" onClick={rename}>
            Rename
          </button>
          <button className="btn ghost danger" onClick={remove}>
            Delete
          </button>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="block">
          <p className="muted">
            {id === 'history'
              ? 'Videos you finish (or mark watched) land here.'
              : 'Empty for now. Tap ⋯ on any video and choose Add to playlist.'}
          </p>
        </div>
      ) : (
        <div className="feed">
          {entries.map((e) => (
            <VideoCard
              key={e.video.videoId}
              video={e.video}
              watched={isWatched(e)}
              resumeSec={resumeAt(e.watch)}
              list={playable && !isWatched(e) ? playable : undefined}
              actions={actionsFor(e)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
