/**
 * Regression tests for the application-style classifier and the
 * deterministic section builders that ship with each style.
 *
 * Background
 * ----------
 * The auto-populate engine used to ship the same 7 sections (cover letter,
 * needs statement, project narrative, **budget justification**, applicant
 * background, evaluation, submission instructions) for every grant. That
 * produced confidently-wrong output for non-discretionary aid: the LLM
 * happily generated a "$10,000 budget justification" for a FAFSA-driven
 * university financial aid program that accepts neither budgets nor
 * narratives. The user reported that exact failure mode for an MTSU
 * student-aid application — the document read like a real proposal but
 * mapped to nothing the funder would ever read.
 *
 * The fix is two parts:
 *   1. Classify each application by its real submission style
 *      (FAFSA-driven, profile auto-match, nomination, invitation, none,
 *      or standard discretionary grant).
 *   2. Ship a *workable* set of sections per style — for FAFSA aid that
 *      means deterministic FAFSA steps + a school aid office contact
 *      block + a verification document checklist, NOT a fabricated
 *      budget. The deterministic builders never call the LLM, so they
 *      cannot hallucinate.
 *
 * These tests pin both contracts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const applyEngine = await import('../../backend/apply/applyEngine.js')
const { classifyApplicationStyle, buildDefaultSectionsForStyle, generateApplicationSections } =
  applyEngine

// ---------------------------------------------------------------------------
// classifyApplicationStyle
// ---------------------------------------------------------------------------

test('explicit application_method always wins over heuristics', () => {
  for (const method of [
    'auto_fafsa',
    'auto_profile',
    'nomination',
    'invitation',
    'no_application',
  ]) {
    assert.equal(
      classifyApplicationStyle({ application_method: method }, null),
      method,
      `expected explicit method ${method} to be respected`,
    )
  }
})

test('falls back to "standard" when no method is on file and no heuristics match', () => {
  assert.equal(classifyApplicationStyle({}, {}), 'standard')
  assert.equal(classifyApplicationStyle(null, null), 'standard')
  assert.equal(
    classifyApplicationStyle(
      { funder: 'Lorain Community Foundation', title: 'Emergency Family Assistance' },
      null,
    ),
    'standard',
  )
})

test('detects university financial aid as auto_fafsa even without an explicit method', () => {
  // The exact shape that crashed quality in production: a row created
  // for a school's financial aid office.
  const grant = {
    funder: 'Middle Tennessee State University',
    title: 'MTSU Financial Aid',
  }
  assert.equal(classifyApplicationStyle(grant, null), 'auto_fafsa')

  // Variations on the same theme.
  assert.equal(
    classifyApplicationStyle(
      { funder: 'Ohio State University', title: 'Need-Based Tuition Assistance' },
      null,
    ),
    'auto_fafsa',
  )
  assert.equal(
    classifyApplicationStyle(
      { funder: 'Lorain County Community College', title: 'Institutional Aid' },
      null,
    ),
    'auto_fafsa',
  )
})

test('case-insensitive on application_method strings', () => {
  assert.equal(
    classifyApplicationStyle({ application_method: 'AUTO_FAFSA' }, null),
    'auto_fafsa',
  )
  assert.equal(
    classifyApplicationStyle({ application_method: '  Nomination  ' }, null),
    'nomination',
  )
})

// ---------------------------------------------------------------------------
// buildDefaultSectionsForStyle
// ---------------------------------------------------------------------------

test('auto_fafsa style ships FAFSA-specific sections and NO budget_justification', () => {
  const sections = buildDefaultSectionsForStyle('auto_fafsa')
  const keys = sections.map((s) => s.section_key)
  assert.ok(keys.includes('fafsa_steps'), 'must include fafsa_steps')
  assert.ok(keys.includes('school_aid_office'), 'must include school_aid_office')
  assert.ok(keys.includes('document_checklist'), 'must include document_checklist')
  assert.ok(keys.includes('submission_instructions'), 'must include submission_instructions')
  assert.ok(
    !keys.includes('budget_justification'),
    'FAFSA-driven aid does not accept a budget justification',
  )
  assert.ok(!keys.includes('cover_letter'), 'FAFSA-driven aid does not need a cover letter')
  assert.ok(
    !keys.includes('project_narrative'),
    'FAFSA-driven aid does not need a project narrative',
  )
})

test('nomination style ships nomination-specific sections and NO discretionary proposal', () => {
  const keys = buildDefaultSectionsForStyle('nomination').map((s) => s.section_key)
  assert.ok(keys.includes('nomination_path'))
  assert.ok(keys.includes('nominator_outreach'))
  assert.ok(!keys.includes('budget_justification'))
  assert.ok(!keys.includes('project_narrative'))
})

test('invitation style ships only an invitation_status + submission section', () => {
  const keys = buildDefaultSectionsForStyle('invitation').map((s) => s.section_key)
  assert.ok(keys.includes('invitation_status'))
  assert.ok(!keys.includes('budget_justification'))
})

test('no_application style ships exactly one section', () => {
  const sections = buildDefaultSectionsForStyle('no_application')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].section_key, 'no_application_required')
})

test('standard style preserves the historical 7-section discretionary-grant proposal', () => {
  const keys = buildDefaultSectionsForStyle('standard').map((s) => s.section_key)
  for (const expected of [
    'cover_letter',
    'needs_statement',
    'project_narrative',
    'budget_justification',
    'organization_background',
    'evaluation_plan',
    'submission_instructions',
  ]) {
    assert.ok(keys.includes(expected), `standard must include ${expected}`)
  }
})

test('medical_necessity is appended only when requested for the standard style', () => {
  const without = buildDefaultSectionsForStyle('standard', { medNecRequired: false })
    .map((s) => s.section_key)
  const withIt = buildDefaultSectionsForStyle('standard', { medNecRequired: true })
    .map((s) => s.section_key)
  assert.ok(!without.includes('medical_necessity'))
  assert.ok(withIt.includes('medical_necessity'))
})

// ---------------------------------------------------------------------------
// generateApplicationSections — deterministic path must NEVER call the LLM
// ---------------------------------------------------------------------------

function makeOpenAIThatMustNotBeCalled() {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error('LLM was called for a deterministic section — this is a regression')
        },
      },
    },
  }
}

test('FAFSA-style auto-populate produces grounded, deterministic text without ever calling the LLM', async () => {
  const grant = {
    application_method: 'auto_fafsa',
    funder: 'Middle Tennessee State University',
    title: 'MTSU Financial Aid',
    funder_address:
      'Middle Tennessee State University\nOffice of Financial Aid\n1301 East Main Street\nMurfreesboro, TN 37132',
    funder_phone: '(615) 898-2830',
    funder_fax: '(615) 898-5984',
    application_url: 'https://www.mtsu.edu/financial-aid/',
    deadline: '2026-06-30',
  }
  const profile = {
    display_name: 'Demo Tennessee STEM Student',
    state: 'TN',
    sections: { financial_information: { household_size: 7, annual_income: 56000 } },
  }
  const sectionDefs = buildDefaultSectionsForStyle('auto_fafsa')

  const result = await generateApplicationSections(null, grant, null, profile, sectionDefs, {
    openaiOverride: makeOpenAIThatMustNotBeCalled(),
  })

  // Every section must contain real, traceable content — not an empty string,
  // not a placeholder, not a fabricated dollar amount.
  for (const def of sectionDefs) {
    const text = result[def.section_key]
    assert.equal(typeof text, 'string', `${def.section_key} must be a string`)
    assert.ok(text.length > 0, `${def.section_key} must not be empty`)
    assert.ok(
      !/\[INSERT|TBD|placeholder/i.test(text),
      `${def.section_key} must not contain placeholders (got: ${text.slice(0, 80)}…)`,
    )
  }

  // FAFSA steps must point to studentaid.gov, not invent a portal.
  assert.match(result.fafsa_steps, /studentaid\.gov/i)
  assert.match(result.fafsa_steps, /MTSU|Middle Tennessee State University/)

  // School aid office must surface the real address + phone we passed in.
  assert.match(result.school_aid_office, /Murfreesboro/)
  assert.match(result.school_aid_office, /\(615\) 898-2830/)

  // Document checklist must include FAFSA verification staples (1040, W-2).
  assert.match(result.document_checklist, /1040/)
  assert.match(result.document_checklist, /W-?2/i)

  // Critically: no "Budget Justification" section is shipped. The user
  // reported exactly this shape ("$10,000 budget justification for MTSU")
  // as the bug we are fixing — the section must not appear in the output
  // map at all.
  assert.equal(
    result.budget_justification,
    undefined,
    'auto_fafsa must NOT emit a budget_justification section',
  )
  // No FAFSA-section text may invent dollar amounts. (The deterministic
  // text is allowed to use the phrase "budget justification" in its
  // *explanation* of why we are not writing one — we only care about
  // fabricated numbers and synthetic line items here.)
  const allText = Object.values(result).join('\n')
  assert.ok(
    !/\$\s*\d/.test(allText),
    `no FAFSA section may contain fabricated dollar amounts (got fragment: ${allText.match(/.{0,40}\$\s*\d.{0,40}/)?.[0] || ''})`,
  )
  assert.ok(
    !/(tuition|books|transportation|living expenses)\s*[:\-]\s*\$/i.test(allText),
    'no FAFSA section may contain fabricated tuition/books/transportation/living-expense line items',
  )
})

test('nomination-style auto-populate ships outreach guidance and never calls the LLM', async () => {
  const grant = {
    application_method: 'nomination',
    funder: 'Acme Foundation',
    title: 'Rural Leaders Award',
  }
  const profile = { display_name: 'Jordan Q. Sample' }
  const sectionDefs = buildDefaultSectionsForStyle('nomination')

  const result = await generateApplicationSections(null, grant, null, profile, sectionDefs, {
    openaiOverride: makeOpenAIThatMustNotBeCalled(),
  })

  assert.match(result.nomination_path, /nomination only|nomination-only|nomination/i)
  assert.match(result.nominator_outreach, /Jordan Q\. Sample/)
  assert.equal(result.budget_justification, undefined)
})

test('invitation style produces a clear "do not submit" posture', async () => {
  const grant = { application_method: 'invitation', title: 'Closed Cohort Fellowship' }
  const sections = buildDefaultSectionsForStyle('invitation')
  const result = await generateApplicationSections(null, grant, null, null, sections, {
    openaiOverride: makeOpenAIThatMustNotBeCalled(),
  })
  assert.match(result.invitation_status, /invitation/i)
  assert.match(result.invitation_status, /do not submit|do not contact|wait/i)
})

test('no_application style produces exactly one explanatory section, no LLM call', async () => {
  const grant = { application_method: 'no_application', title: 'Auto-Disbursed Stipend' }
  const sections = buildDefaultSectionsForStyle('no_application')
  const result = await generateApplicationSections(null, grant, null, null, sections, {
    openaiOverride: makeOpenAIThatMustNotBeCalled(),
  })
  assert.equal(Object.keys(result).filter((k) => result[k]).length, 1)
  assert.match(result.no_application_required, /does not accept|no application/i)
})

// ---------------------------------------------------------------------------
// scholarship style — the DECLARED opportunity kind drives the section shape
// ---------------------------------------------------------------------------
// Operator-reported regression these tests pin (2026-08-03): the HOPE
// Scholarship and an AAFS scholarship draft on a student profile both received
// the SAME 7-section ORGANIZATIONAL grant-proposal template (Budget
// Justification, Evaluation Plan, Project Narrative...). A student scholarship
// is a different document shape — personal statement/essay, academic
// background, financial need, activities & leadership — and a funder reading a
// scholarship essay slot will never read a "Budget Justification".
//
// Shape selection keys on the opportunity row's own DECLARED kind
// (funding_opportunities.opportunity_kind = 'SCHOLARSHIP', the canonical
// crawler-os kind, or the declared opportunity_type = 'scholarship' column).
// A row that declares nothing keeps the standard default — silence is not a
// denial, and a title WORD alone must never flip the shape (the #937
// one-shared-word class).

test('a declared SCHOLARSHIP opportunity gets the scholarship shape, never the 7-section grant proposal', () => {
  // The exact operator shape: a state scholarship whose sponsor is not a
  // university, so none of the auto_fafsa heuristics fire.
  const grant = {
    funder: 'Tennessee Student Assistance Corporation',
    title: 'Tennessee HOPE Scholarship',
  }
  const opportunity = { opportunity_kind: 'SCHOLARSHIP' }

  const style = classifyApplicationStyle(grant, opportunity)
  assert.equal(style, 'scholarship')

  const keys = buildDefaultSectionsForStyle(style).map((s) => s.section_key)
  assert.ok(
    !keys.includes('budget_justification'),
    'a scholarship application must NOT ship a Budget Justification',
  )
  assert.ok(!keys.includes('evaluation_plan'), 'no Evaluation Plan for a scholarship')
  assert.ok(!keys.includes('project_narrative'), 'no Project Narrative for a scholarship')
  assert.ok(keys.includes('personal_statement'), 'must include a personal statement / essay')
  assert.ok(keys.includes('academic_background'), 'must include academic background')
  assert.ok(keys.includes('financial_need_statement'), 'must include a financial need statement')
  assert.ok(keys.includes('activities_leadership'), 'must include activities & leadership')
  assert.ok(keys.includes('organization_background'), 'must include applicant background')
  assert.ok(keys.includes('submission_instructions'), 'must include submission instructions')
})

test('declared kind is case-insensitive and the declared opportunity_type column also counts', () => {
  assert.equal(
    classifyApplicationStyle({}, { opportunity_kind: 'scholarship' }),
    'scholarship',
    'lower-case crawler rows must classify identically (prod stores both casings)',
  )
  assert.equal(
    classifyApplicationStyle({}, { opportunity_type: 'scholarship' }),
    'scholarship',
    'the declared opportunity_type column is a declaration too',
  )
})

test('explicit application_method still wins over a declared scholarship kind', () => {
  assert.equal(
    classifyApplicationStyle(
      { application_method: 'nomination' },
      { opportunity_kind: 'SCHOLARSHIP' },
    ),
    'nomination',
  )
})

test('an UNDECLARED kind keeps the standard default — a title word alone never flips the shape', () => {
  // The AAFS shape: "Scholarship" in the title, non-university sponsor,
  // nothing declared on the opportunity row. Silence is not a denial: the
  // shape stays standard until the row declares its kind.
  const grant = {
    funder: 'American Academy of Forensic Sciences',
    title: 'AAFS Forensic Science Scholarship',
  }
  assert.equal(classifyApplicationStyle(grant, {}), 'standard')
  assert.equal(classifyApplicationStyle(grant, null), 'standard')

  const keys = buildDefaultSectionsForStyle('standard').map((s) => s.section_key)
  assert.ok(keys.includes('budget_justification'), 'org/program grants keep the 7-section shape')
})

test('a non-scholarship declared kind does not get the scholarship shape', () => {
  assert.equal(classifyApplicationStyle({}, { opportunity_kind: 'DIRECT_GRANT' }), 'standard')
  assert.equal(classifyApplicationStyle({}, { opportunity_kind: 'PROGRAM' }), 'standard')
})

// ---------------------------------------------------------------------------
// scholarship style — second trigger: individual profile + scholarship-titled
// opportunity (the operator's two REAL prod rows declare no scholarship kind)
// ---------------------------------------------------------------------------
// Measured read-only in prod 2026-08-03: the AAFS draft's linked opportunity
// declares opportunity_kind '' / opportunity_type 'grant' (a crawler DEFAULT,
// `opp.opportunity_type || 'grant'`), and the HOPE draft's declares
// 'DIRECT_GRANT' / ''. Declared-kind alone therefore cannot reach either
// reported row. The second trigger requires TWO independent conditions (the
// house two-condition pattern): an INDIVIDUAL-root applying profile
// (canonical profile-type registry) AND a title the EXISTING
// aidTypePreferences.classifyAidType classifier names 'scholarship'.

const STUDENT_PROFILE = { primary_type: 'student', display_name: 'Test Student' }

test('the two operator-reported prod rows classify as scholarship for a student profile', () => {
  // Exact prod shape 1: HOPE draft (kind DIRECT_GRANT, type empty).
  assert.equal(
    classifyApplicationStyle(
      { funder: 'Tennessee Lottery', title: 'HOPE Scholarship' },
      { opportunity_kind: 'DIRECT_GRANT', opportunity_type: '' },
      STUDENT_PROFILE,
    ),
    'scholarship',
  )
  // Exact prod shape 2: AAFS draft (kind empty, type defaulted to 'grant',
  // PLURAL "Scholarships" in the title).
  assert.equal(
    classifyApplicationStyle(
      {
        funder: 'American Academy of Forensic Sciences',
        title: 'American Academy of Forensic Sciences (AAFS) Scholarships',
      },
      { opportunity_kind: '', opportunity_type: 'grant' },
      STUDENT_PROFILE,
    ),
    'scholarship',
  )
})

test('without a profile, a scholarship-titled but undeclared row keeps the standard default', () => {
  assert.equal(
    classifyApplicationStyle(
      { funder: 'Tennessee Lottery', title: 'HOPE Scholarship' },
      { opportunity_kind: 'DIRECT_GRANT' },
    ),
    'standard',
  )
})

test('an ORG profile applying to a scholarship-titled row keeps the org proposal shape', () => {
  assert.equal(
    classifyApplicationStyle(
      { funder: 'Community Fund', title: 'Neighborhood Scholarship Fund Grant' },
      {},
      { primary_type: 'nonprofit' },
    ),
    'standard',
  )
})

test('an ORG profile keeps the org proposal shape even against a DECLARED scholarship kind', () => {
  // A church/ministry applying against a scholarship-kind row is FUNDING or
  // administering scholarships — it writes an organizational proposal, not a
  // personal essay. Owner-named org profiles: Vermilion Church of God of
  // Prophecy, Focus Forward Ministry.
  for (const orgType of ['church', 'ministry', 'nonprofit']) {
    assert.equal(
      classifyApplicationStyle(
        { funder: 'Local Funder', title: 'Youth Scholarship Fund' },
        { opportunity_kind: 'SCHOLARSHIP' },
        { primary_type: orgType },
      ),
      'standard',
      `${orgType} profile must keep the organizational proposal shape`,
    )
  }
  // A null/unknown profile does not veto the row's own declared contract.
  assert.equal(
    classifyApplicationStyle({}, { opportunity_kind: 'SCHOLARSHIP' }, null),
    'scholarship',
  )
})

test('a declared POINTER kind never gets the essay shape, even scholarship-titled + student', () => {
  // Real prod shape: "Bold.org — Housing & Living Expense Scholarships" is a
  // DIRECTORY — a pointer, never an award. No personal essay for a locator.
  assert.equal(
    classifyApplicationStyle(
      { title: 'Bold.org — Housing & Living Expense Scholarships' },
      { opportunity_kind: 'directory' },
      STUDENT_PROFILE,
    ),
    'standard',
  )
})

test('a non-scholarship title with a student profile keeps its existing classification', () => {
  // Generic grant title → standard.
  assert.equal(
    classifyApplicationStyle(
      { funder: 'Acme Foundation', title: 'Emergency Family Assistance' },
      {},
      STUDENT_PROFILE,
    ),
    'standard',
  )
  // University financial aid stays FAFSA-driven — the heuristics win before
  // the title arm is consulted.
  assert.equal(
    classifyApplicationStyle(
      { funder: 'Middle Tennessee State University', title: 'MTSU Financial Aid' },
      null,
      STUDENT_PROFILE,
    ),
    'auto_fafsa',
  )
})

test('medical_necessity is appended to the scholarship shape only when required', () => {
  const without = buildDefaultSectionsForStyle('scholarship', { medNecRequired: false })
    .map((s) => s.section_key)
  const withIt = buildDefaultSectionsForStyle('scholarship', { medNecRequired: true })
    .map((s) => s.section_key)
  assert.ok(!without.includes('medical_necessity'))
  assert.ok(withIt.includes('medical_necessity'))
})
