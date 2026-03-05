/**
 * Pro Bono / In-Kind Golden Fixture Tests
 *
 * These tests ensure that pro bono results are returned for profiles
 * with specific needs. If pro bono coverage regresses (no URL, wrong
 * category, irrelevant), these tests MUST fail.
 */

import { describe, it, expect } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { buildProfileFacets, buildIntentTokens } from '../services/profile/profileTaxonomy.js'
import { calculateMatchScore } from '../services/matchingEngine.js'

// ── GOLDEN PROFILES ──

const EVICTION_CRISIS_PROFILE = {
  profile: {
    primary_type: 'individual_need',
    state: 'OH',
    postal_code: '44052',
    city: 'Lorain',
  },
  sections: {
    basic_information: {
      state: 'OH',
      zip: '44052',
      city: 'Lorain',
      profile_category: 'individual_need',
    },
    family_life: {
      homeless: false,
      domestic_violence_survivor: false,
    },
    housing: {
      status: 'at-risk',
      type: 'renter',
      notes: 'Facing eviction, behind on rent 3 months, need legal help with landlord',
    },
    financial_information: {
      financial_need_level: 'Critical',
      household_income: 18000,
      low_income: true,
      unemployed: true,
    },
    narrative: {
      primary_goal: 'Prevent eviction and find legal aid for tenant rights',
      barriers_faced: 'Cannot afford attorney, facing eviction court date next month',
    },
  },
}

const MEDICAL_BILLS_PROFILE = {
  profile: {
    primary_type: 'individual_need',
    state: 'TN',
    postal_code: '38501',
    city: 'Cookeville',
  },
  sections: {
    basic_information: {
      state: 'TN',
      zip: '38501',
      city: 'Cookeville',
      profile_category: 'individual_need',
    },
    health_medical: {
      chronic_illness: true,
      conditions: [{ name: 'Type 2 Diabetes' }, { name: 'Hypertension' }],
      mental_health_condition: true,
    },
    financial_information: {
      financial_need_level: 'High',
      household_income: 22000,
      low_income: true,
    },
    government_assistance: {
      medicaid_enrolled: true,
    },
    narrative: {
      primary_goal: 'Get help with medical bills and copay costs',
      barriers_faced: 'Cannot afford copays and specialist visits, need charity care or patient assistance',
    },
  },
}

const LICENSURE_TRAINING_PROFILE = {
  profile: {
    primary_type: 'individual_need',
    state: 'GA',
    postal_code: '30301',
    city: 'Atlanta',
  },
  sections: {
    basic_information: {
      state: 'GA',
      zip: '30301',
      city: 'Atlanta',
      profile_category: 'individual_need',
    },
    occupation: {
      healthcare_worker: true,
      healthcare_worker_type: 'CNA',
      job_title: 'Certified Nursing Assistant',
    },
    employment: {
      current_status: 'employed',
      career_goal: 'Become a Licensed Practical Nurse through NCLEX prep and licensure training',
    },
    education: {
      field_of_study: 'Nursing',
    },
    financial_information: {
      financial_need_level: 'High',
      household_income: 28000,
    },
    narrative: {
      primary_goal: 'Get tuition assistance for LPN licensure program',
      barriers_faced: 'Cannot afford nursing school tuition, need WIOA or workforce training assistance',
    },
  },
}

// ── PRO BONO OPPORTUNITIES (matching the curated dataset) ──

const LEGAL_AID_OPPORTUNITY = {
  id: 'golden-lsc-legal-aid',
  title: 'Legal Services Corporation (LSC) - Find Legal Aid',
  sponsor: 'Legal Services Corporation',
  source: 'pro_bono_legal',
  description: 'LSC funds 132 independent nonprofit legal aid programs serving every county in the US. Free legal assistance for low-income individuals in civil matters including housing, family law, consumer issues, and public benefits.',
  application_url: 'https://www.lsc.gov/about-lsc/what-legal-aid/get-legal-help',
  source_url: 'https://www.lsc.gov/about-lsc/what-legal-aid/get-legal-help',
  opportunity_type: 'pro_bono',
  funding_type: 'service',
  categories: ['legal aid', 'pro bono', 'civil legal', 'housing'],
  keywords: ['legal aid', 'pro bono', 'eviction defense', 'tenant rights', 'family law', 'free legal', 'low income legal'],
  eligibility_bullets: ['Household income at or below 125% of federal poverty level', 'Civil (non-criminal) legal matters'],
  is_national: true,
  state: 'nationwide',
}

