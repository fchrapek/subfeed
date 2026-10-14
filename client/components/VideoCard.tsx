import type { Video } from '../../shared/types'
import { formatDuration, timeAgo } from '../lib/format'
import { usePlayer } from './Player'
import { useSheet, type CardAction } from './Sheet'

export function VideoCard({
  video,
  actions,
  resumeSec = 0,
  watched = false,
  list,
}: {
  video: Video
  actions: CardAction[]
  resumeSec?: number
  watched?: boolean
  // When set, the player treats these as a playlist and plays through them.
  list?: Video[]
}) {
  const { play } = usePlayer()
  const { openActions } = useSheet()
  const more = () => openActions(video, actions)

  return (
    <article
      className={`card${watched ? ' watched' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        more()
      }}
    >
      <button className="card-main" onClick={() => play(video, list)}>
        <span className="thumb">
          <img src={video.thumbnailUrl} alt="" loading="lazy" draggable={false} />
          {resumeSec > 0 && <span className="resume">↺ {formatDuration(resumeSec)}</span>}
          {video.durationSec != null && <span className="dur">{formatDuration(video.durationSec)}</span>}
        </span>
        <span className="card-text">
          <span className="card-title">{video.title}</span>
          <span className="card-sub">
            {video.channelTitle} · {watched ? 'watched' : timeAgo(video.publishedAt)}
          </span>
        </span>
      </button>
      <button className="card-more" onClick={more} aria-label="More actions">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <circle cx="12" cy="5" r="2" fill="currentColor" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
          <circle cx="12" cy="19" r="2" fill="currentColor" />
        </svg>
      </button>
    </article>
  )
}
