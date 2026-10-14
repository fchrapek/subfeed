import { describe, expect, it } from 'vitest'
import { extractChannelId, isoToSeconds, parseDuration, parseFeed, scrapeChannelId, toChannelPageUrl } from './youtube'

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
  <title>Sample Channel</title>
  <author><name>Sample Channel</name></author>
  <entry>
    <id>yt:video:abc123XYZ_-</id>
    <yt:videoId>abc123XYZ_-</yt:videoId>
    <yt:channelId>UCAAAAAAAAAAAAAAAAAAAAAA</yt:channelId>
    <title>First Video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc123XYZ_-"/>
    <published>2026-06-29T10:00:00+00:00</published>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/abc123XYZ_-/hqdefault.jpg" width="480" height="360"/>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:second00000</id>
    <yt:videoId>second00000</yt:videoId>
    <yt:channelId>UCAAAAAAAAAAAAAAAAAAAAAA</yt:channelId>
    <title>Second Video</title>
    <link rel="alternate" href="https://www.youtube.com/shorts/second00000"/>
    <published>2026-06-28T09:00:00+00:00</published>
    <media:group/>
  </entry>
</feed>`

describe('parseFeed', () => {
  it('extracts channel title and entries', () => {
    const { channelTitle, videos } = parseFeed(FEED)
    expect(channelTitle).toBe('Sample Channel')
    expect(videos).toHaveLength(2)
  })

  it('maps fields from an entry', () => {
    const { videos } = parseFeed(FEED)
    expect(videos[0]).toMatchObject({
      videoId: 'abc123XYZ_-',
      channelId: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      channelTitle: 'Sample Channel',
      title: 'First Video',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc123XYZ_-/hqdefault.jpg',
    })
    expect(videos[0].publishedAt).toBe(Date.parse('2026-06-29T10:00:00+00:00'))
  })

  it('falls back to a derived thumbnail when none is present', () => {
    const { videos } = parseFeed(FEED)
    expect(videos[1].thumbnailUrl).toBe('https://i.ytimg.com/vi/second00000/hqdefault.jpg')
  })

  it('reads Shorts from the entry link', () => {
    const { videos } = parseFeed(FEED)
    expect(videos[0].isShort).toBe(false)
    expect(videos[1].isShort).toBe(true)
  })

  it('returns empty for non-feed input', () => {
    expect(parseFeed('<html></html>')).toEqual({ channelTitle: '', videos: [] })
  })
})

describe('extractChannelId', () => {
  it('accepts a bare channel id', () => {
    expect(extractChannelId('UCAAAAAAAAAAAAAAAAAAAAAA')).toBe('UCAAAAAAAAAAAAAAAAAAAAAA')
  })
  it('extracts from a /channel/ URL', () => {
    expect(extractChannelId('https://www.youtube.com/channel/UCBBBBBBBBBBBBBBBBBBBBBB')).toBe(
      'UCBBBBBBBBBBBBBBBBBBBBBB',
    )
  })
  it('returns null for a handle', () => {
    expect(extractChannelId('@somehandle')).toBeNull()
  })
})

describe('scrapeChannelId', () => {
  it('finds channelId in page JSON', () => {
    expect(scrapeChannelId('...,"channelId":"UCCCCCCCCCCCCCCCCCCCCCCC",...')).toBe('UCCCCCCCCCCCCCCCCCCCCCCC')
  })
  it('finds externalId fallback', () => {
    expect(scrapeChannelId('"externalId":"UCDDDDDDDDDDDDDDDDDDDDDD"')).toBe('UCDDDDDDDDDDDDDDDDDDDDDD')
  })
  it('prefers the page owner (canonical) over an earlier featured channelId', () => {
    const html =
      '"channelId":"UCFEATURED0000000000000",' +
      '<link rel="canonical" href="https://www.youtube.com/channel/UCOWNER00000000000000000">'
    expect(scrapeChannelId(html)).toBe('UCOWNER00000000000000000')
  })
  it('returns null when absent', () => {
    expect(scrapeChannelId('no channel here')).toBeNull()
  })
})

describe('duration parsing', () => {
  it('isoToSeconds handles H/M/S', () => {
    expect(isoToSeconds('PT1H2M3S')).toBe(3723)
    expect(isoToSeconds('PT45S')).toBe(45)
    expect(isoToSeconds('PT10M')).toBe(600)
  })
  it('parseDuration reads lengthSeconds', () => {
    expect(parseDuration('x"lengthSeconds":"612"x')).toBe(612)
  })
  it('parseDuration reads itemprop duration', () => {
    expect(parseDuration('<meta itemprop="duration" content="PT3M30S">')).toBe(210)
  })
  it('parseDuration returns null when unknown', () => {
    expect(parseDuration('nothing')).toBeNull()
  })
})

describe('extractChannelId host check', () => {
  it('reads ids only from YouTube URLs', () => {
    const id = 'UCX6OQ3DkcsbYNE6H8uQQuVA'
    expect(extractChannelId(`https://www.youtube.com/channel/${id}/videos`)).toBe(id)
    expect(extractChannelId(`youtube.com/channel/${id}`)).toBe(id)
    expect(extractChannelId(`https://evil.example/channel/${id}`)).toBeNull()
  })
})

describe('toChannelPageUrl', () => {
  it('turns handles and channel URLs into canonical YouTube URLs', () => {
    expect(toChannelPageUrl('@veritasium')).toBe('https://www.youtube.com/@veritasium')
    expect(toChannelPageUrl('veritasium')).toBe('https://www.youtube.com/@veritasium')
    expect(toChannelPageUrl('https://www.youtube.com/@mkbhd/videos')).toBe('https://www.youtube.com/@mkbhd')
    expect(toChannelPageUrl('youtube.com/c/SomeName')).toBe('https://www.youtube.com/c/SomeName')
    expect(toChannelPageUrl('http://m.youtube.com/user/old')).toBe('https://www.youtube.com/user/old')
  })

  it('refuses anything that is not a YouTube channel page', () => {
    for (const bad of [
      'http://127.0.0.1:8787/api/state',
      'https://youtube.com.evil.example/@x',
      'https://evil.example/@x',
      'https://user:pass@www.youtube.com/@x',
      'https://www.youtube.com:444/@x',
      'https://www.youtube.com/watch?v=abc',
      'file:///etc/passwd',
    ]) {
      expect(toChannelPageUrl(bad)).toBeNull()
    }
  })
})

describe('parseFeed hardening', () => {
  it('drops entries with malformed ids', () => {
    const { videos } = parseFeed(FEED.replace('abc123XYZ_-</yt:videoId>', 'not-a-valid-id</yt:videoId>'))
    expect(videos.map((v) => v.videoId)).toEqual(['second00000'])
  })

  it('replaces a thumbnail from a foreign host with the derived one', () => {
    const { videos } = parseFeed(
      FEED.replace('https://i.ytimg.com/vi/abc123XYZ_-/hqdefault.jpg', 'https://tracker.example/pixel.gif'),
    )
    expect(videos[0].thumbnailUrl).toBe('https://i.ytimg.com/vi/abc123XYZ_-/hqdefault.jpg')
  })
})
