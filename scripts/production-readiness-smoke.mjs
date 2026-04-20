#!/usr/bin/env node
/**
 * Production-readiness smoke: runs the canonical match engine against a
 * realistic opportunity corpus for each of the 6 representative profile
 * classes. Fails hard (exit 1) if ANY profile produces zero results or if
 * the engine throws.
 *
 * Invocation:  node scripts/production-readiness-smoke.mjs
 *
 * This is NOT a unit test harness; it is a runtime smoke of the real code
 * path used by /api/real-crawlers/run and /api/matching/* routes.
 */

import { computeMatchDecision, scoreOpportunity, MATCHER_VERSION } from '../backend/services/matchEngine.js'

const CORPUS = [
  {
    id: 'pell',
    title: 'Federal Pell Grant',
    description: 'Need-based federal grant for undergraduate students with financial need.',
    sponsor: 'U.S. Department of Education',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    categories: ['education', 'scholarship'],
    keywords: ['pell', 'student', 'college', 'tuition', 'financial aid'],
    opportunity_type: 'grant',
  },
  {
    id: 'liheap',
    title: 'LIHEAP Energy Assistance',
    description: 'Low Income Home Energy Assistance Program helps families with utility bills.',
    sponsor: 'U.S. Department of Health and Human Services',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://www.acf.hhs.gov/ocs/programs/liheap',
    categories: ['utilities', 'energy'],
    keywords: ['energy', 'utilities', 'heating', 'liheap', 'family', 'household'],
    opportunity_type: 'program',
  },
  {
    id: 'snap-oh',
    title: 'Ohio SNAP Benefits',
    description: 'Supplemental Nutrition Assistance Program for Ohio families needing food assistance.',
    sponsor: 'Ohio Department of Job and Family Services',
    is_national: 0,
    state: 'OH',
    application_url: 'https://jfs.ohio.gov/snap',
    categories: ['food', 'nutrition'],
    keywords: ['snap', 'food', 'ebt', 'family'],
    opportunity_type: 'program',
  },
  {
    id: 'faith-capacity',
    title: 'Faith-Based Community Partnership Grant',
    description: 'Grants for churches, ministries, and faith-based organizations serving community needs.',
    sponsor: 'Lilly Endowment',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://lillyendowment.org/apply',
    categories: ['faith', 'community', 'capacity_building'],
    keywords: ['church', 'ministry', 'faith', 'congregation', 'nonprofit'],
    opportunity_type: 'grant',
  },
  {
    id: 'nonprofit-capacity',
    title: 'Nonprofit Capacity Building Grant',
    description: 'Grants to strengthen 501(c)(3) nonprofit organizational capacity and program delivery.',
    sponsor: 'Foundation for Community Development',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://www.foundationcenter.org/grants',
    categories: ['nonprofit', 'capacity_building'],
    keywords: ['nonprofit', '501c3', 'capacity', 'organizational'],
    opportunity_type: 'grant',
  },
  {
    id: 'sba-innov',
    title: 'SBIR Phase I Small Business Innovation Grant',
    description: 'Seed funding for early-stage small businesses pursuing technology innovation.',
    sponsor: 'U.S. Small Business Administration',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://www.sbir.gov/apply',
    categories: ['business', 'innovation', 'small_business'],
    keywords: ['small business', 'sbir', 'startup', 'innovation', 'entrepreneur'],
    opportunity_type: 'grant',
  },
  {
    id: 'housing-oh',
    title: 'Ohio Emergency Rental Assistance',
    description: 'Emergency rental assistance for Ohio residents facing eviction or housing instability.',
    sponsor: 'Ohio Department of Development',
    is_national: 0,
    state: 'OH',
    application_url: 'https://development.ohio.gov/housing',
    categories: ['housing', 'emergency'],
    keywords: ['housing', 'rent', 'eviction', 'emergency'],
    opportunity_type: 'program',
  },
  {
    id: 'habitat',
    title: 'Habitat for Humanity Faith Building Fund',
    description: 'Funding for faith communities partnering with Habitat for Humanity on affordable housing projects.',
    sponsor: 'Habitat for Humanity International',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://www.habitat.org/about/get-involved/faith',
    categories: ['housing', 'faith', 'community'],
    keywords: ['housing', 'faith', 'ministry', 'church', 'community'],
    opportunity_type: 'grant',
  },
]

