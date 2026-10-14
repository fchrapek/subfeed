// Tiny in-memory cache so repeated feed/meta fetches stay polite and fast.
// Not persisted; user-facing state lives in SQLite (server/db.ts).

interface Entry {
  value: unknown
  expires: number
}

const store = new Map<string, Entry>()
const MAX_ENTRIES = 5000

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expires > now) return hit.value as T
  const value = await fn()
  if (store.size >= MAX_ENTRIES) {
    for (const [k, e] of store) if (e.expires <= now) store.delete(k)
    // Still full of live entries: drop the oldest inserted.
    while (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value!)
  }
  store.set(key, { value, expires: ttlMs === Infinity ? Number.MAX_SAFE_INTEGER : now + ttlMs })
  return value
}