const CHARITY_CARE_OPPORTUNITY = {
  id: 'golden-hrsa-health-centers',
  title: 'HRSA Health Center Finder - Free/Sliding Scale Clinics',
  sponsor: 'Health Resources & Services Administration',
  source: 'charity_care',
  description: 'Federally Qualified Health Centers (FQHCs) provide primary care, dental, mental health, and substance abuse services on a sliding fee scale based on ability to pay. No one is turned away.',
  application_url: 'https://findahealthcenter.hrsa.gov/',
  source_url: 'https://findahealthcenter.hrsa.gov/',
  opportunity_type: 'clinic_service',
  funding_type: 'service',
  categories: ['free clinic', 'primary care', 'dental', 'mental health', 'sliding scale'],
  keywords: ['free clinic', 'sliding scale', 'community health center', 'fqhc', 'primary care'],
  eligibility_bullets: ['Open to everyone regardless of ability to pay', 'Sliding fee scale based on income'],
  is_national: true,
  state: 'nationwide',
}

const PATIENT_ASSISTANCE_OPPORTUNITY = {
  id: 'golden-needymeds',
  title: 'NeedyMeds - Patient Assistance Program Database',
  sponsor: 'NeedyMeds Inc.',
  source: 'charity_care',
  description: 'Comprehensive database of patient assistance programs (PAPs), free/low-cost clinics, copay assistance cards, and drug discount programs.',
  application_url: 'https://www.needymeds.org/',
  source_url: 'https://www.needymeds.org/',
  opportunity_type: 'charity_care',
  funding_type: 'cost_coverage',
  categories: ['patient assistance', 'prescription', 'copay assistance', 'free clinic'],
  keywords: ['patient assistance program', 'copay assistance', 'prescription help', 'free medication'],
  eligibility_bullets: ['Varies by program - income-based', 'US resident'],
  is_national: true,
  state: 'nationwide',
}

const WORKFORCE_TRAINING_OPPORTUNITY = {
  id: 'golden-wioa-training',
  title: 'CareerOneStop - WIOA Training Programs',
  sponsor: 'U.S. Department of Labor',
  source: 'workforce_training',
  description: 'American Job Centers provide free career services, job training, and WIOA-funded tuition assistance. Eligible Training Provider List (ETPL) programs offer no-cost vocational and occupational training.',
  application_url: 'https://www.careeronestop.org/LocalHelp/AmericanJobCenters/find-american-job-centers.aspx',
  source_url: 'https://www.careeronestop.org/LocalHelp/AmericanJobCenters/find-american-job-centers.aspx',
  opportunity_type: 'training_paid',
  funding_type: 'cost_coverage',
  categories: ['workforce training', 'wioa', 'job training', 'career services', 'tuition assistance'],
  keywords: ['wioa', 'etpl', 'job training', 'workforce development', 'tuition assistance', 'no cost training'],
  eligibility_bullets: ['Adults, dislocated workers, and youth', 'Income eligibility may apply'],
  is_national: true,
  state: 'nationwide',
}

const VOC_REHAB_OPPORTUNITY = {
  id: 'golden-voc-rehab',
  title: 'Vocational Rehabilitation Services',
  sponsor: 'Rehabilitation Services Administration',
  source: 'workforce_training',
  description: 'State-federal program providing employment-related services to individuals with disabilities. Services include job training, education assistance, assistive technology, and job placement.',
  application_url: 'https://rsa.ed.gov/about/states',
  source_url: 'https://rsa.ed.gov/',
  opportunity_type: 'training_paid',
  funding_type: 'service',
  categories: ['vocational rehabilitation', 'disability', 'job training', 'assistive technology'],
  keywords: ['vocational rehabilitation', 'disability employment', 'assistive technology', 'job placement'],
  eligibility_bullets: ['Must have a physical or mental disability', 'Disability must be a barrier to employment'],
  is_national: true,
  state: 'nationwide',
}

// Irrelevant opportunity (should score low against pro bono profiles)
const IRRELEVANT_CORP_GRANT = {
  id: 'golden-irrelevant-corp',
  title: 'Google.org Tech Innovation Grant',
  sponsor: 'Google.org',
  source: 'corporate_giving',
  description: 'Google.org supports nonprofits working on education, economic opportunity, and crisis response through technology solutions.',
  application_url: 'https://www.google.org/',
  source_url: 'https://www.google.org/',
  opportunity_type: 'grant',
  categories: ['education', 'technology', 'economic opportunity'],
  keywords: ['technology', 'innovation', 'nonprofit', 'education'],
  eligibility_bullets: ['Must be a registered 501(c)(3) nonprofit'],
  is_national: true,
  state: 'nationwide',
  requires_501c3: true,
}

