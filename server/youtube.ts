import { XMLParser } from 'fast-xml-parser'
import type { ChannelResolution, Video, VideoMeta } from '../shared/types'
import { cached } from './cache'

// Everything here uses PUBLIC pages only — no account, no API key, no quota.
// See docs/ingest.md for the rationale behind each step.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const CHANNEL_ID_RE = /^UC[\w-]{22}$/
const FEED_TTL = 5 * 60 * 1000
const META_TTL = 24 * 60 * 60 * 1000
// From an EU IP every youtube.com page first 302s to consent.youtube.com. This
// cookie records "rejected all", which skips that interstitial without opting
// into anything.
const CONSENT_COOKIE = 'SOCS=CAI'

// The server only ever talks to YouTube. Every outbound request goes through
// youtubeFetch, which refuses other hosts (also on redirects), times out, and
// caps the body, so user input can't turn the server into a proxy.
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com'])
const FETCH_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3

/** Thrown for anything the user should see as "YouTube didn't answer". */
export class UpstreamError extends Error {}

const isYouTube = (url: URL) =>
  url.protocol === 'https:' && YOUTUBE_HOSTS.has(url.hostname) && !url.port && !url.username && !url.password

/** Release a response we won't read, so its connection isn't held until GC. */
const discard = (res: Response) => void res.body?.cancel().catch(() => {})

async function youtubeFetch(href: string, init: RequestInit = {}): Promise<Response> {
  let url = new URL(href)
  // One deadline for the whole chain, redirects included.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  for (let hop = 0; ; hop++) {
    if (!isYouTube(url)) {
      // Usually a consent or sign-in wall on another Google host.
      throw new UpstreamError('YouTube sent us somewhere else. Try again later.')
    }
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal,
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: CONSENT_COOKIE, ...init.headers },
    })
    const location = res.headers.get('location')
    // Callers that inspect redirects themselves (the Shorts probe) ask for them raw.
    if (res.status < 300 || res.status >= 400 || !location || init.redirect === 'manual') return res
    discard(res)
    if (hop >= MAX_REDIRECTS) throw new UpstreamError('YouTube redirected too many times.')
    url = new URL(location, url)
  }
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    discard(res)
    throw new UpstreamError('YouTube sent an unexpectedly large page.')
  }
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new UpstreamError('YouTube sent an unexpectedly large page.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchText(url: string): Promise<string> {
  const res = await youtubeFetch(url)
  if (!res.ok) {
    discard(res)
    throw new UpstreamError(`YouTube answered ${res.status}.`)
  }
  return readCapped(res)
}

// ---------------------------------------------------------------------------
// Channel resolution
// ---------------------------------------------------------------------------

/** Direct id, or the id in a YouTube /channel/UC... URL. Returns null otherwise. */
export function extractChannelId(input: string): string | null {
  const s = input.trim()
  if (CHANNEL_ID_RE.test(s)) return s
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null
  const m = url.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/)
  return m ? m[1] : null
}

const HANDLE_RE = /^@?[\w.-]{1,100}$/

/**
 * Turn a pasted handle or YouTube channel URL into the canonical https URL of the
 * channel page. Anything else (other hosts, odd paths) returns null.
 */
export function toChannelPageUrl(input: string): string | null {
  const s = input.trim()
  if (HANDLE_RE.test(s)) return `https://www.youtube.com/@${encodeURIComponent(s.replace(/^@/, ''))}`
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) || url.port || url.username || url.password) return null
  const m = url.pathname.match(/^\/(@[\w.-]{1,100}|(?:c|user)\/[\w.-]{1,100})\/?/)
  return m ? `https://www.youtube.com/${m[1]}` : null
}

/**
 * Pull the canonical channel id out of a channel page's HTML. Order matters:
 * the canonical link / externalId / og:url identify the *page owner*, whereas a
 * bare "channelId" can be a featured or recommended channel — so those come last.
 */
