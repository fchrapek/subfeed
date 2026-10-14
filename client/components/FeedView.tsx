import { useLiveQuery } from 'dexie-react-hooks'
import { DEFAULT_SETTINGS, db } from '../db'
import type { BudgetUsage, Settings, Video } from '../../shared/types'
import {
  addToQueue,
  budgetStatus,
  getBudgetUsage,
  isHidden,
  markWatched,
  overrideBudgetToday,
  resumeAt,
} from '../store'
import { VideoCard } from './VideoCard'
import { useSheet } from './Sheet'
import { InstallHint } from './InstallHint'

export function FeedView() {
  const { toast } = useSheet()
  const data = useLiveQuery(async () => {
    const [videos, watch, channels, settingsRow, usage] = await Promise.all([
      db.videos.orderBy('publishedAt').reverse().toArray(),
      db.watch.toArray(),
      db.channels.toArray(),
      db.kv.get('settings'),
      getBudgetUsage(),
    ])
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...(settingsRow?.value as Partial<Settings>),
    }
    return { videos, watch, channels, settings, usage }
  })

  if (!data) return <p className="muted">Loading…</p>

  const { videos, watch, channels, settings, usage } = data
  const watchById = new Map(watch.map((w) => [w.videoId, w]))
  const watchedIds = new Set(watch.filter((w) => w.status === 'watched').map((w) => w.videoId))
  const channelIds = new Set(channels.map((c) => c.id))

  const unwatched: Video[] = videos.filter(
    (v) => channelIds.has(v.channelId) && !watchedIds.has(v.videoId) && !isHidden(v, settings),
  )
  const limit = Math.max(1, settings.feedLimit)
  const feed = unwatched.slice(0, limit)

  if (channels.length === 0) {
    return <Empty title="No channels yet" body="Add a channel from the Channels tab to start building your feed." />
  }

  const budget = budgetStatus(usage as BudgetUsage, settings)
  if (budget.blocked) {
    return <BudgetBlock used={budget.used} limit={budget.limit} unit={budget.unit} />
  }

  if (feed.length === 0) {
    return <Empty title="Nothing new 🎉" body="You're all caught up. Check back after the next refresh." />
  }

  return (
    <div className="feed">
      {feed.map((v) => (
        <VideoCard
          key={v.videoId}
          video={v}
          resumeSec={resumeAt(watchById.get(v.videoId))}
          actions={[
            { label: 'Mark watched', onSelect: () => markWatched(v.videoId) },
            {
              label: 'Watch later',
              onSelect: async () => {
                await addToQueue(v.videoId)
                toast('Added to Watch later')
              },
            },
          ]}
        />
      ))}
      {unwatched.length > limit && (
        <p className="feed-end muted">That's your {limit}. More show up as you clear these.</p>
      )}
      <InstallHint />
    </div>
  )
}

function BudgetBlock({ used, limit, unit }: { used: number; limit: number; unit: string }) {
  return (
    <div className="block">
      <h2>Done for today ✋</h2>
      <p className="muted">
        You've reached your daily budget of {limit} {unit === 'count' ? 'videos' : 'minutes'} (watched {used}).
      </p>
      <p className="muted">Closing the tab here is the whole point — but you can keep going if you mean to.</p>
      <button className="btn" onClick={() => overrideBudgetToday()}>
        Continue anyway
      </button>
    </div>
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="block">
      <h2>{title}</h2>
      <p className="muted">{body}</p>
    </div>
  )
}