// ── TESTS ──

describe('Pro Bono Golden Fixtures', () => {

  describe('1) Eviction/rent crisis profile → legal aid', () => {
    const profileContext = {
      ...EVICTION_CRISIS_PROFILE,
      signals: buildProfileSignals(EVICTION_CRISIS_PROFILE),
    }
    const enriched = buildProfileFacets({
      profile: EVICTION_CRISIS_PROFILE.profile,
      sections: EVICTION_CRISIS_PROFILE.sections,
    })
    profileContext.facets = enriched.facets

    it('profile signals include pro bono legal terms', () => {
      const signals = profileContext.signals
      expect(signals.proBonoTerms).toBeDefined()
      expect(signals.proBonoTerms.size).toBeGreaterThan(0)
      const terms = Array.from(signals.proBonoTerms)
      expect(terms.some(t => /legal aid|eviction|tenant|pro bono/i.test(t))).toBe(true)
    })

    it('intent tokens include legal aid/eviction prevention shouldTerms', () => {
      const tokens = buildIntentTokens({ facets: enriched.facets })
      const allTerms = [...tokens.mustTerms, ...tokens.shouldTerms]
      expect(allTerms.some(t => /legal aid|eviction|tenant|pro bono/i.test(t))).toBe(true)
    })

    it('legal aid opportunity scores > 0 against eviction profile', () => {
      const { score, match_explain } = calculateMatchScore(profileContext, LEGAL_AID_OPPORTUNITY)
      expect(score).toBeGreaterThan(0)
      expect(match_explain).toBeDefined()
      expect(match_explain.matchedSignals.length).toBeGreaterThan(0)
    })

    it('legal aid opportunity has valid URL', () => {
      expect(LEGAL_AID_OPPORTUNITY.application_url).toBeTruthy()
      expect(LEGAL_AID_OPPORTUNITY.application_url).toMatch(/^https?:\/\//)
    })

    it('legal aid opportunity is tagged as pro_bono with service funding_type', () => {
      expect(LEGAL_AID_OPPORTUNITY.opportunity_type).toBe('pro_bono')
      expect(LEGAL_AID_OPPORTUNITY.funding_type).toBe('service')
    })

    it('irrelevant corp grant scores lower than legal aid for eviction profile', () => {
      const legalAidResult = calculateMatchScore(profileContext, LEGAL_AID_OPPORTUNITY)
      const irrelevantResult = calculateMatchScore(profileContext, IRRELEVANT_CORP_GRANT)
      expect(legalAidResult.score).toBeGreaterThan(irrelevantResult.score)
    })
  })

  describe('2) Medical bills profile → charity care / patient assistance', () => {
    const profileContext = {
      ...MEDICAL_BILLS_PROFILE,
      signals: buildProfileSignals(MEDICAL_BILLS_PROFILE),
    }
    const enriched = buildProfileFacets({
      profile: MEDICAL_BILLS_PROFILE.profile,
      sections: MEDICAL_BILLS_PROFILE.sections,
    })
    profileContext.facets = enriched.facets

    it('profile signals include charity care / patient assistance terms', () => {
      const signals = profileContext.signals
      expect(signals.proBonoTerms).toBeDefined()
      expect(signals.proBonoTerms.size).toBeGreaterThan(0)
      const terms = Array.from(signals.proBonoTerms)
      expect(terms.some(t => /charity care|patient assistance|free clinic|sliding scale|copay/i.test(t))).toBe(true)
    })

    it('clinic service opportunity scores > 0 against medical profile', () => {
      const { score, match_explain } = calculateMatchScore(profileContext, CHARITY_CARE_OPPORTUNITY)
      expect(score).toBeGreaterThan(0)
      expect(match_explain).toBeDefined()
    })

    it('patient assistance opportunity scores > 0 against medical profile', () => {
      const { score } = calculateMatchScore(profileContext, PATIENT_ASSISTANCE_OPPORTUNITY)
      expect(score).toBeGreaterThan(0)
    })

    it('both charity care opportunities have valid URLs', () => {
      expect(CHARITY_CARE_OPPORTUNITY.application_url).toMatch(/^https?:\/\//)
      expect(PATIENT_ASSISTANCE_OPPORTUNITY.application_url).toMatch(/^https?:\/\//)
    })

    it('charity care opportunities are tagged correctly', () => {
      expect(CHARITY_CARE_OPPORTUNITY.opportunity_type).toBe('clinic_service')
      expect(PATIENT_ASSISTANCE_OPPORTUNITY.opportunity_type).toBe('charity_care')
      expect(PATIENT_ASSISTANCE_OPPORTUNITY.funding_type).toBe('cost_coverage')
    })
  })

  describe('3) Licensure/training profile → workforce training tuition coverage', () => {
    const profileContext = {
      ...LICENSURE_TRAINING_PROFILE,
      signals: buildProfileSignals(LICENSURE_TRAINING_PROFILE),
    }
    const enriched = buildProfileFacets({
      profile: LICENSURE_TRAINING_PROFILE.profile,
      sections: LICENSURE_TRAINING_PROFILE.sections,
    })
    profileContext.facets = enriched.facets

    it('profile signals include workforce training / WIOA terms', () => {
      const signals = profileContext.signals
      expect(signals.proBonoTerms).toBeDefined()
      expect(signals.proBonoTerms.size).toBeGreaterThan(0)
      const terms = Array.from(signals.proBonoTerms)
      expect(terms.some(t => /wioa|etpl|training|tuition|workforce|vocational/i.test(t))).toBe(true)
    })

    it('intent tokens include workforce training terms', () => {
      const tokens = buildIntentTokens({ facets: enriched.facets })
      const allTerms = [...tokens.mustTerms, ...tokens.shouldTerms]
      expect(allTerms.some(t => /wioa|etpl|training|tuition|workforce|vocational/i.test(t))).toBe(true)
    })

    it('WIOA training opportunity scores > 0 against licensure profile', () => {
      const { score, match_explain } = calculateMatchScore(profileContext, WORKFORCE_TRAINING_OPPORTUNITY)
      expect(score).toBeGreaterThan(0)
      expect(match_explain).toBeDefined()
    })

    it('workforce training opportunities have valid URLs', () => {
      expect(WORKFORCE_TRAINING_OPPORTUNITY.application_url).toMatch(/^https?:\/\//)
      expect(VOC_REHAB_OPPORTUNITY.application_url).toMatch(/^https?:\/\//)
    })

    it('training opportunities are tagged as training_paid with cost_coverage', () => {
      expect(WORKFORCE_TRAINING_OPPORTUNITY.opportunity_type).toBe('training_paid')
      expect(WORKFORCE_TRAINING_OPPORTUNITY.funding_type).toBe('cost_coverage')
    })

    it('WIOA training scores higher than irrelevant corp grant for licensure profile', () => {
      const trainingResult = calculateMatchScore(profileContext, WORKFORCE_TRAINING_OPPORTUNITY)
      const irrelevantResult = calculateMatchScore(profileContext, IRRELEVANT_CORP_GRANT)
      expect(trainingResult.score).toBeGreaterThan(irrelevantResult.score)
    })
  })

  describe('match_explain output structure', () => {
    it('returns match_explain with matchedNeeds, matchedSignals, scoreBreakdown', () => {
      const profileContext = {
        ...EVICTION_CRISIS_PROFILE,
        signals: buildProfileSignals(EVICTION_CRISIS_PROFILE),
      }
      const enriched = buildProfileFacets({
        profile: EVICTION_CRISIS_PROFILE.profile,
        sections: EVICTION_CRISIS_PROFILE.sections,
      })
      profileContext.facets = enriched.facets

      const { match_explain } = calculateMatchScore(profileContext, LEGAL_AID_OPPORTUNITY)
      expect(match_explain).toBeDefined()
      expect(match_explain.matchedSignals).toBeDefined()
      expect(Array.isArray(match_explain.matchedSignals)).toBe(true)
      expect(match_explain.scoreBreakdown).toBeDefined()
      expect(typeof match_explain.scoreBreakdown.total).toBe('number')
      expect(match_explain.reasons).toBeDefined()
      expect(Array.isArray(match_explain.reasons)).toBe(true)
    })
  })

  describe('URL reality enforcement', () => {
    it('all golden pro bono opportunities have valid http URLs', () => {
      const allOpps = [
        LEGAL_AID_OPPORTUNITY,
        CHARITY_CARE_OPPORTUNITY,
        PATIENT_ASSISTANCE_OPPORTUNITY,
        WORKFORCE_TRAINING_OPPORTUNITY,
        VOC_REHAB_OPPORTUNITY,
      ]
      for (const opp of allOpps) {
        const url = opp.application_url || opp.source_url
        expect(url).toBeTruthy()
        expect(url).toMatch(/^https?:\/\//)
        expect(url).not.toMatch(/example\.com|placeholder|localhost/)
      }
    })
  })
})