export function scrapeChannelId(html: string): string | null {
  const patterns = [
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})">/,
    /"externalId":"(UC[\w-]{22})"/,
    /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/,
    /"channelId":"(UC[\w-]{22})"/,
    /channel\/(UC[\w-]{22})/,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m) return m[1]
  }
  return null
}

export async function resolveChannel(input: string): Promise<ChannelResolution> {
  let channelId = extractChannelId(input)
  if (!channelId) {
    const pageUrl = toChannelPageUrl(input)
    if (!pageUrl) throw new UpstreamError('Paste a YouTube channel URL, an @handle, or a channel ID (UC…).')
    channelId = scrapeChannelId(await fetchText(pageUrl))
  }
  if (!channelId) {
    throw new UpstreamError(
      'Could not resolve this channel automatically. Open the channel on YouTube and paste its canonical channel ID (it starts with "UC").',
    )
  }
  const { channelTitle } = await fetchChannelFeedRaw(channelId)
  return { channelId, title: channelTitle || channelId }
}

// ---------------------------------------------------------------------------
// Feed (Atom XML -> Video[])
// ---------------------------------------------------------------------------

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node && typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text'])
  }
  return ''
}

const VIDEO_ID_RE = /^[\w-]{11}$/

/** Only YouTube's image hosts may end up in an <img src> on the client. */
function safeThumbnail(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && /^i\d?\.ytimg\.com$/.test(u.hostname) ? u.href : null
  } catch {
    return null
  }
}

export function parseFeed(xml: string): { channelTitle: string; videos: Video[] } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const data = parser.parse(xml)
  const feed = data?.feed
  if (!feed) return { channelTitle: '', videos: [] }

  const channelTitle = textOf(feed.author?.name) || textOf(feed.title)
  const entries: Record<string, any>[] = feed.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : []

  const videos: Video[] = entries
    .map((e: Record<string, any>): Video | null => {
      const videoId = e['yt:videoId']
      if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return null
      const channelId = e['yt:channelId']
      const group = e['media:group'] ?? {}
      const thumb = group['media:thumbnail']?.['@_url']
      // The feed links Shorts to /shorts/<id> and everything else to /watch.
      const links: Record<string, any>[] = Array.isArray(e.link) ? e.link : e.link ? [e.link] : []
      const href: string = links.find((l) => l['@_rel'] === 'alternate')?.['@_href'] ?? ''
      const isShort = href.includes('/shorts/') ? true : href.includes('/watch') ? false : null
      return {
        videoId,
        channelId: typeof channelId === 'string' && CHANNEL_ID_RE.test(channelId) ? channelId : '',
        channelTitle,
        title: textOf(e.title),
        thumbnailUrl: safeThumbnail(thumb) ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        publishedAt: e.published ? new Date(e.published).getTime() : 0,
        isShort,
      }
    })
    .filter((v): v is Video => v !== null)

  return { channelTitle, videos }
}

async function fetchChannelFeedRaw(channelId: string): Promise<{ channelTitle: string; videos: Video[] }> {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
  return parseFeed(xml)
}

export function fetchChannelFeed(channelId: string): Promise<Video[]> {
  return cached(`feed:${channelId}`, FEED_TTL, async () => (await fetchChannelFeedRaw(channelId)).videos)
}

// ---------------------------------------------------------------------------
// Enrichment: duration + Shorts (the brittle part; degrades gracefully to null)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lengths from a channel's video list. One page gives the ~30 newest long-form
// videos with their length badge, and unlike the watch page it still answers
// datacenter IPs that YouTube asks to sign in.
// ---------------------------------------------------------------------------

const CLOCK_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/
const LENGTHS_TTL = 60 * 60 * 1000

