/**
 * Unit tests for backend/services/crawlers/robotsPolicy.js
 */

import { describe, it, expect } from 'vitest'
import {
  parseRobots,
  isPathAllowed,
  crawlDelayFor,
  isUrlAllowed,
} from '../services/crawlers/robotsPolicy.js'

const UA = 'GrantFlow Crawler/1.0'

describe('parseRobots', () => {
  it('groups directives by user-agent and reads crawl-delay', () => {
    const txt = `User-agent: *\nDisallow: /private\nCrawl-delay: 5\n\nUser-agent: BadBot\nDisallow: /`
    const p = parseRobots(txt)
    expect(p.agents['*'].disallow).toEqual(['/private'])
    expect(p.agents['*'].crawlDelay).toBe(5)
    expect(p.agents['badbot'].disallow).toEqual(['/'])
  })

  it('ignores comments and blank lines', () => {
    const p = parseRobots('# hello\nUser-agent: *\n   \nDisallow: /x # inline')
    expect(p.agents['*'].disallow).toEqual(['/x'])
  })
})

describe('isPathAllowed', () => {
  it('allows everything when robots is empty', () => {
    expect(isPathAllowed('', '/anything', UA)).toBe(true)
  })

  it('blocks disallowed prefixes and allows the rest', () => {
    const txt = 'User-agent: *\nDisallow: /private'
    expect(isPathAllowed(txt, '/private/page', UA)).toBe(false)
    expect(isPathAllowed(txt, '/public/page', UA)).toBe(true)
  })

  it('honors longest-match with Allow winning ties', () => {
    const txt = 'User-agent: *\nDisallow: /dir\nAllow: /dir/ok'
    expect(isPathAllowed(txt, '/dir/secret', UA)).toBe(false)
    expect(isPathAllowed(txt, '/dir/ok/page', UA)).toBe(true) // longer Allow wins
  })

  it('treats an empty Disallow as allow-all', () => {
    expect(isPathAllowed('User-agent: *\nDisallow:', '/anything', UA)).toBe(true)
  })

  it('blocks the whole site on Disallow: /', () => {
    expect(isPathAllowed('User-agent: *\nDisallow: /', '/x', UA)).toBe(false)
  })

  it('supports * wildcard and $ end-anchor', () => {
    expect(isPathAllowed('User-agent: *\nDisallow: /*.pdf$', '/files/a.pdf', UA)).toBe(false)
    expect(isPathAllowed('User-agent: *\nDisallow: /*.pdf$', '/files/a.pdf?x=1', UA)).toBe(true)
  })

  it('applies the most specific UA group over *', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: GrantFlow\nDisallow: /private\nAllow: /'
    expect(isPathAllowed(txt, '/public', 'GrantFlow Crawler/1.0')).toBe(true) // specific group
    expect(isPathAllowed(txt, '/public', 'OtherBot')).toBe(false) // falls to *
  })
})

describe('crawlDelayFor', () => {
  it('reads the crawl-delay for the matching agent', () => {
    expect(crawlDelayFor('User-agent: *\nCrawl-delay: 10', UA)).toBe(10)
    expect(crawlDelayFor('User-agent: *\nDisallow: /', UA)).toBe(null)
  })
})

describe('isUrlAllowed', () => {
  it('fails open when there is no fetcher', async () => {
    const r = await isUrlAllowed('https://example.org/x')
    expect(r.allowed).toBe(true)
    expect(r.reason).toMatch(/assumed_allowed/)
  })

  it('fails open when robots.txt is missing', async () => {
    const fetchText = async () => ({ ok: false, text: '' })
    const r = await isUrlAllowed('https://example.org/x', { fetchText })
    expect(r.allowed).toBe(true)
    expect(r.reason).toMatch(/fail_open/)
  })

  it('blocks a disallowed path and surfaces crawl-delay', async () => {
    const fetchText = async (u) => {
      expect(u).toBe('https://example.org/robots.txt')
      return { ok: true, text: 'User-agent: *\nDisallow: /private\nCrawl-delay: 3' }
    }
    const blocked = await isUrlAllowed('https://example.org/private/x', { fetchText, userAgent: UA })
    expect(blocked.allowed).toBe(false)
    expect(blocked.crawlDelay).toBe(3)

    const ok = await isUrlAllowed('https://example.org/public/x', { fetchText, userAgent: UA })
    expect(ok.allowed).toBe(true)
  })

  it('rejects an invalid URL', async () => {
    const r = await isUrlAllowed('not a url', { fetchText: async () => ({ ok: true, text: '' }) })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('invalid_url')
  })
})
