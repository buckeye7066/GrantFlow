/**
 * Unit tests for the generic operator-configured crawler sources
 * (json_feed / csv_feed) and field mapping.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  mapFeedRow,
  parseCsv,
  makeJsonFeedSource,
  makeCsvFeedSource,
  registerConfiguredWebSources,
  listWebSources,
  _clearWebSources,
} from '../services/yana/yanaWebCrawler.js'

beforeEach(() => { _clearWebSources() })

describe('mapFeedRow', () => {
  it('maps via common field aliases', () => {
    const r = mapFeedRow({ organization_name: 'Helping Hands', email_address: 'info@hh.org', url: 'hh.org', st: 'OH', tax_id: '12-3', category: 'nonprofit' })
    expect(r).toMatchObject({ name: 'Helping Hands', email: 'info@hh.org', website: 'hh.org', state: 'OH', ein: '12-3', organization_type: 'nonprofit', applicant_type: 'nonprofit' })
  })
  it('defaults applicant_type to organization', () => {
    expect(mapFeedRow({ name: 'X' }).applicant_type).toBe('organization')
  })
})

describe('parseCsv', () => {
  it('parses headers + quoted fields with embedded commas', () => {
    const rows = parseCsv('name,email,website\n"Helping, Inc.",info@h.org,h.org\nFaith Center,fc@fc.org,fc.org')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ name: 'Helping, Inc.', email: 'info@h.org', website: 'h.org' })
    expect(rows[1].name).toBe('Faith Center')
  })
  it('skips blank lines and returns [] on empty', () => {
    expect(parseCsv('')).toEqual([])
  })
})

describe('makeJsonFeedSource', () => {
  it('reads an array under results/data/organizations and maps rows', async () => {
    const src = makeJsonFeedSource({ url: 'https://dir.example.org/feed.json' })
    expect(src.name).toBe('json_feed')
    const fetchImpl = async () => ({ ok: true, json: { results: [{ organization_name: 'A Org', email: 'a@a.org', website: 'a.org' }] } })
    const c = await src.fetchCandidates({ fetchImpl, limit: 10 })
    expect(c[0]).toMatchObject({ name: 'A Org', email: 'a@a.org', website: 'a.org' })
  })
  it('returns [] when no url configured', async () => {
    const src = makeJsonFeedSource({ url: null })
    expect(await src.fetchCandidates({ fetchImpl: async () => ({ ok: true, json: {} }) })).toEqual([])
  })
})

describe('makeCsvFeedSource', () => {
  it('fetches + parses + maps CSV rows', async () => {
    const src = makeCsvFeedSource({ url: 'https://dir.example.org/orgs.csv' })
    const fetchImpl = async () => ({ ok: true, text: 'name,email,website\nHelping Hands,info@hh.org,hh.org' })
    const c = await src.fetchCandidates({ fetchImpl, limit: 10 })
    expect(c[0]).toMatchObject({ name: 'Helping Hands', email: 'info@hh.org', website: 'hh.org' })
  })
})

describe('registerConfiguredWebSources', () => {
  it('registers the new feed sources when named', () => {
    const registered = registerConfiguredWebSources({ sources: ['json_feed', 'csv_feed', 'propublica_nonprofits'] })
    expect(registered).toEqual(expect.arrayContaining(['json_feed', 'csv_feed', 'propublica_nonprofits']))
    expect(listWebSources()).toEqual(expect.arrayContaining(['json_feed', 'csv_feed']))
  })
})
