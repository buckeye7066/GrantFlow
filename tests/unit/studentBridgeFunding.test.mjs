/**
 * Unit tests for the student bridge funding capability:
 *   - calendar.js         (cycle derivation)
 *   - schoolResolver.js   (target school selection + enrichment)
 *   - templates.js        (deterministic template list)
 *   - expander.js         (end-to-end profile → opportunities)
 *
 * Validates the contract that for every student profile we render a
 * meaningful set of off-campus / move-in / emergency-bridge opportunities
 * with deadlines tied to the right academic cycle.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveStudentCycle } from '../../backend/services/studentBridgeFunding/calendar.js'
import { resolveTargetSchool } from '../../backend/services/studentBridgeFunding/schoolResolver.js'
import { STUDENT_BRIDGE_FUNDING_TEMPLATES } from '../../backend/services/studentBridgeFunding/templates.js'
import { expandStudentBridgeFunding } from '../../backend/services/studentBridgeFunding/expander.js'
import { isPipelineSourceAllowed } from '../../backend/config/pipelineAllowedSources.js'

const DEMO_STUDENT_PROFILE = {
  id: 'test-profile',
  primary_type: 'individual',
  display_name: 'Demo Student Test',
}

const DEMO_STUDENT_SECTIONS = {
  basic_information: {
    state: 'TN',
    city: 'Cleveland',
    county: 'Bradley County',
    zip_code: '37312',
    academic_status: { education_level: 'High School Senior', act_score: 28, gpa: 3.84 },
  },
  education: {
    target_colleges: ['Middle Tennessee State University', 'University of Central Florida'],
  },
  university_applications: {
    applications: [
      { name: 'Middle Tennessee State University', status: 'planning' },
      { name: 'University of Central Florida', status: 'planning' },
    ],
  },
}

// ─── calendar.js ──────────────────────────────────────────────────────────

test('calendar: HS senior in May → Fall enrollment THIS year', () => {
  const out = deriveStudentCycle({
    profile: DEMO_STUDENT_PROFILE,
    sections: DEMO_STUDENT_SECTIONS,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  assert.equal(out.isStudent, true)
  assert.equal(out.enrollmentYear, 2026)
  assert.equal(out.academicCycle, '2026-27')
  assert.equal(out.cycleDeadlines.fafsa_close, '2027-06-30')
  // TN-specific aid priority
  assert.equal(out.cycleDeadlines.state_aid_priority, '2026-04-15')
  assert.equal(out.cycleDeadlines.state_grant_app, '2026-08-01')
  // Move-in window covers July
  assert.equal(out.moveInWindow.start, '2026-07-15')
  // Bridge gap > 0 days
  assert.ok(out.bridgeGapDays >= 30, `bridgeGapDays=${out.bridgeGapDays} should be ≥30`)
})

test('calendar: HS senior in October → Fall enrollment NEXT year', () => {
  const out = deriveStudentCycle({
    profile: DEMO_STUDENT_PROFILE,
    sections: DEMO_STUDENT_SECTIONS,
    today: new Date('2026-10-15T00:00:00Z'),
  })
  assert.equal(out.enrollmentYear, 2027)
  assert.equal(out.academicCycle, '2027-28')
})

test('calendar: HS junior → Fall enrollment NEXT year', () => {
  const sections = {
    ...DEMO_STUDENT_SECTIONS,
    basic_information: {
      ...DEMO_STUDENT_SECTIONS.basic_information,
      academic_status: { education_level: 'High School Junior' },
    },
  }
  const out = deriveStudentCycle({
    profile: DEMO_STUDENT_PROFILE,
    sections,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  assert.equal(out.enrollmentYear, 2027)
})

test('calendar: non-student profile → isStudent=false', () => {
  const out = deriveStudentCycle({
    profile: { id: 'x', primary_type: 'individual' },
    sections: { basic_information: { state: 'TN' } },
    today: new Date('2026-05-13T00:00:00Z'),
  })
  assert.equal(out.isStudent, false)
})

test('calendar: defaults to national pattern for unlisted state', () => {
  const sections = {
    ...DEMO_STUDENT_SECTIONS,
    basic_information: { ...DEMO_STUDENT_SECTIONS.basic_information, state: 'WY' },
  }
  const out = deriveStudentCycle({
    profile: DEMO_STUDENT_PROFILE,
    sections,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  assert.equal(out.cycleDeadlines.state_aid_priority, '2026-04-15')
  assert.equal(out.cycleDeadlines.state_grant_app, '2026-08-01')
})

// ─── schoolResolver.js ────────────────────────────────────────────────────

test('schoolResolver: picks accepted MTSU over planning UCF', () => {
  const sections = {
    university_applications: {
      applications: [
        { name: 'University of Central Florida', status: 'planning' },
        { name: 'Middle Tennessee State University', status: 'accepted' },
      ],
    },
  }
  const school = resolveTargetSchool({ profile: DEMO_STUDENT_PROFILE, sections })
  assert.equal(school.name, 'Middle Tennessee State University')
  assert.equal(school.state, 'TN')
  assert.equal(school.city, 'Murfreesboro')
  assert.equal(school.county, 'Rutherford County')
  assert.ok(school.portals?.financialAid?.startsWith('https://www.mtsu.edu/'))
})

test('schoolResolver: known school beats unknown school at the same status', () => {
  const sections = {
    university_applications: {
      applications: [
        { name: "Some Tiny College No One Has Heard Of", status: 'planning' },
        { name: 'Middle Tennessee State University', status: 'planning' },
      ],
    },
  }
  const school = resolveTargetSchool({ profile: DEMO_STUDENT_PROFILE, sections })
  assert.equal(school.name, 'Middle Tennessee State University')
})

test('schoolResolver: returns null for non-student profile', () => {
  const out = resolveTargetSchool({
    profile: { id: 'x' },
    sections: {},
  })
  assert.equal(out, null)
})

test('schoolResolver: falls back to education.target_colleges when no applications block', () => {
  const sections = { education: { target_colleges: ['Middle Tennessee State University'] } }
  const school = resolveTargetSchool({ profile: DEMO_STUDENT_PROFILE, sections })
  assert.equal(school.name, 'Middle Tennessee State University')
  assert.equal(school.state, 'TN')
})

// ─── templates.js ─────────────────────────────────────────────────────────

test('templates: every template has stable id, category, source, build()', () => {
  const seen = new Set()
  for (const t of STUDENT_BRIDGE_FUNDING_TEMPLATES) {
    assert.ok(t.id, `template missing id: ${JSON.stringify(t)}`)
    assert.ok(!seen.has(t.id), `duplicate template id: ${t.id}`)
    seen.add(t.id)
    assert.ok(t.category, `template ${t.id} missing category`)
    assert.ok(t.source, `template ${t.id} missing source`)
    assert.equal(typeof t.matchScore, 'number', `template ${t.id} matchScore must be number`)
    assert.equal(typeof t.build, 'function', `template ${t.id} missing build()`)
    assert.ok(
      isPipelineSourceAllowed(t.source),
      `template ${t.id} source "${t.source}" is not in pipelineAllowedSources.js`,
    )
  }
})

test('templates: NO template is a loan (mission rule: no funding requiring repayment)', () => {
  const loanLike = STUDENT_BRIDGE_FUNDING_TEMPLATES.filter((t) => {
    if (t.isLoan === true) return true
    const cat = String(t.category || '').toLowerCase()
    if (cat.includes('loan')) return true
    const id = String(t.id || '').toLowerCase()
    if (id.includes('loan')) return true
    return false
  })
  assert.equal(
    loanLike.length,
    0,
    `Found ${loanLike.length} loan-like template(s): ${loanLike.map((t) => t.id).join(', ')} — GrantFlow must NEVER recommend funding requiring repayment`,
  )
})

test('templates: every rendered opportunity_data is grant-shaped (no repayment language)', () => {
  // Render every template against a generic TN HS-senior context and walk the
  // built opportunity_data for repayment red-flags in the description / title /
  // category. This catches a contributor accidentally adding a private loan,
  // income-share agreement, or "loan forgiveness with repayment" entry.
  const ctx = {
    profile: { id: 'test-loan-guard' },
    sections: {},
    calendar: {
      academicCycle: '2026-27',
      enrollmentYear: 2026,
      classesStartEstimate: '2026-08-24',
      moveInWindow: { start: '2026-07-15', end: '2026-08-20' },
      refundWindow: { start: '2026-08-25', end: '2026-09-15' },
      bridgeGapDays: 35,
      cycleDeadlines: {
        fafsa_priority: '2026-03-01',
        fafsa_close: '2027-06-30',
        state_aid_priority: '2026-04-15',
        state_grant_app: '2026-08-01',
        school_priority: null,
      },
    },
    school: {
      name: 'Middle Tennessee State University',
      website: 'https://www.mtsu.edu',
      portals: {
        financialAid: 'https://www.mtsu.edu/financial-aid/',
        deanOfStudentsEmergencyFund: 'https://www.mtsu.edu/dean-of-students/emergency-fund.php',
        oneStop: 'https://www.mtsu.edu/one-stop/',
        offCampusHousing: 'https://offcampushousing.mtsu.edu/',
      },
    },
    state: 'TN',
    county: 'Rutherford County',
    collegeState: 'TN',
    collegeCounty: 'Rutherford County',
    collegeTown: 'Murfreesboro',
    homeState: 'TN',
    homeCounty: 'Bradley County',
    homeCity: 'Cleveland',
    today: new Date('2026-05-13T00:00:00Z'),
  }

  // Words/phrases that signal a repayment-required product. Excludes the word
  // "loan" itself only when it appears in a forgiveness / grant context — but
  // since we already disallow loan templates entirely, finding the word at all
  // in a built opportunity is a regression.
  const FORBIDDEN_REPAYMENT_PATTERNS = [
    /\bloan\b/i,
    /\binterest rate\b/i,
    /\bmonthly payment\b/i,
    /\brepay\b/i,
    /\bfinanced\b/i,
    /\bborrow\b/i,
    /\bprincipal balance\b/i,
    /\bincome[- ]share agreement\b/i,
    /\bisa\b/i,
    /\bcosigner\b/i,
  ]

  const violations = []
  for (const tpl of STUDENT_BRIDGE_FUNDING_TEMPLATES) {
    let applies = true
    try { applies = typeof tpl.appliesIf === 'function' ? tpl.appliesIf(ctx) : true } catch { applies = false }
    if (!applies) continue

    let built
    try { built = tpl.build(ctx) } catch { continue }
    if (!built) continue

    const haystack = [built.title, built.description, built.applicationNote, built.sponsor]
      .filter(Boolean)
      .join(' \n ')

    for (const pattern of FORBIDDEN_REPAYMENT_PATTERNS) {
      if (pattern.test(haystack)) {
        violations.push({ id: tpl.id, pattern: String(pattern), snippet: haystack.match(pattern)?.[0] })
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} template(s) with repayment language: ${JSON.stringify(violations, null, 2)}`,
  )
})

test('templates: at least 6 universal templates fire for any student', () => {
  const universal = STUDENT_BRIDGE_FUNDING_TEMPLATES.filter((t) => t.id.startsWith('universal-'))
  assert.ok(universal.length >= 6, `expected ≥6 universal templates, got ${universal.length}`)
})

test('templates: TN-specific and FL-specific state templates exist', () => {
  const ids = STUDENT_BRIDGE_FUNDING_TEMPLATES.map((t) => t.id)
  assert.ok(ids.includes('state-tn-hope'), 'missing TN HOPE template')
  assert.ok(ids.includes('state-fl-bright-futures'), 'missing FL Bright Futures template')
  assert.ok(ids.includes('state-liheap'), 'missing state LIHEAP template')
})

test('templates: school + county templates exist', () => {
  const ids = STUDENT_BRIDGE_FUNDING_TEMPLATES.map((t) => t.id)
  assert.ok(ids.includes('school-dean-emergency-fund'))
  assert.ok(ids.includes('school-one-stop-cash-advance'))
  assert.ok(ids.includes('county-united-way-college-town'))
  assert.ok(ids.includes('county-salvation-army-college-town'))
  assert.ok(ids.includes('county-dhs-college'))
})

// ─── expander.js (end-to-end) ─────────────────────────────────────────────

test('expander: TN HS senior to MTSU yields 12+ opportunities with TN/MTSU specifics', () => {
  const out = expandStudentBridgeFunding({
    profile: DEMO_STUDENT_PROFILE,
    sections: DEMO_STUDENT_SECTIONS,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  assert.equal(out.isStudent, true)
  assert.equal(out.calendar.enrollmentYear, 2026)
  assert.equal(out.collegeState, 'TN')
  assert.equal(out.collegeCounty, 'Rutherford County')
  assert.equal(out.school.name, 'Middle Tennessee State University')
  assert.ok(out.opportunities.length >= 12, `expected ≥12 opportunities, got ${out.opportunities.length}`)

  const ids = out.opportunities.map((o) => o.template_id)
  for (const required of [
    'universal-fafsa',
    'universal-pell-grant',
    'universal-fseog',
    'universal-modest-needs',
    'universal-211',
    'state-tn-hope',
    'state-tn-aspire',
    'state-tn-tsaa',
    'state-housing-finance-thda',
    'state-liheap',
    'school-dean-emergency-fund',
    'school-one-stop-cash-advance',
    'school-off-campus-housing-portal',
    'county-united-way-college-town',
    'county-salvation-army-college-town',
    'county-catholic-charities',
    'county-dhs-college',
  ]) {
    assert.ok(ids.includes(required), `missing required template ${required} in expansion`)
  }

  // No FL templates should fire (we're TN).
  const flTemplate = out.opportunities.find((o) => o.template_id === 'state-fl-bright-futures')
  assert.equal(flTemplate, undefined, 'FL template incorrectly fired for TN student')
})

test('expander: every rendered opportunity has correct cycle deadlines (no 2027-cycle leakage)', () => {
  const out = expandStudentBridgeFunding({
    profile: DEMO_STUDENT_PROFILE,
    sections: DEMO_STUDENT_SECTIONS,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  for (const opp of out.opportunities) {
    if (!opp.opportunity_data.deadline) continue // rolling deadlines OK
    const deadline = String(opp.opportunity_data.deadline)
    // Allow 2026 (this cycle) and 2027 (FAFSA close = 2027-06-30); reject anything later.
    assert.ok(
      deadline.startsWith('2026-') || deadline === '2027-06-30',
      `template ${opp.template_id} has bad deadline ${deadline} (expected 2026-*)`,
    )
  }
})

test('expander: FL student gets FL templates and no TN HOPE', () => {
  const sections = {
    basic_information: {
      state: 'FL',
      city: 'Orlando',
      county: 'Orange County',
      zip_code: '32801',
      academic_status: { education_level: 'High School Senior' },
    },
    education: { target_colleges: ['University of Central Florida'] },
    university_applications: {
      applications: [{ name: 'University of Central Florida', status: 'accepted' }],
    },
  }
  const out = expandStudentBridgeFunding({
    profile: { id: 'fl-student', primary_type: 'individual' },
    sections,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  assert.equal(out.collegeState, 'FL')
  const ids = out.opportunities.map((o) => o.template_id)
  assert.ok(ids.includes('state-fl-bright-futures'))
  assert.ok(!ids.includes('state-tn-hope'))
})

test('expander: every opportunity uses an allowed pipeline source', () => {
  const out = expandStudentBridgeFunding({
    profile: DEMO_STUDENT_PROFILE,
    sections: DEMO_STUDENT_SECTIONS,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  for (const opp of out.opportunities) {
    assert.ok(
      isPipelineSourceAllowed(opp.opportunity_data.source),
      `template ${opp.template_id} source ${opp.opportunity_data.source} not allowed`,
    )
  }
})

test('expander: non-student profile yields zero opportunities', () => {
  const out = expandStudentBridgeFunding({
    profile: { id: 'biz', primary_type: 'business' },
    sections: { basic_information: { state: 'TN' } },
    today: new Date('2026-05-13T00:00:00Z'),
  })
  assert.equal(out.isStudent, false)
  assert.equal(out.opportunities.length, 0)
})

test('expander: idempotent template list — running twice yields identical result', () => {
  const a = expandStudentBridgeFunding({
    profile: DEMO_STUDENT_PROFILE,
    sections: DEMO_STUDENT_SECTIONS,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  const b = expandStudentBridgeFunding({
    profile: DEMO_STUDENT_PROFILE,
    sections: DEMO_STUDENT_SECTIONS,
    today: new Date('2026-05-13T00:00:00Z'),
  })
  assert.equal(a.opportunities.length, b.opportunities.length)
  for (let i = 0; i < a.opportunities.length; i++) {
    assert.equal(a.opportunities[i].template_id, b.opportunities[i].template_id)
    assert.equal(a.opportunities[i].opportunity_data.title, b.opportunities[i].opportunity_data.title)
    assert.equal(a.opportunities[i].opportunity_data.deadline, b.opportunities[i].opportunity_data.deadline)
  }
})
