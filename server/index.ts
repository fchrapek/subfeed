import './env'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import type { BudgetUnit, Settings } from '../shared/types'
import { createAuth, loadAuthConfig, type AuthConfig } from './auth'
import * as store from './db'
import { enrichPending, refreshAllFeeds } from './refresh'
import { UpstreamError, extractChannelId, resolveChannel } from './youtube'

// Refuse to start without auth config: an open instance would let anyone read
// the data and make the server fetch from YouTube on their behalf.
let authConfig: AuthConfig
try {
  authConfig = loadAuthConfig()
} catch (e) {
  console.error(`Subfeed will not start: ${(e as Error).message}`)
  process.exit(1)
}
const auth = createAuth(authConfig)

// Background work (enrichment) must never take the server down.
process.on('unhandledRejection', (err) => console.error('[unhandled]', err))
const inBackground = (work: Promise<unknown>) => void work.catch((err) => console.error('[background]', err))

const app = new Hono()

// The YouTube IFrame API loads its script from www.youtube.com and plays inside
// a youtube-nocookie.com frame; thumbnails come from *.ytimg.com (also fetched
// by the service worker, hence connect-src). Embeds need a Referer, so the
// referrer policy keeps the origin rather than dropping it.
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://www.youtube.com', 'https://s.ytimg.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://*.ytimg.com'],
      frameSrc: ['https://www.youtube-nocookie.com', 'https://www.youtube.com'],
      connectSrc: ["'self'", 'https://*.ytimg.com'],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: 'strict-origin-when-cross-origin',
    xFrameOptions: 'DENY',
    strictTransportSecurity: authConfig.secure ? 'max-age=31536000' : false,
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  }),
)

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error(err)
  return c.json({ error: 'Something went wrong.' }, 500)
})

// Public: container healthchecks.
app.get('/healthz', (c) => c.text('ok'))

// ---- API: everything below needs a session, except logging in ----
app.use('/api/*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) }))
app.use('/api/*', auth.guardWrites)
app.route('/api/auth', auth.routes)
app.use('/api/*', auth.requireSession)

// ---- input checks ----

const VIDEO_ID_RE = /^[\w-]{11}$/
const CHANNEL_ID_RE = /^UC[\w-]{22}$/

class BadRequest extends HTTPException {
  constructor(message: string) {
    super(400, { res: Response.json({ error: message }, { status: 400 }) })
  }
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Expected a JSON object.')
  return body as Record<string, unknown>
}

/** A known video id: the API only ever acts on videos that came from a followed feed. */
function knownVideoId(value: unknown): string {
  if (typeof value !== 'string' || !VIDEO_ID_RE.test(value)) throw new BadRequest('Invalid video id.')
  if (!store.videoExists(value))
    throw new HTTPException(404, { res: Response.json({ error: 'Unknown video.' }, { status: 404 }) })
  return value
}

function playlistId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new BadRequest('Invalid playlist id.')
  if (!store.playlistExists(id))
    throw new HTTPException(404, { res: Response.json({ error: 'Playlist not found.' }, { status: 404 }) })
  return id
}

function playlistName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 80) throw new BadRequest('Give the playlist a name (up to 80 characters).')
  return name
}

function intIn(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequest(`${label} must be a whole number from ${min} to ${max}.`)
  }
  return value
}

/** Only known keys, each type-checked and range-limited. */
function parseSettings(body: Record<string, unknown>): Settings {
  const budget = body.dailyBudget as Record<string, unknown> | undefined
  if (typeof body.hideShorts !== 'boolean') throw new BadRequest('hideShorts must be true or false.')
  if (!budget || typeof budget !== 'object' || !['count', 'minutes'].includes(budget.unit as string)) {
    throw new BadRequest('dailyBudget.unit must be "count" or "minutes".')
  }
  return {
    refreshIntervalMin: intIn(body.refreshIntervalMin, 5, 1440, 'refreshIntervalMin'),
    hideShorts: body.hideShorts,
    minDurationSec: intIn(body.minDurationSec, 0, 86400, 'minDurationSec'),
    watchedThresholdPct: intIn(body.watchedThresholdPct, 1, 100, 'watchedThresholdPct'),
    feedLimit: intIn(body.feedLimit, 1, 500, 'feedLimit'),
    dailyBudget: { unit: budget.unit as BudgetUnit, value: intIn(budget.value, 0, 1440, 'dailyBudget.value') },
  }
}

// ---- Full state snapshot: the client mirrors this into IndexedDB ----
app.get('/api/state', (c) => c.json(store.getSnapshot()))

// ---- Channels ----
const MAX_CHANNELS = 500
let addingChannel = false // one lookup at a time; each one fetches pages from YouTube