const PROFILES = {
  student: {
    profile: {
      id: 'smoke-student',
      applicant_type: 'student',
      primary_type: 'student',
      state: 'OH',
      postal_code: '43215',
      needs: ['education', 'scholarships'],
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215', age: 20 },
      education: { highest_level: 'high school', gpa: 3.5, field_of_study: 'Biology' },
    },
  },
  family: {
    profile: {
      id: 'smoke-family',
      applicant_type: 'individual',
      primary_type: 'individual_need',
      state: 'OH',
      postal_code: '43215',
      needs: ['food', 'utilities', 'housing'],
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215', household_size: 4, has_children: true },
      financial_information: { financial_need_level: 'High' },
    },
  },
  church: {
    profile: {
      id: 'smoke-church',
      applicant_type: 'organization',
      primary_type: 'church',
      state: 'OH',
      postal_code: '43215',
      needs: ['capacity_building', 'community_outreach'],
      entity_type: 'church',
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215' },
      organization_details: { type: 'church', name: 'Grace Community Church', mission: 'Serve the local community' },
    },
  },
  nonprofit: {
    profile: {
      id: 'smoke-nonprofit',
      applicant_type: 'nonprofit',
      primary_type: 'nonprofit',
      state: 'OH',
      postal_code: '43215',
      needs: ['capacity_building', 'program_funding'],
      entity_type: 'nonprofit',
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215' },
      organization_details: { type: 'nonprofit', name: 'Community Action Center', mission: 'Serving community needs' },
    },
  },
  business: {
    profile: {
      id: 'smoke-business',
      applicant_type: 'small_business',
      primary_type: 'small_business',
      state: 'OH',
      postal_code: '43215',
      needs: ['small_business', 'startup_funding'],
      entity_type: 'business',
    },
    sections: {
      basic_information: { state: 'OH', zip: '43215' },
      small_business_details: { business_name: 'Test Innovation LLC', years_in_business: 2, naics_code: '541511' },
    },
  },
  incomplete: {
    profile: {
      id: 'smoke-incomplete',
      applicant_type: 'individual',
      primary_type: 'individual',
      // Deliberately incomplete: no state, no postal_code, empty needs.
    },
    sections: {},
  },
}

function decisionSummary(profileKey, profileCtx) {
  const rows = []
  let accepted = 0
  let reviewed = 0
  let rejected = 0
  for (const opp of CORPUS) {
    const { score } = scoreOpportunity(profileCtx, opp)
    const decision = computeMatchDecision(profileCtx.profile, opp, {
      profileSections: profileCtx.sections,
    })
    if (decision.decision === 'ACCEPT') accepted += 1
    else if (decision.decision === 'REVIEW') reviewed += 1
    else rejected += 1
    rows.push({
      title: opp.title,
      score,
      decision: decision.decision,
      explanation: decision.explanation,
    })
  }
  rows.sort((a, b) => b.score - a.score)
  return { profileKey, accepted, reviewed, rejected, rows }
}

function print(summary) {
  console.log(`\n=== profile: ${summary.profileKey} ===`)
  console.log(
    `  counts: ACCEPT=${summary.accepted} REVIEW=${summary.reviewed} REJECT=${summary.rejected}  (total=${summary.accepted + summary.reviewed + summary.rejected})`,
  )
  const included = summary.rows.filter((r) => r.decision !== 'REJECT').slice(0, 4)
  included.forEach((r) => {
    console.log(`    [${r.decision.padEnd(6)}] score=${String(r.score).padStart(3)}  ${r.title}`)
    console.log(`              ${String(r.explanation || '').slice(0, 140)}`)
  })
}

function main() {
  console.log(`GrantFlow production-readiness smoke — matcher version ${MATCHER_VERSION}`)
  console.log(`Corpus: ${CORPUS.length} opportunities, Profiles: ${Object.keys(PROFILES).length}`)

  const summaries = []
  for (const [key, ctx] of Object.entries(PROFILES)) {
    summaries.push(decisionSummary(key, ctx))
  }
  summaries.forEach(print)

  const failures = []
  for (const s of summaries) {
    const included = s.accepted + s.reviewed
    if (s.profileKey === 'incomplete') {
      // Incomplete profile: we do NOT require non-zero ACCEPT/REVIEW, but
      // the engine MUST still run without throwing (already enforced above).
      // We still assert it did not hard-REJECT every national opportunity.
      if (s.rejected === CORPUS.length) {
        failures.push(
          `incomplete profile: every opportunity REJECTED — engine is over-filtering on missing data`,
        )
      }
      continue
    }
    if (included === 0) {
      failures.push(`profile '${s.profileKey}' produced ZERO included (ACCEPT+REVIEW) results`)
    }
  }

  console.log('\n=== summary table ===')
  for (const s of summaries) {
    console.log(
      `  ${s.profileKey.padEnd(12)} ACCEPT=${String(s.accepted).padStart(2)}  REVIEW=${String(s.reviewed).padStart(2)}  REJECT=${String(s.rejected).padStart(2)}`,
    )
  }

  if (failures.length > 0) {
    console.error('\nSMOKE FAILURE:')
    failures.forEach((f) => console.error(`  ✗ ${f}`))
    process.exit(1)
  }

  console.log('\nSMOKE PASS: every representative profile produced at least one included (ACCEPT or REVIEW) result.')
  process.exit(0)
}

main()
