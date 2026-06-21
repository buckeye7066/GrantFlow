/**
 * domainCorpusRelevance.test.js
 *
 * Proves the domain-corpus crawler is PROFILE-DRIVEN (GrantFlow goal: "use the
 * FULL profile"): selectRelevantDomainIds(signals) returns the domain corpora
 * RELEVANT to the profile and excludes clearly unrelated ones, instead of
 * blindly crawling all ~56 corpora.
 *
 *   (1) A paramedic / EMS profile selects first-responder domains
 *       (ems_equipment_grants, fire/first-responder), and does NOT select
 *       unrelated domains (lgbtq_grants, uaw_strike_relief, nursing aside).
 *   (2) A church / faith nonprofit profile selects faith/community/nonprofit
 *       domains (faith_based_grants, nonprofit_capacity_grants,
 *       community_development_grants), and does NOT select EMS / veteran-only
 *       domains.
 *   (3) Empty signals → whole registry (admin behavior).
 *   (4) Selection is never empty for a profile that has signals.
 *
 * Pure functions, no DB or network.
 */
import { describe, it, expect } from 'vitest'
import {
  selectRelevantDomainIds,
  scoreDomainRelevance,
  DOMAIN_CRAWLER_REGISTRY,
} from '../services/crawlers/domainCrawlerRegistry.js'

function signals(over = {}) {
  return {
    keywords: [],
    keywordSet: new Set(),
    occupation: new Set(),
    needs: new Set(),
    demographics: new Set(),
    military: new Set(),
    interests: new Set(),
    assistance: new Set(),
    health: new Set(),
    applicantTypes: new Set(),
    applicantType: 'individual',
    ...over,
  }
}

describe('selectRelevantDomainIds — paramedic / EMS profile', () => {
  const emsSignals = signals({
    applicantType: 'first responder',
    occupation: new Set(['paramedic', 'emt']),
    keywords: ['ems', 'paramedic', 'ambulance', 'first responder'],
    keywordSet: new Set(['ems', 'paramedic', 'ambulance', 'first responder']),
  })

  it('selects first-responder / EMS domains', () => {
    const ids = selectRelevantDomainIds(emsSignals)
    expect(ids).toContain('ems_equipment_grants')
    // category 'first responder' configs come along
    expect(ids).toContain('fire_department_funding')
    expect(ids).toContain('first_responder_mental_health_support')
  })

  it('does NOT select clearly unrelated domains', () => {
    const ids = selectRelevantDomainIds(emsSignals)
    expect(ids).not.toContain('lgbtq_grants')
    expect(ids).not.toContain('uaw_strike_relief')
    expect(ids).not.toContain('cancer_survivor_grants')
    expect(ids).not.toContain('native_american_tribal_grants')
  })
})

describe('selectRelevantDomainIds — church / faith nonprofit profile', () => {
  const faithSignals = signals({
    applicantType: 'nonprofit',
    applicantTypes: new Set(['nonprofit', 'church']),
    keywords: ['church', 'faith', 'ministry', 'congregation', 'community'],
    keywordSet: new Set(['church', 'faith', 'ministry', 'congregation', 'community']),
    needs: new Set(['nonprofit_ministry', 'community_development']),
  })

  it('selects faith / community / nonprofit domains', () => {
    const ids = selectRelevantDomainIds(faithSignals)
    expect(ids).toContain('faith_based_grants')
    expect(ids).toContain('nonprofit_capacity_grants')
    expect(ids).toContain('community_development_grants')
  })

  it('does NOT select EMS or veteran-only domains', () => {
    const ids = selectRelevantDomainIds(faithSignals)
    expect(ids).not.toContain('ems_equipment_grants')
    expect(ids).not.toContain('fire_department_funding')
    expect(ids).not.toContain('veteran_housing_grants')
    expect(ids).not.toContain('disabled_veteran_business_grants')
  })
})

describe('selectRelevantDomainIds — fallbacks', () => {
  it('returns the WHOLE registry when there are no usable signal terms', () => {
    // A truly empty signals object (no applicantType, no keywords) → admin
    // behavior: crawl the whole corpus.
    const empty = {
      keywords: [], keywordSet: new Set(), occupation: new Set(), needs: new Set(),
      demographics: new Set(), military: new Set(), interests: new Set(),
      assistance: new Set(), health: new Set(), applicantTypes: new Set(),
    }
    const ids = selectRelevantDomainIds(empty)
    expect(ids.length).toBe(DOMAIN_CRAWLER_REGISTRY.length)
  })

  it('returns the WHOLE registry when signals is null/undefined', () => {
    expect(selectRelevantDomainIds(null).length).toBe(DOMAIN_CRAWLER_REGISTRY.length)
    expect(selectRelevantDomainIds(undefined).length).toBe(DOMAIN_CRAWLER_REGISTRY.length)
  })

  it('is never empty for a profile that has signals', () => {
    const odd = signals({ keywords: ['zzz-unmatched-term'], keywordSet: new Set(['zzz-unmatched-term']) })
    const ids = selectRelevantDomainIds(odd)
    expect(ids.length).toBeGreaterThan(0)
    // The selection is a strict subset of the registry (does not invent ids).
    const all = new Set(DOMAIN_CRAWLER_REGISTRY.map((c) => c.id))
    expect(ids.every((id) => all.has(id))).toBe(true)
  })

  it('selects fewer corpora for a focused profile than the whole registry', () => {
    const ems = selectRelevantDomainIds(signals({
      occupation: new Set(['paramedic']),
      keywords: ['ems', 'paramedic'],
      keywordSet: new Set(['ems', 'paramedic']),
    }))
    expect(ems.length).toBeLessThan(DOMAIN_CRAWLER_REGISTRY.length)
  })
})