app.post('/api/channels', async (c) => {
  const { input } = await jsonBody(c)
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) {
    return c.json({ error: 'Paste a channel URL, @handle, or channel ID.' }, 400)
  }
  const direct = extractChannelId(input)
  if (direct && store.getChannel(direct)) return c.json(store.getSnapshot())
  if (store.countChannels() >= MAX_CHANNELS) {
    return c.json({ error: `You follow ${MAX_CHANNELS} channels already. Remove some first.` }, 422)
  }
  if (addingChannel) return c.json({ error: 'Still adding the previous channel. Try again in a moment.' }, 429)
  addingChannel = true
  try {
    const { channelId, title } = await resolveChannel(input)
    if (!store.getChannel(channelId)) {
      store.addChannel({ id: channelId, title: title.slice(0, 200), addedAt: Date.now() })
      await refreshAllFeeds({ force: true })
      inBackground(enrichPending())
    }
    return c.json(store.getSnapshot())
  } catch (e) {
    // Only our own messages reach the client; network errors stay generic.
    const message = e instanceof UpstreamError ? e.message : 'YouTube did not answer.'
    if (!(e instanceof UpstreamError)) console.warn('[channels] resolve failed:', (e as Error).message)
    return c.json({ error: message }, 422)
  } finally {
    addingChannel = false
  }
})

app.delete('/api/channels/:id', (c) => {
  const id = c.req.param('id')
  if (!CHANNEL_ID_RE.test(id)) throw new BadRequest('Invalid channel id.')
  store.removeChannel(id)
  return c.json(store.getSnapshot())
})

// ---- Refresh (server fetches all feeds, then enriches in the background) ----
app.post('/api/refresh', async (c) => {
  await refreshAllFeeds()
  inBackground(enrichPending())
  return c.json(store.getSnapshot())
})

// ---- Watch state ----
app.post('/api/watch/watched', async (c) => {
  const { videoId } = await jsonBody(c)
  return c.json(store.setWatched(knownVideoId(videoId)))
})

app.post('/api/watch/unwatched', async (c) => {
  const { videoId } = await jsonBody(c)
  return c.json({ watch: store.setUnwatched(knownVideoId(videoId)) })
})

app.post('/api/watch/position', async (c) => {
  const { videoId, positionSec } = await jsonBody(c)
  if (typeof positionSec !== 'number' || !Number.isFinite(positionSec) || positionSec < 0 || positionSec > 7 * 86400) {
    throw new BadRequest('Invalid position.')
  }
  store.setPosition(knownVideoId(videoId), positionSec)
  return c.body(null, 204)
})

// ---- Queue ----
app.post('/api/queue', async (c) => {
  const { videoId } = await jsonBody(c)
  return c.json({ queue: store.addToQueue(knownVideoId(videoId)) })
})

app.delete('/api/queue/:videoId', (c) => {
  const videoId = c.req.param('videoId')
  if (!VIDEO_ID_RE.test(videoId)) throw new BadRequest('Invalid video id.')
  return c.json({ queue: store.removeFromQueue(videoId) })
})

// ---- Playlists (user-made, named) ----
app.post('/api/playlists', async (c) => {
  const { name } = await jsonBody(c)
  if (store.listPlaylists().length >= 200) throw new BadRequest('That is a lot of playlists. Delete some first.')
  const playlist = store.createPlaylist(playlistName(name))
  return c.json({ playlist, ...store.getPlaylistState() })
})

app.patch('/api/playlists/:id', async (c) => {
  const id = playlistId(c.req.param('id'))
  const { name } = await jsonBody(c)
  store.renamePlaylist(id, playlistName(name))
  return c.json(store.getPlaylistState())
})

app.delete('/api/playlists/:id', (c) => {
  store.deletePlaylist(playlistId(c.req.param('id')))
  return c.json(store.getPlaylistState())
})

app.post('/api/playlists/:id/items', async (c) => {
  const id = playlistId(c.req.param('id'))
  const { videoId } = await jsonBody(c)
  store.addToPlaylist(id, knownVideoId(videoId))
  return c.json(store.getPlaylistState())
})

app.delete('/api/playlists/:id/items/:videoId', (c) => {
  const id = playlistId(c.req.param('id'))
  const videoId = c.req.param('videoId')
  if (!VIDEO_ID_RE.test(videoId)) throw new BadRequest('Invalid video id.')
  store.removeFromPlaylist(id, videoId)
  return c.json(store.getPlaylistState())
})

// ---- Settings & budget ----
app.put('/api/settings', async (c) => {
  return c.json({ settings: store.setSettings(parseSettings(await jsonBody(c))) })
})

app.post('/api/budget/override', (c) => c.json({ budget: store.overrideBudget() }))

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

// In production the same process serves the built SPA. It holds no data, so it
// stays public: an installed app must be able to load and update itself
// before the user has signed in.
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist/client' }))
  app.get('*', serveStatic({ path: './dist/client/index.html' }))
}

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port })
console.log(`Subfeed listening on http://localhost:${port} (public origin ${authConfig.origin})`)
