import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The module reads GEO_COUNTIES_BY_STATE_PATH at call time to decide where to
// write, so we point it at a temp file per test.
import { warmCountyCache, countyCachePath } from '../startup/warmCountyCache.js'

describe('warmCountyCache', () => {
  let tmpDir
  let prevEnv

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-county-'))
    prevEnv = process.env.GEO_COUNTIES_BY_STATE_PATH
    process.env.GEO_COUNTIES_BY_STATE_PATH = path.join(tmpDir, 'counties_by_state.json')
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.GEO_COUNTIES_BY_STATE_PATH
    else process.env.GEO_COUNTIES_BY_STATE_PATH = prevEnv
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('writes a real counties-by-state cache from the app resolver', async () => {
    const result = await warmCountyCache({ states: ['OH', 'CA'] })
    expect(result.ok).toBe(true)
    expect(result.written).toBe(true)

    const written = JSON.parse(fs.readFileSync(countyCachePath(), 'utf8'))
    // Real, resolver-derived county names (not fabricated).
    expect(written.OH).toContain('Cuyahoga')
    expect(written.CA).toContain('Los Angeles')
    expect(written.OH.length).toBeGreaterThan(50) // OH has 88 counties
  })

  it('skips regeneration when a fresh cache already exists (unless forced)', async () => {
    // Seed a "fresh" cache covering >= MIN_FRESH_STATES states.
    const seed = {}
    const states = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA'.split(' ')
    for (const s of states) seed[s] = ['Example County']
    fs.writeFileSync(countyCachePath(), JSON.stringify(seed), 'utf8')

    const skipped = await warmCountyCache()
    expect(skipped.skipped).toBe('cache_fresh')

    // force overrides the freshness skip.
    const forced = await warmCountyCache({ force: true, states: ['OH'] })
    expect(forced.written).toBe(true)
  })

  it('honors WARM_COUNTY_CACHE=false as a kill switch', async () => {
    const prev = process.env.WARM_COUNTY_CACHE
    process.env.WARM_COUNTY_CACHE = 'false'
    try {
      const result = await warmCountyCache({ states: ['OH'] })
      expect(result.skipped).toBe('disabled')
      expect(fs.existsSync(countyCachePath())).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.WARM_COUNTY_CACHE
      else process.env.WARM_COUNTY_CACHE = prev
    }
  })
})