/** "1:02:03" / "57:59" -> seconds, or null. */
export function clockToSeconds(text: string): number | null {
  const m = CLOCK_RE.exec(text.trim())
  if (!m) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/**
 * videoId -> length in seconds, read from the ytInitialData JSON of a channel's
 * /videos or /streams page. Each video is a lockupViewModel (or, in older
 * layouts, a videoRenderer); its length is the first clock-like text inside it,
 * which is the thumbnail badge.
 */
const VIDEO_TILE_KEYS = ['lockupViewModel', 'videoRenderer', 'gridVideoRenderer'] as const

export function parseChannelVideoLengths(html: string): Map<string, number> {
  const lengths = new Map<string, number>()
  const start = html.indexOf('var ytInitialData = ')
  if (start === -1) return lengths
  const end = html.indexOf(';</script>', start)
  let data: unknown
  try {
    data = JSON.parse(html.slice(start + 'var ytInitialData = '.length, end))
  } catch {
    return lengths
  }
  const firstClock = (node: unknown): number | null => {
    if (typeof node === 'string') return clockToSeconds(node)
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) {
        const found = firstClock(value)
        if (found != null) return found
      }
    }
    return null
  }
  // Only video tiles count; a channel trailer or header elsewhere on the page
  // also carries a videoId, and must not swallow the list around it.
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const obj = node as Record<string, unknown>
    for (const key of VIDEO_TILE_KEYS) {
      const tile = obj[key] as Record<string, unknown> | undefined
      const id = tile?.contentId ?? tile?.videoId
      if (typeof id === 'string' && VIDEO_ID_RE.test(id) && !lengths.has(id)) {
        const sec = firstClock(tile)
        if (sec != null) lengths.set(id, sec)
      }
    }
    Object.values(obj).forEach(walk)
  }
  walk(data)
  return lengths
}

/**
 * Lengths from one tab of a channel: `videos` (uploads) or `streams` (past live
 * streams, which never show up under videos). An empty result is an error, not
 * an answer, so a thinned-out page is retried next time instead of being cached.
 */
export function fetchChannelVideoLengths(channelId: string, tab: 'videos' | 'streams'): Promise<Map<string, number>> {
  return cached(`lengths:${tab}:${channelId}`, LENGTHS_TTL, async () => {
    const lengths = parseChannelVideoLengths(await fetchText(`https://www.youtube.com/channel/${channelId}/${tab}`))
    if (lengths.size === 0) throw new UpstreamError(`No video lengths on the ${tab} page.`)
    return lengths
  })
}

export function isoToSeconds(iso: string): number | null {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!m) return null
  const [, h, mn, s] = m
  return Number(h ?? 0) * 3600 + Number(mn ?? 0) * 60 + Number(s ?? 0)
}

export function parseDuration(html: string): number | null {
  const len = html.match(/"lengthSeconds":"(\d+)"/)
  if (len) return Number(len[1])
  const ms = html.match(/"approxDurationMs":"(\d+)"/)
  if (ms) return Math.round(Number(ms[1]) / 1000)
  const iso = html.match(/itemprop="duration" content="([^"]+)"/)
  if (iso) return isoToSeconds(iso[1])
  return null
}

async function detectShort(videoId: string, durationSec: number | null): Promise<boolean | null> {
  try {
    const res = await youtubeFetch(`https://www.youtube.com/shorts/${videoId}`, { method: 'HEAD', redirect: 'manual' })
    discard(res)
    // A real Short stays on /shorts (200); a normal video redirects to /watch.
    // Any other redirect (consent wall, sign-in) says nothing either way.
    if (res.status === 200) return true
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')?.includes('/watch')) return false
  } catch {
    // fall through to the duration heuristic
  }
  if (durationSec != null) return durationSec <= 60
  return null
}

export function fetchVideoMeta(videoId: string): Promise<VideoMeta> {
  return cached(`meta:${videoId}`, META_TTL, async () => {
    let durationSec: number | null = null
    try {
      const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`)
      durationSec = parseDuration(html)
    } catch {
      // leave duration unknown; never fail the whole request over enrichment
    }
    const isShort = await detectShort(videoId, durationSec)
    return { durationSec, isShort }
  })
}
