/**
 * NIH RePORTER prospect source — the biomedical research audience that
 * axiombiolabs.org actually speaks to (CAR-T/transplant tolerance, cell
 * therapy, CRISPR, genomics, environmental DNA).
 *
 * Verifies the source maps RePORTER institutions into Yana prospects, dedupes
 * an org that spans several topics, respects the limit, survives a per-topic
 * failure, and stays honest (no invented contact channel). Plus the scorer's
 * evidence/source-url merge that keeps a prospect's provenance. No network
 * (searchResearchOrganizations injected).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  makeNihReporterSource,
  mapResearchOrgToProspect,
  registerProspectSource,
  RESEARCH_TOPICS,
} from '../services/yana/yanaProspectSources.js'
import {
  scoreOrganizationLead,
  qualifyScore,
  discoverProspects,
  listQualifiedLeadPackets,
  _resetYanaSchemaCache,
} from '../services/yana/yanaLeadDiscovery.js'
import { interpretLead } from '../services/john/johnLeadInterpreter.js'
import { makeYanaLeadPacket } from '../services/john/johnTypes.js'

const VANDERBILT = {
  org_id: '8721001',
  name: 'VANDERBILT UNIVERSITY',
  city: 'NASHVILLE',
  state: 'TN',
  zipcode: '372032416',
  departments: ['PHARMACOLOGY'],
  topics: [
    { title: 'Toward Translation of an Immunotherapeutic Nanomedicine', fiscal_year: 2026 },
    { title: 'Donor-specific tolerance in kidney allografts', fiscal_year: 2025 },
  ],
  investigators: [{ name: 'Jane Q Researcher', title: 'PROFESSOR' }],
  project_count: 2,
  award_total: 1_250_000,
  latest_fiscal_year: 2026,
  detail_url: 'https://reporter.nih.gov/project-details/10999',
}

const ST_JUDE = {
  org_id: '7893501',
  name: "ST. JUDE CHILDREN'S RESEARCH HOSPITAL",
  city: 'MEMPHIS',
  state: 'TN',
  departments: [],
  topics: [{ title: 'Epigenetic reprogramming of T cell exhaustion', fiscal_year: 2026 }],
  investigators: [],
  project_count: 1,
  award_total: 500_000,
  latest_fiscal_year: 2026,
  detail_url: 'https://reporter.nih.gov/project-details/10111',
}

describe('mapResearchOrgToProspect', () => {
  it('derives every field from what NIH published — real titles, real PI, no invented contact', () => {
    const topic = RESEARCH_TOPICS.find((t) => t.id === 'transplant_tolerance')
    const p = mapResearchOrgToProspect(VANDERBILT, { topic })

    expect(p.source).toBe('nih_reporter')
    expect(p.external_id).toBe('8721001')
    expect(p.organization_name).toBe('VANDERBILT UNIVERSITY')
    expect(p.entity_type).toBe('research_institution')
    expect(p.location).toBe('NASHVILLE, TN')
    // Real NIH project titles become program_areas — the specifics John needs.
    expect(p.program_areas).toContain('Donor-specific tolerance in kidney allografts')
    // The contact PI NIH lists, verbatim.
    expect(p.contact_name).toBe('Jane Q Researcher')
    expect(p.contact_title).toBe('PROFESSOR')
    // Canonical GrantFlow cause tags, not ad-hoc strings.
    expect(p.focus_areas).toEqual(['health_medical'])
    // RePORTER carries no contact channel — enrichment closes that gap. Never fabricate.
    expect(p.email).toBeNull()
    expect(p.website_url).toBeNull()
    // Auditable back to the exact NIH record.
    expect(p.source_urls).toEqual(['https://reporter.nih.gov/project-details/10999'])
  })

  it('states countable facts in the mission line, not adjectives', () => {
    const topic = RESEARCH_TOPICS.find((t) => t.id === 'transplant_tolerance')
    const p = mapResearchOrgToProspect(VANDERBILT, { topic })
    expect(p.mission).toContain('2 active NIH-funded projects')
    expect(p.mission).toContain('transplant immunology and immune tolerance')
    expect(p.mission).toContain('FY2026')
    // Long enough for the scorer to credit has_mission_statement (>= 30 chars).
    expect(p.mission.length).toBeGreaterThanOrEqual(30)
  })

  it('drops a row with no stable org id or name', () => {
    expect(mapResearchOrgToProspect(null)).toBeNull()
    expect(mapResearchOrgToProspect({ name: 'No Id Inc' })).toBeNull()
    expect(mapResearchOrgToProspect({ org_id: '1' })).toBeNull()
  })
})

describe('makeNihReporterSource', () => {
  it('discovers prospects across the axiom-aligned topics, tagged source=nih_reporter', async () => {
    const src = makeNihReporterSource({ searchResearchOrganizations: async () => [VANDERBILT, ST_JUDE] })
    const out = await src.discover({ limit: 10 })
    expect(out.length).toBe(2) // same two orgs returned per topic → deduped
    expect(out.every((p) => p.source === 'nih_reporter')).toBe(true)
    expect(out.map((p) => p.organization_name)).toContain('VANDERBILT UNIVERSITY')
  })

  it('dedupes one institution that spans several research topics', async () => {
    const calls = []
    const src = makeNihReporterSource({
      searchResearchOrganizations: async ({ text }) => { calls.push(text); return [VANDERBILT] },
    })
    const out = await src.discover({ limit: 50 })
    expect(calls.length).toBe(RESEARCH_TOPICS.length) // every topic searched
    expect(out.length).toBe(1) // but the org appears once
  })

  it('searches only RECENT fiscal years so leads reference current work', async () => {
    let seenFy = null
    const src = makeNihReporterSource({
      searchResearchOrganizations: async ({ fiscalYears }) => { seenFy = fiscalYears; return [] },
    })
    await src.discover({ limit: 5 })
    const thisYear = new Date().getFullYear()
    expect(seenFy).toEqual([thisYear - 1, thisYear])
  })

  it('passes an explicit state filter through, but sends none by default (national)', async () => {
    let seenStates = 'unset'
    const src = makeNihReporterSource({
      searchResearchOrganizations: async ({ states }) => { seenStates = states; return [] },
    })
    await src.discover({ limit: 5 })
    expect(seenStates).toBeNull() // national by default

    await src.discover({ limit: 5, states: ['TN', 'OH'] })
    expect(seenStates).toEqual(['TN', 'OH'])
  })

  it('survives one topic failing and still returns the other topics', async () => {
    const src = makeNihReporterSource({
      searchResearchOrganizations: async ({ text }) => {
        if (text.includes('CRISPR')) throw new Error('rate limited')
        return [VANDERBILT]
      },
    })
    const out = await src.discover({ limit: 50 })
    expect(out.length).toBe(1) // not an empty run, not a throw
  })

  it('respects the limit', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...VANDERBILT, org_id: `org-${i}`, name: `Institute ${i}` }))
    const src = makeNihReporterSource({ searchResearchOrganizations: async () => many })
    const out = await src.discover({ limit: 4 })
    expect(out.length).toBe(4)
  })
})

describe('a research prospect through the existing qualify funnel', () => {
  it('lands needs_enrichment (real identity, no contact channel) — never auto-qualified', () => {
    const topic = RESEARCH_TOPICS.find((t) => t.id === 'transplant_tolerance')
    const scored = scoreOrganizationLead(mapResearchOrgToProspect(VANDERBILT, { topic }))

    expect(scored.hasEmail).toBe(false)
    expect(qualifyScore(scored).qualified).toBe(false)
    // Identity signal is intact, so prospectStatus routes it to enrichment.
    expect(scored.entity_type).toBe('research_institution')
    expect(scored.public_evidence.length).toBeGreaterThan(0)
    expect(scored.reasons).toContain('has_mission_statement')
    expect(scored.reasons).toContain('has_focus_or_program_areas')
  })

  it('qualifies once enrichment finds a real published contact channel', () => {
    const topic = RESEARCH_TOPICS.find((t) => t.id === 'transplant_tolerance')
    const prospect = mapResearchOrgToProspect(VANDERBILT, { topic })
    const scored = scoreOrganizationLead({
      ...prospect,
      email: 'research@vanderbilt.edu',
      website_url: 'https://vanderbilt.edu',
      website: 'https://vanderbilt.edu',
    })
    expect(qualifyScore(scored).qualified).toBe(true)
  })

  it('carries the named PI ON the contact point, so it survives John\'s packet allowlist', async () => {
    _resetYanaSchemaCache()
    const db = new Database(':memory:')
    const topic = RESEARCH_TOPICS.find((t) => t.id === 'transplant_tolerance')
    registerProspectSource('nih_reporter', {
      name: 'nih_reporter',
      async discover() {
        // As enrichment leaves it: the NIH prospect plus a found contact channel.
        return [{
          ...mapResearchOrgToProspect(VANDERBILT, { topic }),
          email: 'research@vanderbilt.edu',
          website: 'https://vanderbilt.edu',
          website_url: 'https://vanderbilt.edu',
        }]
      },
    })
    await discoverProspects(db, { allowLiveWeb: true, sources: ['nih_reporter'], limit: 5, enricher: { enabled: false } })

    const [packet] = await listQualifiedLeadPackets(db)
    const emailPoint = packet.contact_points.find((p) => p.type === 'email')
    // John's selectContactPoint reads name/role from the CONTACT POINT.
    expect(emailPoint.name).toBe('Jane Q Researcher')
    expect(emailPoint.role).toBe('PROFESSOR')

    // The name must survive John's strict field allowlist (which drops the
    // separate contact_person field) and reach a real salutation.
    const johnLead = makeYanaLeadPacket(packet)
    expect(interpretLead(johnLead).salutation).toBe('Hello Jane,')
  })

  it('keeps the NIH audit URL and evidence the mapper gathered (provenance merge)', () => {
    const topic = RESEARCH_TOPICS.find((t) => t.id === 'transplant_tolerance')
    const scored = scoreOrganizationLead(mapResearchOrgToProspect(VANDERBILT, { topic }))
    // The scorer rebuilds evidence from raw columns; the source's own evidence
    // and profile URL must survive rather than being silently dropped.
    expect(scored.source_urls).toContain('https://reporter.nih.gov/project-details/10999')
    expect(scored.public_evidence.some((e) => e.type === 'nih_awards')).toBe(true)
    expect(scored.public_evidence.some((e) => e.type === 'principal_investigators')).toBe(true)
    // The named PI reaches John's packet as a real contact.
    const contact = scored.public_evidence.find((e) => e.type === 'contact')
    expect(contact?.name).toBe('Jane Q Researcher')
  })
})
