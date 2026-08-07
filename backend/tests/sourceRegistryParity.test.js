/**
 * REGISTRY + TOTALITY guard for the two source registries (CLAUDE.md
 * "MIGRATION PARITY" — any set whose members live in more than one place gets a
 * registry plus a totality test so a new member cannot silently fall out of a
 * consumer).
 *
 * The drift this pins down was live in production on 2026-08-07: 39 of the 61
 * DISPLAY sources (backend/services/sourceRegistry.js) have no id in the ENGINE
 * registry (backend/crawler-os/sourceRegistry.js), which is the only registry
 * the pipeline consults and the only source of crawler_source_runs rows. The
 * admin Crawl Coverage dashboard therefore listed 31 of them as "never run"
 * forever and 8 as permanently ~46.8 days stale (the age of the retired
 * pre-cutover engine's last rows), with a "Run now" button that could only
 * return 404 source_not_crawlable.
 *
 * These tests FAIL if a display source is added/renamed without either wiring a
 * crawler-os lane or declaring the gap.
 */

import { describe, it, expect } from 'vitest'
import { SOURCES as DISPLAY_SOURCES } from '../services/sourceRegistry.js'
import { getSource as getCrawlerOsSource } from '../crawler-os/sourceRegistry.js'
import {
  CRAWLER_OS_SOURCE_ALIASES,
  DISPLAY_ONLY_SOURCES,
  classifyDisplaySource,
  resolveCrawlerOsSourceId,
  listUnrunnableDisplaySources,
} from '../services/sourceRegistryParity.js'

const displayIds = Object.values(DISPLAY_SOURCES)
  .map((s) => s?.id)
  .filter(Boolean)

describe('source registry parity (display catalog ↔ crawler-os engine)', () => {
  it('TOTALITY: every display source is either crawler-os-backed or declared display-only', () => {
    const undeclared = displayIds.filter(
      (id) => !resolveCrawlerOsSourceId(id) && !(id in DISPLAY_ONLY_SOURCES),
    )
    expect(undeclared).toEqual([])
  })

  it('every alias points at a source that really exists in the crawler-os registry', () => {
    const broken = Object.entries(CRAWLER_OS_SOURCE_ALIASES).filter(
      ([, osId]) => !getCrawlerOsSource(osId),
    )
    expect(broken).toEqual([])
  })

  it('every alias key is a real display source (no aliases for ids nobody displays)', () => {
    const orphan = Object.keys(CRAWLER_OS_SOURCE_ALIASES).filter((id) => !displayIds.includes(id))
    expect(orphan).toEqual([])
  })

  it('a source is never both aliased and declared unrunnable', () => {
    const both = Object.keys(CRAWLER_OS_SOURCE_ALIASES).filter((id) => id in DISPLAY_ONLY_SOURCES)
    expect(both).toEqual([])
  })

  it('a declared display-only source is never reported as runnable, and carries a reason', () => {
    for (const id of Object.keys(DISPLAY_ONLY_SOURCES)) {
      const verdict = classifyDisplaySource(id)
      expect(verdict.runnable).toBe(false)
      expect(verdict.crawler_os_source_id).toBeNull()
      expect(typeof verdict.reason).toBe('string')
      expect(verdict.reason.length).toBeGreaterThan(0)
    }
  })

  it('a declared display-only source must NOT actually exist in crawler-os (stale declaration)', () => {
    // If someone wires a lane, they must delete the DISPLAY_ONLY entry — a
    // stale "no lane exists" claim would keep the dashboard lying in the other
    // direction (hiding a source that CAN run).
    const stale = Object.keys(DISPLAY_ONLY_SOURCES).filter((id) => getCrawlerOsSource(id))
    expect(stale).toEqual([])
  })

  it('an aliased source resolves to its engine id (the ids that appear in crawler_source_runs)', () => {
    // Verified pairs — same organization AND same host.
    expect(resolveCrawlerOsSourceId('sam_gov_assistance_listings')).toBe('sam_gov')
    expect(resolveCrawlerOsSourceId('ed_gov_fafsa')).toBe('studentaid_gov')
    expect(resolveCrawlerOsSourceId('usda_rural_dev')).toBe('usda_rd')
  })

  it('an unwired display source is classified not-crawlable, not "never run"', () => {
    const verdict = classifyDisplaySource('overpass_local')
    expect(verdict.runnable).toBe(false)
    expect(verdict.reason).toMatch(/no crawler-os lane/i)
  })

  it('the unrunnable set is enumerable and every entry has a reason', () => {
    const unrunnable = listUnrunnableDisplaySources()
    expect(unrunnable.length).toBeGreaterThan(0)
    for (const row of unrunnable) {
      expect(typeof row.source_id).toBe('string')
      expect(typeof row.reason).toBe('string')
      expect(row.reason).not.toMatch(/undeclared drift/)
    }
  })
})
