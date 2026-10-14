import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'

// auth.ts opens the database on import, so point it at a throwaway file first.
process.env.SUBFEED_DB = join(mkdtempSync(join(tmpdir(), 'subfeed-auth-')), 'test.sqlite')
const { createAuth, loadAuthConfig, parsePasswordHash } = await import('./auth')

const ORIGIN = 'https://subfeed.example.com'
const PASSWORD = 'correct horse battery staple'

function hashFor(password: string): string {
  const N = 2 ** 14 // the minimum the parser accepts; keeps the tests fast
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, 32, { N, r: 8, p: 1 })
  return `scrypt:${N}:8:1:${salt.toString('hex')}:${key.toString('hex')}`
}

function makeApp(hash: string) {
  const auth = createAuth(loadAuthConfig({ SUBFEED_PASSWORD_HASH: hash, SUBFEED_ORIGIN: ORIGIN }))
  const app = new Hono()
  app.use('/api/*', auth.guardWrites)
  app.route('/api/auth', auth.routes)
  app.use('/api/*', auth.requireSession)
  app.get('/api/ping', (c) => c.text('pong'))
  app.post('/api/ping', (c) => c.text('pong'))
  return app
}

const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', ...extra },
  body: JSON.stringify(body),
})

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? ''

describe('loadAuthConfig', () => {
  const hash = hashFor(PASSWORD)
  it('accepts an https origin and a valid hash', () => {
    expect(loadAuthConfig({ SUBFEED_PASSWORD_HASH: hash, SUBFEED_ORIGIN: ORIGIN }).secure).toBe(true)
  })
  it('allows plain http only for localhost', () => {
    expect(loadAuthConfig({ SUBFEED_PASSWORD_HASH: hash, SUBFEED_ORIGIN: 'http://localhost:5173' }).secure).toBe(false)
    expect(() =>
      loadAuthConfig({ SUBFEED_PASSWORD_HASH: hash, SUBFEED_ORIGIN: 'http://subfeed.example.com' }),
    ).toThrow()
  })
  it('fails closed on missing or sloppy config', () => {
    expect(() => loadAuthConfig({ SUBFEED_ORIGIN: ORIGIN })).toThrow(/PASSWORD_HASH/)
    expect(() => loadAuthConfig({ SUBFEED_PASSWORD_HASH: hash })).toThrow(/ORIGIN/)
    expect(() => loadAuthConfig({ SUBFEED_PASSWORD_HASH: hash, SUBFEED_ORIGIN: `${ORIGIN}/` })).toThrow(/bare origin/)
    expect(() => loadAuthConfig({ SUBFEED_PASSWORD_HASH: 'plain-text-password', SUBFEED_ORIGIN: ORIGIN })).toThrow()
  })
  it('rejects weak scrypt parameters', () => {
    expect(parsePasswordHash(`scrypt:1024:8:1:${'a'.repeat(32)}:${'b'.repeat(64)}`)).toBeNull()
  })
})

describe('sessions', () => {
  let app: Hono
  let cookie: string
  beforeAll(() => {
    app = makeApp(hashFor(PASSWORD))
  })

  it('refuses the API without a session', async () => {
    expect((await app.request('/api/ping')).status).toBe(401)
  })

  it('rejects a wrong password', async () => {
    const res = await app.request('/api/auth/login', json({ password: 'nope' }))
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('signs in with the right password and sets a locked-down cookie', async () => {
    const res = await app.request('/api/auth/login', json({ password: PASSWORD }))
    expect(res.status).toBe(200)
    const raw = res.headers.get('set-cookie') ?? ''
    expect(raw).toMatch(/^__Host-session=[\w-]{43};/)
    expect(raw).toMatch(/HttpOnly/)
    expect(raw).toMatch(/Secure/)
    expect(raw).toMatch(/SameSite=Lax/)
    cookie = cookieOf(res)
    expect((await app.request('/api/ping', { headers: { cookie } })).status).toBe(200)
  })

  it('refuses a forged cookie', async () => {
    const forged = `__Host-session=${randomBytes(32).toString('base64url')}`
    expect((await app.request('/api/ping', { headers: { cookie: forged } })).status).toBe(401)
  })

  it('blocks writes from another origin and non-JSON bodies', async () => {
    const other = await app.request('/api/ping', json({}, { cookie, origin: 'https://evil.example.com' }))
    expect(other.status).toBe(403)
    const noOrigin = await app.request('/api/ping', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(noOrigin.status).toBe(403)
    const form = await app.request('/api/ping', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(form.status).toBe(415)
  })

  it('signs out this device', async () => {
    const res = await app.request('/api/auth/logout', json({}, { cookie }))
    expect(res.status).toBe(200)
    expect((await app.request('/api/ping', { headers: { cookie } })).status).toBe(401)
  })

  it('signs out everywhere', async () => {
    const a = cookieOf(await app.request('/api/auth/login', json({ password: PASSWORD })))
    const b = cookieOf(await app.request('/api/auth/login', json({ password: PASSWORD })))
    expect((await app.request('/api/auth/logout-all', json({}, { cookie: a }))).status).toBe(200)
    expect((await app.request('/api/ping', { headers: { cookie: b } })).status).toBe(401)
  })

  it('a new password hash signs every device out', async () => {
    const c = cookieOf(await app.request('/api/auth/login', json({ password: PASSWORD })))
    const rotated = makeApp(hashFor('a brand new passphrase'))
    expect((await rotated.request('/api/ping', { headers: { cookie: c } })).status).toBe(401)
  })

  it('checks one password at a time, so a parallel burst counts as one try', async () => {
    const burst = makeApp(hashFor(PASSWORD))
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => burst.request('/api/auth/login', json({ password: `guess ${i}` }))),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(1)
    expect(statuses.filter((s) => s === 429)).toHaveLength(9)
  })

  it('refuses writes without a JSON content type', async () => {
    const c = cookieOf(await app.request('/api/auth/login', json({ password: PASSWORD })))
    const res = await app.request('/api/ping', { method: 'POST', headers: { cookie: c, origin: ORIGIN }, body: '{}' })
    expect(res.status).toBe(415)
  })

  it('locks the login after repeated failures, even for the right password', async () => {
    const locked = makeApp(hashFor(PASSWORD))
    for (let i = 0; i < 6; i++) await locked.request('/api/auth/login', json({ password: `wrong ${i}` }))
    const res = await locked.request('/api/auth/login', json({ password: PASSWORD }))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})
