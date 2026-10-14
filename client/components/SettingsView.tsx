import { useEffect, useRef, useState } from 'react'
import type { BudgetUnit, Settings } from '../../shared/types'
import { DEFAULT_SETTINGS, getSettings } from '../db'
import { SIGNED_OUT_EVENT, logout, logoutAll } from '../api'
import { updateSettings } from '../store'
import { isStandalone, useInstallPrompt } from './InstallHint'

// Changes save on their own, shortly after the last edit.
const SAVE_DELAY_MS = 600

export function SettingsView() {
  const [s, setS] = useState<Settings | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const { canPrompt, install } = useInstallPrompt()
  const [signOutError, setSignOutError] = useState<string | null>(null)

  useEffect(() => {
    // Older installs may hold values the server now rejects; start from valid ones.
    void getSettings().then((loaded) =>
      setS({ ...loaded, refreshIntervalMin: Math.min(1440, Math.max(5, loaded.refreshIntervalMin)) }),
    )
    return () => clearTimeout(timer.current)
  }, [])

  if (!s) return <p className="muted">Loading…</p>

  const commit = (next: Settings) => {
    setS(next)
    setStatus('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        await updateSettings(next)
        setStatus('saved')
      } catch {
        setStatus('error')
      }
    }, SAVE_DELAY_MS)
  }
  const update = (patch: Partial<Settings>) => commit({ ...s, ...patch })

  // Only a confirmed sign-out counts: offline, the server session would live on.
  // On success App wipes local data and shows the login.
  const signOut = async (call: () => Promise<unknown>) => {
    setSignOutError(null)
    try {
      await call()
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
    } catch {
      setSignOutError('Could not reach the server, so nothing was signed out. Try again when online.')
    }
  }

  // Empty or half-typed number fields keep the last valid value.
  const num = (value: string, min: number, max = Infinity) => {
    const n = Math.round(Number(value))
    return Number.isFinite(n) && value !== '' ? Math.min(max, Math.max(min, n)) : null
  }

  return (
    <div className="settings">
      <section className="group">
        <h3>Feed</h3>
        <label className="row">
          <span>
            Videos in New
            <small>How many the feed shows at once</small>
          </span>
          <NumberField
            value={s.feedLimit}
            onValue={(v) => {
              const n = num(v, 1, 500)
              if (n != null) update({ feedLimit: n })
            }}
          />
        </label>
        <label className="row switch">
          <span>Hide Shorts</span>
          <input
            type="checkbox"
            role="switch"
            checked={s.hideShorts}
            onChange={(e) => update({ hideShorts: e.target.checked })}
          />
        </label>
        <label className="row">
          <span>
            Minimum length
            <small>Seconds. Shorter videos are hidden</small>
          </span>
          <NumberField
            value={s.minDurationSec}
            onValue={(v) => {
              const n = num(v, 0, 86400)
              if (n != null) update({ minDurationSec: n })
            }}
          />
        </label>
        <label className="row">
          <span>
            Refresh every
            <small>Minutes, at least 5</small>
          </span>
          <NumberField
            value={s.refreshIntervalMin}
            onValue={(v) => {
              const n = num(v, 5, 1440)
              if (n != null) update({ refreshIntervalMin: n })
            }}
          />
        </label>
      </section>

      <section className="group">
        <h3>Watching</h3>
        <label className="row">
          <span>
            Counts as watched at
            <small>Percent played</small>
          </span>
          <NumberField
            value={s.watchedThresholdPct}
            onValue={(v) => {
              const n = num(v, 1, 100)
              if (n != null) update({ watchedThresholdPct: n })
            }}
          />
        </label>
        <div className="row">
          <span>
            Daily budget
            <small>0 turns it off</small>
          </span>
          <div className="budget-controls">
            <NumberField
              value={s.dailyBudget.value}
              onValue={(v) => {
                const n = num(v, 0, 1440)
                if (n != null) update({ dailyBudget: { ...s.dailyBudget, value: n } })
              }}
            />
            <select
              value={s.dailyBudget.unit}
              onChange={(e) => update({ dailyBudget: { ...s.dailyBudget, unit: e.target.value as BudgetUnit } })}
            >
              <option value="count">videos / day</option>
              <option value="minutes">minutes / day</option>
            </select>
          </div>
        </div>
      </section>

      {!isStandalone() && canPrompt && (
        <section className="group">
          <h3>App</h3>
          <div className="row">
            <span>Install Subfeed on this device</span>
            <button className="btn primary" onClick={install}>
              Install
            </button>
          </div>
        </section>
      )}

      <section className="group">
        <h3>Account</h3>
        <div className="row">
          <span>
            Sign out
            <small>This device only</small>
          </span>
          <button className="btn" onClick={() => void signOut(logout)}>
            Sign out
          </button>
        </div>
        <div className="row">
          <span>
            Sign out everywhere
            <small>Every phone and browser</small>
          </span>
          <button
            className="btn danger"
            onClick={() => window.confirm('Sign out on every device?') && void signOut(logoutAll)}
          >
            Sign out all
          </button>
        </div>
        {signOutError && <p className="error">{signOutError}</p>}
      </section>

      <div className="settings-footer">
        <button className="btn ghost" onClick={() => commit(DEFAULT_SETTINGS)}>
          Reset to defaults
        </button>
        <span className="muted" aria-live="polite">
          {status === 'saving'
            ? 'Saving…'
            : status === 'saved'
              ? 'Saved'
              : status === 'error'
                ? 'Could not save. Check your connection.'
                : ''}
        </span>
      </div>
    </div>
  )
}

/** Number input that lets you clear and retype without snapping back mid-edit. */
function NumberField({ value, onValue }: { value: number; onValue: (raw: string) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <input
      type="number"
      inputMode="numeric"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        onValue(e.target.value)
      }}
      onBlur={() => setDraft(String(value))}
    />
  )
}
