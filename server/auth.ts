import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { db } from './db'

// Single-user auth. One password, stored only as an scrypt hash in the
// environment. Logging in creates a random session token; the browser keeps it
// in an HttpOnly cookie and the database keeps only its SHA-256, so sessions
// can be listed, expired and revoked ("sign out everywhere"). Repeated wrong
// passwords lock the login with a growing delay that survives restarts.
//
// Config (both required; the server refuses to start without them):
//   SUBFEED_PASSWORD_HASH  output of `npm run hash-password`
//   SUBFEED_ORIGIN         the exact public origin, e.g. https://subfeed.example.com

const SESSION_IDLE_MS = 90 * 24 * 3600 * 1000 // unused for 90 days -> signed out
const SESSION_MAX_MS = 365 * 24 * 3600 * 1000 // and never older than a year
const SESSION_TOUCH_MS = 24 * 3600 * 1000 // extend at most once a day
const MAX_SESSIONS = 20
const FREE_FAILURES = 5
const MAX_LOCK_MS = 15 * 60 * 1000
const MAX_PASSWORD_BYTES = 1024
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/ // 32 random bytes, base64url

// ---- config ----------------------------------------------------------------

interface PasswordHash {
  N: number
  r: number
  p: number
  salt: Buffer
  key: Buffer
}

/** Format: scrypt:<N>:<r>:<p>:<salt hex>:<key hex>. No `$`, so .env files and compose leave it alone. */
export function parsePasswordHash(value: string): PasswordHash | null {
  const m = /^scrypt:(\d+):(\d+):(\d+):([0-9a-f]{32,}):([0-9a-f]{64,})$/.exec(value.trim())
  if (!m) return null
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null
  return { N, r, p, salt: Buffer.from(m[4], 'hex'), key: Buffer.from(m[5], 'hex') }
}

export interface AuthConfig {
  origin: string
  secure: boolean
  hash: PasswordHash
  rawHash: string
}

/** Validates the environment. Throws with a readable message instead of starting unprotected. */
export function loadAuthConfig(env = process.env): AuthConfig {
  const rawHash = env.SUBFEED_PASSWORD_HASH ?? ''
  const hash = parsePasswordHash(rawHash)
  if (!hash) {
    throw new Error('SUBFEED_PASSWORD_HASH is missing or malformed. Generate one with: npm run hash-password')
  }
  let url: URL
  try {
    url = new URL(env.SUBFEED_ORIGIN ?? '')
  } catch {
    throw new Error('SUBFEED_ORIGIN is missing. Set it to the public address, e.g. https://subfeed.example.com')
  }
  if (url.origin !== env.SUBFEED_ORIGIN) {
    throw new Error(`SUBFEED_ORIGIN must be a bare origin with no path or trailing slash, e.g. ${url.origin}`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('SUBFEED_ORIGIN must use https:// (plain http is only allowed for localhost).')
  }
  return { origin: url.origin, secure: url.protocol === 'https:', hash, rawHash: rawHash.trim() }
}

function verifyPassword(password: string, h: PasswordHash): Promise<boolean> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      h.salt,
      h.key.length,
      { N: h.N, r: h.r, p: h.p, maxmem: 256 * h.N * h.r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(timingSafeEqual(key, h.key))),
    ),
  )
}

// ---- storage ---------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL,
    lastSeenAt INTEGER NOT NULL,
    userAgent TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS auth_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    configHash TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    lockedUntil INTEGER NOT NULL DEFAULT 0
  );