describe('new domain corpora — well-formedness', () => {
  const NEW_IDS = [
    'corporate_matching_gift_grants',
    'reentry_justice_involved_funding',
    'patient_disease_specific_assistance',
  ]

  it('the 3 new ids exist exactly once and are well-formed', () => {
    for (const id of NEW_IDS) {
      const matches = DOMAIN_CRAWLER_REGISTRY.filter((c) => c.id === id)
      expect(matches.length, `expected exactly one config for ${id}`).toBe(1)
      const cfg = matches[0]
      expect(typeof cfg.label).toBe('string')
      expect(cfg.label.length).toBeGreaterThan(0)
      expect(typeof cfg.category).toBe('string')
      expect(Array.isArray(cfg.boostSignals)).toBe(true)
      expect(cfg.boostSignals.length).toBeGreaterThan(0)
      expect(Array.isArray(cfg.directoryResources)).toBe(true)
      // each entry points to >= 3 real http(s) directory resources with titles
      expect(cfg.directoryResources.length).toBeGreaterThanOrEqual(3)
      for (const res of cfg.directoryResources) {
        expect(res.url, `${id} resource missing url`).toMatch(/^https?:\/\//)
        expect(res.url).not.toMatch(/example\.com|placeholder|TODO|xxxx/i)
        expect(typeof res.title).toBe('string')
        expect(res.title.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('selectRelevantDomainIds — new corpora routing', () => {
  const nonprofitSignals = signals({
    applicantType: 'nonprofit',
    applicantTypes: new Set(['nonprofit', 'church']),
    keywords: ['nonprofit', 'church', 'charity', 'community', 'matching gift'],
    keywordSet: new Set(['nonprofit', 'church', 'charity', 'community', 'matching gift']),
    demographics: new Set(['faith', 'congregation']),
  })

  const medicalSignals = signals({
    applicantType: 'individual',
    keywords: ['patient', 'chronic illness', 'copay', 'medication', 'diagnosis'],
    keywordSet: new Set(['patient', 'chronic illness', 'copay', 'medication', 'diagnosis']),
    health: new Set(['chronic illness', 'patient', 'medical']),
    needs: new Set(['medical_bills']),
  })

  const reentrySignals = signals({
    applicantType: 'individual',
    keywords: ['reentry', 'formerly incarcerated', 'returning citizen', 'second chance'],
    keywordSet: new Set(['reentry', 'formerly incarcerated', 'returning citizen', 'second chance']),
    assistance: new Set(['reentry', 'justice-involved']),
    needs: new Set(['reentry']),
  })

  it('routes corporate matching-gift to a nonprofit profile', () => {
    const ids = selectRelevantDomainIds(nonprofitSignals)
    expect(ids).toContain('corporate_matching_gift_grants')
  })

  it('routes patient/disease-specific assistance to a medical-need profile', () => {
    const ids = selectRelevantDomainIds(medicalSignals)
    expect(ids).toContain('patient_disease_specific_assistance')
  })

  it('routes reentry funding to a justice-involved profile', () => {
    const ids = selectRelevantDomainIds(reentrySignals)
    expect(ids).toContain('reentry_justice_involved_funding')
  })

  it('does NOT route the 3 new corpora to clearly-unrelated profiles', () => {
    const emsSignals = signals({
      applicantType: 'first responder',
      occupation: new Set(['paramedic', 'emt']),
      keywords: ['ems', 'paramedic', 'ambulance', 'first responder'],
      keywordSet: new Set(['ems', 'paramedic', 'ambulance', 'first responder']),
    })
    const emsIds = selectRelevantDomainIds(emsSignals)
    expect(emsIds).not.toContain('corporate_matching_gift_grants')
    expect(emsIds).not.toContain('patient_disease_specific_assistance')
    expect(emsIds).not.toContain('reentry_justice_involved_funding')

    // nonprofit should not pull patient-assistance or reentry
    const npIds = selectRelevantDomainIds(nonprofitSignals)
    expect(npIds).not.toContain('patient_disease_specific_assistance')
    expect(npIds).not.toContain('reentry_justice_involved_funding')

    // medical profile should not pull corporate-matching or reentry
    const medIds = selectRelevantDomainIds(medicalSignals)
    expect(medIds).not.toContain('corporate_matching_gift_grants')
    expect(medIds).not.toContain('reentry_justice_involved_funding')

    // reentry profile should not pull corporate-matching or patient-assistance
    const reIds = selectRelevantDomainIds(reentrySignals)
    expect(reIds).not.toContain('corporate_matching_gift_grants')
    expect(reIds).not.toContain('patient_disease_specific_assistance')
  })
})

describe('scoreDomainRelevance — diagnostics', () => {
  it('ranks EMS domains above unrelated ones for a paramedic', () => {
    const ranked = scoreDomainRelevance(signals({
      occupation: new Set(['paramedic']),
      keywords: ['ems', 'paramedic', 'ambulance', 'first responder'],
      keywordSet: new Set(['ems', 'paramedic', 'ambulance', 'first responder']),
    }))
    const ems = ranked.find((r) => r.id === 'ems_equipment_grants')
    const lgbtq = ranked.find((r) => r.id === 'lgbtq_grants')
    expect(ems.score).toBeGreaterThan(lgbtq.score)
  })
})
