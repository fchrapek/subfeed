import { useEffect, useState } from 'react'

// One-time nudge to put Subfeed on the home screen. iOS has no install prompt,
// so it gets instructions; Chrome hands us a prompt we can trigger.

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferred = e as InstallPromptEvent
  listeners.forEach((l) => l())
})

const DISMISS_KEY = 'subfeed.installHintDismissed'

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function useInstallPrompt() {
  const [canPrompt, setCanPrompt] = useState(Boolean(deferred))
  useEffect(() => {
    const l = () => setCanPrompt(Boolean(deferred))
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  const install = async () => {
    await deferred?.prompt()
    deferred = null
    setCanPrompt(false)
  }
  return { canPrompt, install }
}

export function InstallHint() {
  const [dismissed, setDismissed] = useState(wasDismissed)
  const { canPrompt, install } = useInstallPrompt()

  if (dismissed || isStandalone() || (!isIOS() && !canPrompt)) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* private mode: the hint just comes back next time */
    }
    setDismissed(true)
  }

  return (
    <div className="install-hint">
      <div>
        <strong>Put Subfeed on your home screen</strong>
        <p className="muted">
          {isIOS() ? (
            <>
              Tap <b>Share</b>, then <b>Add to Home Screen</b>. It opens full screen, like an app.
            </>
          ) : (
            'It opens full screen, like an app.'
          )}
        </p>
      </div>
      <div className="install-actions">
        {canPrompt && (
          <button className="btn primary" onClick={install}>
            Install
          </button>
        )}
        <button className="btn ghost" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  )
}