`)

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface AuthState {
  failures: number
  lockedUntil: number
}

const getState = () =>
  db.prepare('SELECT failures, lockedUntil FROM auth_state WHERE id = 1').get() as unknown as AuthState
const setState = (s: AuthState) =>
  db.prepare('UPDATE auth_state SET failures = ?, lockedUntil = ? WHERE id = 1').run(s.failures, s.lockedUntil)

function pruneSessions(now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE lastSeenAt <= ? OR createdAt <= ?').run(
    now - SESSION_IDLE_MS,
    now - SESSION_MAX_MS,
  )
}

/** Call once at startup: a changed password hash signs every device out. */
function initState(config: AuthConfig) {
  const fingerprint = sha256(config.rawHash)
  const row = db.prepare('SELECT configHash FROM auth_state WHERE id = 1').get() as { configHash: string } | undefined
  if (!row) {
    db.prepare('INSERT INTO auth_state (id, configHash) VALUES (1, ?)').run(fingerprint)
  } else if (row.configHash !== fingerprint) {
    db.exec('DELETE FROM sessions')
    db.prepare('UPDATE auth_state SET configHash = ?, failures = 0, lockedUntil = 0 WHERE id = 1').run(fingerprint)
  }
  pruneSessions()
}

// ---- HTTP ------------------------------------------------------------------

export function createAuth(config: AuthConfig) {
  initState(config)
  const cookieName = config.secure ? '__Host-session' : 'subfeed-session'
  const cookieOpts = { path: '/', httpOnly: true, secure: config.secure, sameSite: 'Lax' as const }
  const startSession = (c: Context) => {
    const now = Date.now()
    const token = randomBytes(32).toString('base64url')
    pruneSessions(now)
    // Keep the newest MAX_SESSIONS - 1, making room for this one.
    db.prepare(
      `DELETE FROM sessions WHERE tokenHash IN
         (SELECT tokenHash FROM sessions ORDER BY lastSeenAt DESC LIMIT -1 OFFSET ?)`,
    ).run(MAX_SESSIONS - 1)
    db.prepare('INSERT INTO sessions (tokenHash, createdAt, lastSeenAt, userAgent) VALUES (?, ?, ?, ?)').run(
      sha256(token),
      now,
      now,
      (c.req.header('user-agent') ?? '').slice(0, 200),
    )
    setCookie(c, cookieName, token, { ...cookieOpts, maxAge: SESSION_IDLE_MS / 1000 })
  }

  /** Runs before every /api route: same-origin writes only, JSON bodies only. */
  const guardWrites: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (c.req.header('origin') !== config.origin) return c.json({ error: 'Cross-origin request refused' }, 403)
      // Bodies are JSON only. DELETE carries no body, so it may omit the header.
      const type = c.req.header('content-type') ?? ''
      const needsJson = c.req.method !== 'DELETE' || type !== ''
      if (needsJson && !/^application\/json(;|$)/i.test(type)) return c.json({ error: 'Send JSON' }, 415)
    }
    await next()
  }

  const requireSession: MiddlewareHandler = async (c, next) => {
    const token = getCookie(c, cookieName) ?? ''
    const now = Date.now()
    const row = TOKEN_RE.test(token)
      ? (db
          .prepare('SELECT lastSeenAt FROM sessions WHERE tokenHash = ? AND lastSeenAt > ? AND createdAt > ?')
          .get(sha256(token), now - SESSION_IDLE_MS, now - SESSION_MAX_MS) as { lastSeenAt: number } | undefined)
      : undefined
    if (!row) return c.json({ error: 'Signed out' }, 401)
    if (now - row.lastSeenAt > SESSION_TOUCH_MS) {
      db.prepare('UPDATE sessions SET lastSeenAt = ? WHERE tokenHash = ?').run(now, sha256(token))
      setCookie(c, cookieName, token, { ...cookieOpts, maxAge: SESSION_IDLE_MS / 1000 })
    }
    await next()
  }

  const routes = new Hono()
  let checking = false // one password check at a time; scrypt is deliberately slow

  routes.post('/login', async (c) => {
    // Read the body first. Everything from the lock check to `checking = true`
    // then runs without an await, so parallel requests can't all slip past it.
    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null
    const now = Date.now()
    const { lockedUntil } = getState()
    if (checking || now < lockedUntil) {
      const wait = Math.max(1, Math.ceil((lockedUntil - now) / 1000))
      c.header('Retry-After', String(wait))
      return c.json({ error: 'Too many attempts. Try again shortly.', retryAfterSec: wait }, 429)
    }
    const password = body?.password
    if (typeof password !== 'string' || !password || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
      return c.json({ error: 'Enter your password.' }, 400)
    }
    checking = true
    try {
      if (!(await verifyPassword(password, config.hash))) {
        const { failures } = db
          .prepare('UPDATE auth_state SET failures = failures + 1 WHERE id = 1 RETURNING failures')
          .get() as { failures: number }
        const lock = failures > FREE_FAILURES ? Math.min(MAX_LOCK_MS, 1000 * 2 ** (failures - FREE_FAILURES)) : 0
        if (lock) db.prepare('UPDATE auth_state SET lockedUntil = ? WHERE id = 1').run(Date.now() + lock)
        console.warn(`[auth] failed login (${failures} in a row)`)
        return c.json({ error: 'Wrong password.' }, 401)
      }
      setState({ failures: 0, lockedUntil: 0 })
      startSession(c)
      return c.json({ ok: true })
    } finally {
      checking = false
    }
  })

  routes.post('/logout', requireSession, (c) => {
    db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(sha256(getCookie(c, cookieName)!))
    deleteCookie(c, cookieName, cookieOpts)
    return c.json({ ok: true })
  })

  routes.post('/logout-all', requireSession, (c) => {
    db.exec('DELETE FROM sessions')
    deleteCookie(c, cookieName, cookieOpts)
    return c.json({ ok: true })
  })

  return { guardWrites, requireSession, routes }
}
