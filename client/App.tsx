import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings } from './db'
import { pullState, refreshAll, wipeLocal } from './store'
import { timeAgo } from './lib/format'
import { layerDepth, popLayer } from './lib/layers'
import { applyUpdate, UPDATE_READY_EVENT } from './lib/sw'
import { SIGNED_OUT_EVENT } from './api'
import { FeedView } from './components/FeedView'
import { PlaylistsView } from './components/PlaylistsView'
import { ChannelsView } from './components/ChannelsView'
import { SettingsView } from './components/SettingsView'
import { LoginView } from './components/LoginView'

type Tab = 'new' | 'playlists' | 'channels' | 'settings'

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  {
    id: 'new',
    label: 'New',
    icon: <path d="M4 5h16v11H4zM8 20h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  },
  {
    id: 'playlists',
    label: 'Playlists',
    icon: (
      <path
        d="M4 6h12M4 11h12M4 16h7M16 14v6l5-3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    ),
  },
  {
    id: 'channels',
    label: 'Channels',
    icon: (
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c1-4 4-6 8-6s7 2 8 6" strokeLinecap="round" />
      </g>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </g>
    ),
  },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('new')
  const [refreshing, setRefreshing] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [signedOut, setSignedOut] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)
  const refreshingRef = useRef(false)
  const signedOutRef = useRef(false)

  const lastRefresh = useLiveQuery(async () => (await db.kv.get('lastRefresh'))?.value as number | null | undefined)

  const doRefresh = async () => {
    if (refreshingRef.current || signedOutRef.current || !navigator.onLine) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      await refreshAll()
      // Server enriches (duration/Shorts) in the background — pull again shortly to catch it.
      setTimeout(() => void pullState().catch(() => {}), 6000)
    } catch {
      /* offline or server down: the local mirror keeps the last good state */
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }

  // Refresh when the app comes back to the foreground and the feed is stale.
  // An installed app is rarely reloaded, so this is what keeps it current.
  const refreshIfStale = async () => {
    const [settings, last] = await Promise.all([getSettings(), db.kv.get('lastRefresh')])
    const age = Date.now() - ((last?.value as number | null) ?? 0)
    if (age >= settings.refreshIntervalMin * 60_000) await doRefresh()
  }

  // Load the server snapshot first (fast, offline-safe), then refresh feeds.
  useEffect(() => {
    void pullState()
      .catch(() => {})
      .then(() => doRefresh())

    const onVisible = () => document.visibilityState === 'visible' && void refreshIfStale()
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    // The server no longer knows this device: drop the local copy and show the login.
    const onSignedOut = () => {
      // Wipe every time: a late response may have written something since.
      void wipeLocal()
      if (signedOutRef.current) return
      signedOutRef.current = true
      setSignedOut(true)
      while (layerDepth() > 0) popLayer()
    }
    const onUpdate = () => setUpdateReady(true)
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut)
    window.addEventListener(UPDATE_READY_EVENT, onUpdate)
    const id = setInterval(() => void refreshIfStale(), 60_000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut)
      window.removeEventListener(UPDATE_READY_EVENT, onUpdate)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectTab = (id: Tab) => {
    // Leaving a tab (or tapping the current one) closes an open playlist.
    if (layerDepth() > 0) popLayer()
    if (id !== tab) setTab(id)
    window.scrollTo(0, 0)
  }

  const title = TABS.find((t) => t.id === tab)!.label

  if (signedOut) {
    return (
      <LoginView
        onSignedIn={() => {
          signedOutRef.current = false
          setSignedOut(false)
          setTab('new')
          void pullState()
            .catch(() => {})
            .then(() => doRefresh())
        }}
      />
    )
  }

  return (
    <div className="app">
      <header className="top">
        <div className="top-title">
          <h1>{title}</h1>
          <span className="top-sub">
            {!online ? 'Offline' : refreshing ? 'Refreshing…' : lastRefresh ? `Updated ${timeAgo(lastRefresh)}` : ''}
          </span>
        </div>
        {updateReady && (
          <button className="pill" onClick={() => void applyUpdate(true)}>
            Update
          </button>
        )}
        <button
          className={`icon-btn${refreshing ? ' spinning' : ''}`}
          onClick={doRefresh}
          disabled={refreshing || !online}
          aria-label="Refresh"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      <main className="content">
        {tab === 'new' && <FeedView />}
        {tab === 'playlists' && <PlaylistsView />}
        {tab === 'channels' && <ChannelsView />}
        {tab === 'settings' && <SettingsView />}
      </main>

      <nav className="tabbar" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tabbar-item${tab === t.id ? ' active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => selectTab(t.id)}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
              {t.icon}
            </svg>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
