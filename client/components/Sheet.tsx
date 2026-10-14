import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Video } from '../../shared/types'
import { db } from '../db'
import { popLayer, pushLayer } from '../lib/layers'
import { addToPlaylist, addToQueue, createPlaylist, removeFromPlaylist, removeFromQueue } from '../store'

export interface CardAction {
  label: string
  onSelect: () => void | Promise<void>
  danger?: boolean
}

type SheetState = { kind: 'actions'; video: Video; actions: CardAction[] } | { kind: 'playlists'; video: Video }

interface SheetApi {
  openActions: (video: Video, actions: CardAction[]) => void
  openPlaylistPicker: (video: Video) => void
  toast: (message: string) => void
}

const Ctx = createContext<SheetApi>({ openActions: () => {}, openPlaylistPicker: () => {}, toast: () => {} })
export const useSheet = () => useContext(Ctx)

export function SheetProvider({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const isOpen = useRef(false)

  // Swapping one sheet for another (actions -> playlist picker) reuses the open layer.
  const show = (next: SheetState) => {
    if (!isOpen.current) {
      isOpen.current = true
      pushLayer(() => {
        isOpen.current = false
        setSheet(null)
      })
    }
    setSheet(next)
  }

  const toast = (message: string) => {
    setToastMsg(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 1800)
  }

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (sheet && !d.open) d.showModal()
    if (!sheet && d.open) d.close()
  }, [sheet])

  // iOS lays the keyboard over the page instead of resizing it, so lift the
  // sheet by the keyboard's height while it is up.
  useEffect(() => {
    const vv = window.visualViewport
    const d = dialogRef.current
    if (!vv || !d || !sheet) return
    const place = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      d.style.setProperty('--kb', `${covered}px`)
    }
    place()
    vv.addEventListener('resize', place)
    vv.addEventListener('scroll', place)
    return () => {
      vv.removeEventListener('resize', place)
      vv.removeEventListener('scroll', place)
    }
  }, [sheet])

  const api: SheetApi = {
    openActions: (video, actions) => show({ kind: 'actions', video, actions }),
    openPlaylistPicker: (video) => show({ kind: 'playlists', video }),
    toast,
  }

  const toastEl = toastMsg && (
    <div className="toast" role="status">
      {toastMsg}
    </div>
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <dialog
        ref={dialogRef}
        className="sheet"
        onCancel={(e) => {
          e.preventDefault()
          popLayer()
        }}
        onClick={(e) => e.target === e.currentTarget && popLayer()}
      >
        <div className="sheet-body">
          {sheet?.kind === 'actions' && (
            <ActionList
              video={sheet.video}
              actions={sheet.actions}
              onPlaylists={() => show({ kind: 'playlists', video: sheet.video })}
            />
          )}
          {sheet?.kind === 'playlists' && <PlaylistPicker video={sheet.video} toast={toast} />}
        </div>
        {/* An open modal dialog sits above everything else, so the toast goes inside it. */}
        {sheet && toastEl}
      </dialog>
      {!sheet && toastEl}
    </Ctx.Provider>
  )
}

function SheetHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="sheet-head">
      <div className="sheet-grip" aria-hidden />
      <div className="sheet-title">{title}</div>
      {sub && <div className="sheet-sub">{sub}</div>}
    </div>
  )
}

function ActionList({ video, actions, onPlaylists }: { video: Video; actions: CardAction[]; onPlaylists: () => void }) {
  const run = async (a: CardAction) => {
    popLayer()
    await a.onSelect()
  }
  return (
    <>
      <SheetHeader title={video.title} sub={video.channelTitle} />
      <div className="sheet-list">
        {actions.map((a) => (
          <button key={a.label} className={`sheet-row${a.danger ? ' danger' : ''}`} onClick={() => run(a)}>
            {a.label}
          </button>
        ))}
        <button className="sheet-row" onClick={onPlaylists}>
          Add to playlist…
        </button>
        <a
          className="sheet-row"
          href={`https://www.youtube.com/watch?v=${video.videoId}`}
          target="_blank"
          rel="noreferrer"
          onClick={() => popLayer()}
        >
          Open on YouTube
        </a>
      </div>
      <button className="sheet-cancel" onClick={popLayer}>
        Cancel
      </button>
    </>
  )
}

function PlaylistPicker({ video, toast }: { video: Video; toast: (m: string) => void }) {
  const data = useLiveQuery(async () => {
    const [playlists, items, queued] = await Promise.all([
      db.playlists.orderBy('createdAt').toArray(),
      db.playlistItems.where('videoId').equals(video.videoId).toArray(),
      db.queue.get(video.videoId),
    ])
    return { playlists, inIds: new Set(items.map((i) => i.playlistId)), queued: Boolean(queued) }
  }, [video.videoId])
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  // Rows flip the moment they're tapped; the server catches up. Keys: 'later' or a playlist id.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map())

  const checked = (key: string, actual: boolean) => pending.get(key) ?? actual

  const flip = async (key: string, on: boolean, run: () => Promise<void>, label: string) => {
    if (pending.has(key)) return
    setPending((m) => new Map(m).set(key, on))
    try {
      await run()
      if (on) toast(`Added to ${label}`)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setPending((m) => {
        const copy = new Map(m)
        copy.delete(key)
        return copy
      })
    }
  }

  const toggleLater = () => {
    const on = !checked('later', data?.queued ?? false)
    void flip('later', on, () => (on ? addToQueue(video.videoId) : removeFromQueue(video.videoId)), 'Watch later')
  }

  const toggle = (id: number, label: string) => {
    const on = !checked(String(id), data?.inIds.has(id) ?? false)
    void flip(
      String(id),
      on,
      () => (on ? addToPlaylist(id, video.videoId) : removeFromPlaylist(id, video.videoId)),
      label,
    )
  }

  const guard = async (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault()
    const value = name.trim()
    if (!value) return
    void guard(async () => {
      const id = await createPlaylist(value)
      await addToPlaylist(id, video.videoId)
      setName('')
      setNaming(false)
      toast(`Added to ${value}`)
    })
  }

  return (
    <>
      <SheetHeader title="Save to…" sub={video.title} />
      <div className="sheet-list">
        {naming ? (
          <form className="sheet-new" onSubmit={create}>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Playlist name"
              enterKeyHint="done"
              maxLength={80}
            />
            <button className="btn" type="submit" disabled={busy || !name.trim()}>
              Create
            </button>
          </form>
        ) : (
          <button className="sheet-row accent" onClick={() => setNaming(true)}>
            + New playlist
          </button>
        )}
        <label className="sheet-row check">
          <input type="checkbox" checked={checked('later', data?.queued ?? false)} onChange={toggleLater} />
          <span>Watch later</span>
        </label>
        {data?.playlists.map((p) => (
          <label key={p.id} className="sheet-row check">
            <input
              type="checkbox"
              checked={checked(String(p.id), data.inIds.has(p.id))}
              onChange={() => toggle(p.id, p.name)}
            />
            <span>{p.name}</span>
          </label>
        ))}
      </div>
      <button className="sheet-cancel" onClick={popLayer}>
        Done
      </button>
    </>
  )
}
