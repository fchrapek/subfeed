import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Video } from '../../shared/types'
import { db, getSettings } from '../db'
import { markWatched, resumeAt, savePosition } from '../store'
import { formatDuration } from '../lib/format'
import { popLayer, pushLayer } from '../lib/layers'
import { useSheet } from './Sheet'

interface PlayerCtx {
  /** Play one video, or play through `list` starting at `v` (playlists only). */
  play: (v: Video, list?: Video[]) => void
}
const Ctx = createContext<PlayerCtx>({ play: () => {} })
export const usePlayer = () => useContext(Ctx)

declare global {
  interface Window {
    YT?: { Player: new (...args: unknown[]) => YTPlayer; PlayerState: { ENDED: number } }
    onYouTubeIframeAPIReady?: () => void
  }
}

interface YTPlayer {
  destroy?: () => void
  loadVideoById?: (opts: { videoId: string; startSeconds?: number }) => void
  getDuration?: () => number
  getCurrentTime?: () => number
}

let apiPromise: Promise<NonNullable<Window['YT']>> | null = null
export function loadYT(): Promise<NonNullable<Window['YT']>> {
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT)
    window.onYouTubeIframeAPIReady = () => resolve(window.YT!)
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    // Offline at launch must not poison every later play: let the next call retry.
    tag.onerror = () => {
      apiPromise = null
      tag.remove()
      reject(new Error('Could not reach YouTube. Check your connection and try again.'))
    }
    document.head.appendChild(tag)
  })
  return apiPromise
}

interface Playing {
  video: Video
  list?: Video[]
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [playing, setPlaying] = useState<Playing | null>(null)
  const isOpen = useRef(false)

  // Load the IFrame API ahead of the first tap, so the player can start inside
  // the tap's user activation (iOS refuses autoplay once that has lapsed).
  useEffect(() => {
    const id = setTimeout(() => void loadYT().catch(() => {}), 1500)
    return () => clearTimeout(id)
  }, [])

  const play = useCallback((video: Video, list?: Video[]) => {
    if (!isOpen.current) {
      isOpen.current = true
      pushLayer(() => {
        isOpen.current = false
        setPlaying(null)
      })
    }
    setPlaying({ video, list })
  }, [])

  return (
    <Ctx.Provider value={{ play }}>
      {children}
      {playing && (
        <PlayerSheet
          video={playing.video}
          list={playing.list}
          onNext={(next) => setPlaying({ video: next, list: playing.list })}
        />
      )}
    </Ctx.Provider>
  )
}

function PlayerSheet({ video, list, onNext }: { video: Video; list?: Video[]; onNext: (v: Video) => void }) {
  const { openPlaylistPicker } = useSheet()
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-video tracking. One YT.Player serves the whole session: on iOS sound needs
  // a tap inside the frame, and a fresh iframe per video would ask for it each time.
  const current = useRef(video.videoId)
  const done = useRef(false) // watched -> stop tracking a resume point
  const lastTime = useRef(0)
  const tick = useRef(0)

  const idx = list ? list.findIndex((v) => v.videoId === video.videoId) : -1
  const next = idx >= 0 ? list![idx + 1] : undefined

  // Playlists play through; everything else returns to the list (no autoplay-next).
  // Read through a ref, so the player's event handler always sees the current video.
  const finishRef = useRef<() => void>(() => {})
  finishRef.current = () => {
    if (next) onNext(next)
    else popLayer()
  }

  const leaveCurrent = () => {
    // Capture the exact spot (e.g. an accidental dismiss or skipping ahead).
    if (!done.current && lastTime.current >= 1) void savePosition(current.current, lastTime.current)
  }

  // Build the player once per open.
  useEffect(() => {
    let cancelled = false
    let poll: ReturnType<typeof setInterval> | undefined

    void (async () => {
      let YT: NonNullable<Window['YT']>
      try {
        YT = await loadYT()
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
        return
      }
      const [settings, w] = await Promise.all([getSettings(), db.watch.get(current.current)])
      if (cancelled || !hostRef.current) return

      playerRef.current = new YT.Player(hostRef.current, {
        videoId: current.current,
        host: 'https://www.youtube-nocookie.com',
        // rel=0 limits related to the same channel; we never render related UI ourselves.
        // start resumes an accidentally-closed video where it left off.
        playerVars: { rel: 0, autoplay: 1, playsinline: 1, start: resumeAt(w) },
        events: {
          onStateChange: (e: { data: number }) => {
            if (e.data === YT.PlayerState.ENDED) {
              done.current = true
              void markWatched(current.current)
              finishRef.current()
            }
          },
        },
      })

      poll = setInterval(() => {
        const p = playerRef.current
        if (!p || done.current || !p.getDuration) return
        const dur = p.getDuration() || 0
        const cur = p.getCurrentTime?.() ?? 0
        lastTime.current = cur
        if (dur > 0 && (cur / dur) * 100 >= settings.watchedThresholdPct) {
          done.current = true
          void markWatched(current.current)
          return
        }
        // Persist the resume point every ~5s while playing.
        tick.current = (tick.current + 1) % 5
        if (tick.current === 0 && cur >= 1) void savePosition(current.current, cur)
      }, 1000)
    })()

    return () => {
      cancelled = true
      if (poll) clearInterval(poll)
      leaveCurrent()
      try {
        playerRef.current?.destroy?.()
      } catch {
        /* player may already be torn down */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Next video in a playlist: reuse the same player.
  useEffect(() => {
    if (video.videoId === current.current) return
    leaveCurrent()
    current.current = video.videoId
    done.current = false
    lastTime.current = 0
    tick.current = 0
    void db.watch.get(video.videoId).then((w) => {
      playerRef.current?.loadVideoById?.({ videoId: video.videoId, startSeconds: resumeAt(w) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.videoId])

  // The page behind stays put while the player is open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const watchedNow = () => {
    done.current = true
    void markWatched(video.videoId)
    finishRef.current()
  }

  return (
    <div className="player" role="dialog" aria-modal="true" aria-label={video.title}>
      <div className="player-top">
        <button className="icon-btn" onClick={popLayer} aria-label="Back">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
        {list && idx >= 0 && (
          <span className="player-pos">
            {idx + 1} / {list.length}
          </span>
        )}
      </div>
      <div className="player-frame">
        <div ref={hostRef} />
        {error && <p className="player-error">{error}</p>}
      </div>
      <div className="player-info">
        <h1 className="player-title">{video.title}</h1>
        <div className="player-sub">
          {video.channelTitle}
          {video.durationSec != null && ` · ${formatDuration(video.durationSec)}`}
        </div>
        <div className="player-actions">
          <button className="btn" onClick={watchedNow}>
            ✓ Watched
          </button>
          <button className="btn" onClick={() => openPlaylistPicker(video)}>
            + Save
          </button>
        </div>
        {next && (
          <button className="up-next" onClick={() => onNext(next)}>
            <img src={next.thumbnailUrl} alt="" />
            <span>
              <span className="up-next-label">Next</span>
              <span className="up-next-title">{next.title}</span>
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
