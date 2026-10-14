import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { addChannel, removeChannel } from '../store'

export function ChannelsView() {
  const channels = useLiveQuery(() => db.channels.orderBy('addedAt').reverse().toArray())
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = input.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await addChannel(value)
      setInput('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <form className="add-row" onSubmit={submit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Channel URL, @handle, or channel ID (UC…)"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      {!channels ? (
        <p className="muted">Loading…</p>
      ) : channels.length === 0 ? (
        <p className="muted">No channels yet. Paste one above to start your feed.</p>
      ) : (
        <ul className="channel-list">
          {channels.map((c) => (
            <li key={c.id}>
              <div>
                <div className="channel-title">{c.title}</div>
                <div className="channel-id">{c.id}</div>
              </div>
              <button className="btn ghost" onClick={() => removeChannel(c.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
