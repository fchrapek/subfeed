import { useEffect, useState } from 'react'
import { LoginError, login } from '../api'

export function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waitSec, setWaitSec] = useState(0)

  // Count down a lockout so the button comes back by itself.
  useEffect(() => {
    if (waitSec <= 0) return
    const id = setTimeout(() => setWaitSec((s) => s - 1), 1000)
    return () => clearTimeout(id)
  }, [waitSec])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password || busy || waitSec > 0) return
    setBusy(true)
    setError(null)
    try {
      await login(password)
      setPassword('')
      onSignedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.')
      if (err instanceof LoginError && err.retryAfterSec) setWaitSec(err.retryAfterSec)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Subfeed</h1>
        {/* A fixed username lets password managers (iCloud Keychain) save and fill this login. */}
        <input type="text" name="username" autoComplete="username" value="subfeed" readOnly hidden />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          enterKeyHint="go"
          autoFocus
        />
        <button className="btn primary" type="submit" disabled={busy || !password || waitSec > 0}>
          {busy ? 'Signing in…' : waitSec > 0 ? `Try again in ${waitSec}s` : 'Sign in'}
        </button>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  )
}
