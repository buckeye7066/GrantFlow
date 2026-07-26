/**
 * sourceUrlOverrides — the trust line of autonomous source repair, in code.
 *
 * A source's registrable domain is the trust anchor the whole crawl fleet
 * inherits. SAME-domain prefix repairs are safe to automate; a CROSS-domain
 * target must be refused at the WRITE choke point (and ignored at apply time
 * if it somehow lands in the store) — the tn.gov/collegepays →
 * collegefortn.org move of 2026-07-26 is the canonical case: correct, but a
 * judgment call a human had to make.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  registrableDomain,
  isSameRegistrableDomain,
  loadSourceUrlOverrides,
  writeSourceUrlOverride,
  writeSourceUrlProposal,
  applyOverridesToUrl,
  makeOverrideRewritingFetcher,
  SOURCE_URL_OVERRIDES_KEY,
} from '../services/sources/sourceUrlOverrides.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
  db.dialect = 'sqlite'
  return db
}

describe('registrable-domain trust anchor', () => {
  it('compares by eTLD+1, not hostname', () => {
    expect(registrableDomain('www.tn.gov')).toBe('tn.gov')
    expect(registrableDomain('fabenefits.dhs.tn.gov')).toBe('tn.gov')
    expect(isSameRegistrableDomain('https://www.tn.gov/a', 'https://tn.gov/b')).toBe(true)
    expect(isSameRegistrableDomain('https://www.tn.gov/a', 'https://tenncareconnect.tn.gov/x')).toBe(true)
  })

  it('the 2026-07-26 canonical case is CROSS-domain', () => {
    expect(isSameRegistrableDomain(
      'https://www.tn.gov/collegepays/',
      'https://www.collegefortn.org/tennessee-step-up-scholarship/',
    )).toBe(false)
  })

  it('multi-part public suffixes never collapse to the suffix itself', () => {
    expect(registrableDomain('portal.example.co.uk')).toBe('example.co.uk')
    expect(isSameRegistrableDomain('https://a.example.co.uk/', 'https://b.other.co.uk/')).toBe(false)
  })
})

describe('the write choke point', () => {
  it('accepts a same-domain repair and round-trips it', async () => {
    const db = makeDb()
    await writeSourceUrlOverride(db, {
      source_id: 'tn_state_portal',
      from_prefix: 'https://www.tn.gov/humanservices/old.html',
      to_prefix: 'https://www.tn.gov/humanservices/new-portal/',
      evidence: { kind: 'host_redirect' },
    })
    const loaded = await loadSourceUrlOverrides(db)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].to_prefix).toContain('new-portal')
  })

  it('THROWS on a cross-domain target — autonomy ends at the domain boundary', async () => {
    const db = makeDb()
    await expect(writeSourceUrlOverride(db, {
      source_id: 'tn_collegepays',
      from_prefix: 'https://www.tn.gov/collegepays/',
      to_prefix: 'https://www.collegefortn.org/',
    })).rejects.toThrow(/REFUSED|cross-domain/i)
    expect(await loadSourceUrlOverrides(db)).toHaveLength(0)
  })

  it('a corrupted cross-domain entry in the store is IGNORED at apply time (defense in depth)', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      SOURCE_URL_OVERRIDES_KEY,
      JSON.stringify({ overrides: { evil: { from_prefix: 'https://www.tn.gov/x', to_prefix: 'https://lookalike-tn.com/x' } } }),
      new Date().toISOString(),
    )
    expect(await loadSourceUrlOverrides(db)).toHaveLength(0)
  })

  it('a cross-domain PROPOSAL is stored for the owner without touching overrides', async () => {
    const db = makeDb()
    await writeSourceUrlProposal(db, {
      source_id: 'tn_collegepays',
      from_prefix: 'https://www.tn.gov/collegepays/',
      to_prefix: 'https://www.collegefortn.org/',
      evidence: { kind: 'host_redirect' },
    })
    const raw = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(SOURCE_URL_OVERRIDES_KEY).value)
    expect(raw.proposals.tn_collegepays.to_prefix).toBe('https://www.collegefortn.org/')
    expect(await loadSourceUrlOverrides(db), 'a proposal is never an applied override').toHaveLength(0)
  })
})

describe('prefix rewrite + fetcher wrapper', () => {
  const overrides = [
    { source_id: 's', from_prefix: 'https://www.tn.gov/humanservices/old', to_prefix: 'https://www.tn.gov/humanservices/new' },
  ]

  it('rewrites URLs under the prefix, preserving the tail (search params, pagination)', () => {
    expect(applyOverridesToUrl('https://www.tn.gov/humanservices/old/page?q=food&p=2', overrides).url)
      .toBe('https://www.tn.gov/humanservices/new/page?q=food&p=2')
    expect(applyOverridesToUrl('https://www.tn.gov/other/page', overrides).applied).toBeNull()
  })

  it('the wrapped fetcher rewrites only matching URLs and counts rewrites', async () => {
    const seen = []
    const inner = { fetch: async (url) => { seen.push(url); return { ok: true, status: 200 } } }
    const wrapped = makeOverrideRewritingFetcher(inner, overrides)
    await wrapped.fetch('https://www.tn.gov/humanservices/old/a')
    await wrapped.fetch('https://unrelated.org/b')
    expect(seen).toEqual(['https://www.tn.gov/humanservices/new/a', 'https://unrelated.org/b'])
    expect(wrapped.overrideRewrites).toBe(1)
  })

  it('no overrides → the original fetcher object, untouched', () => {
    const inner = { fetch: async () => ({}) }
    expect(makeOverrideRewritingFetcher(inner, [])).toBe(inner)
  })

  it('PREFIX-BOUNDARY: a repair for one page never hijacks its siblings', () => {
    const o = [{ source_id: 's', from_prefix: 'https://a.gov/old', to_prefix: 'https://a.gov/new' }]
    expect(applyOverridesToUrl('https://a.gov/old-page', o).applied, "'old' must not claim 'old-page'").toBeNull()
    expect(applyOverridesToUrl('https://a.gov/old/deep', o).url).toBe('https://a.gov/new/deep')
    expect(applyOverridesToUrl('https://a.gov/old?p=1', o).url).toBe('https://a.gov/new?p=1')
  })

  it('never stitches a double slash (the sbir.gov trailing-slash class, prod 2026-07-26)', () => {
    const o = [{ source_id: 's', from_prefix: 'https://a.gov/x', to_prefix: 'https://a.gov/y/' }]
    expect(applyOverridesToUrl('https://a.gov/x/topics', o).url).toBe('https://a.gov/y/topics')
  })

  it('a degenerate trailing-slash-only override is dropped at load (no-op repairs never apply)', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      SOURCE_URL_OVERRIDES_KEY,
      JSON.stringify({ overrides: { sbir_gov: { from_prefix: 'https://www.sbir.gov', to_prefix: 'https://www.sbir.gov/' } } }),
      new Date().toISOString(),
    )
    expect(await loadSourceUrlOverrides(db)).toHaveLength(0)
  })
})
