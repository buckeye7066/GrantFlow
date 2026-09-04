/**
 * FAFSA-linkage recognition + fulfillment (owner request 2026-07-27):
 * "A lot of the portals on Demo Student's profile only require linking to her
 * FAFSA. Give Hamilton the ability to recognize this and to link the two."
 *
 * Pins the whole loop, PROFILE-GENERIC (two distinct student profiles):
 *
 *   1. RECOGNITION — classifyFundingSource marks a portal whose application
 *      method IS the FAFSA (link/import phrasing, awards-straight-from-FAFSA,
 *      explicit application_mode='fafsa') with `fafsa_link: true`. Precision
 *      guards: a page merely MENTIONING FAFSA eligibility is NOT link-only.
 *   2. FULFILLMENT — a profile whose education record says the FAFSA is FILED
 *      (legacy fafsa_completed boolean OR the canonical fafsa_status lifecycle
 *      at/after 'submitted') answers the 'fafsa_link' ask across ALL of that
 *      profile's tasks via reconcileProfileFieldsToTasks, and resumable tasks
 *      resume. A not-filed FAFSA keeps the honest ask.
 *   3. NO INVENTED DATA — Hamilton never claims a linkage happened; the
 *      completed-task record only reports what the profile says, and a junk
 *      profile field literally named fafsa_link can never answer the ask.
 *   4. ONE HONEST ASK — N portal tasks needing only the FAFSA collapse to ONE
 *      needs_you entry in the profile summary / action plan.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'

// Billing enforcement is covered separately; this suite exercises downstream Hamilton behavior.
vi.mock('../services/billing/entitlementService.js', () => ({
  resolveProfileEntitlement: vi.fn(async () => ({ allowed: true, source: 'tier' })),
}))
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

// FAFSA-link lifecycle is downstream of funding-source admission. Admit the
// fixture explicitly so this suite measures that lifecycle and nothing else.
vi.mock('../services/hamilton/hamiltonFundingSourcePolicy.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    assessHamiltonFundingSource: vi.fn(async () => ({ ok: true, reasons: [] })),
  }
})

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { classifyFundingSource, detectFafsaLinkRequirement } = await import('../services/hamilton/hamiltonAutomationClassifier.js')
const {
  preflightSingleSource,
  recheckMissingProfileFields,
  profileFafsaCompleted,
  PREFLIGHT_PROFILE_FIELD_KEYS,
  FAFSA_LINK_FIELD_KEY,
} = await import('../services/hamilton/hamiltonPreflight.js')
const {
  ensureApplicationTask,
  updateApplicationTask,
  getApplicationTask,
  setMissingInfo,
  listMissingInfo,
  reconcileProfileFieldsToTasks,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { automateSingleSource } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const { buildHamiltonProfileSummary, buildHamiltonTodoCategory } = await import('../services/hamilton/hamiltonProfileSummary.js')
const { _resetMasterVaultSchemaCache } = await import('../services/hamilton/hamiltonPortalMasterVault.js')

// ── Fixtures ────────────────────────────────────────────────────────────────

// Two DISTINCT student profiles (owner clarification 2026-07-27: detection and
// fulfillment must be generic — Demo Student AND Robert both have FAFSAs).
const demo_stem_student = 'profile-demo-tennessee-stem-student-mtsu'
const ROBERT = 'profile-demo-tennessee-college-student-mtsu'

const LINK_ONLY_OPP = {
  id: 'opp-tsaa',
  title: 'Tennessee Student Assistance Award',
  description: 'State grant for Tennessee students. Awards are determined based on your FAFSA; no separate application is required.',
  application_url: 'https://www.tn.gov/collegepays/financial-aid/tsaa.html',
}
const IMPORT_OPP = {
  id: 'opp-mtsu-aid',
  title: 'MTSU Institutional Aid',
  description: 'Import your FAFSA information in the university portal to be considered for need-based awards.',
  application_url: 'https://www.mtsu.edu/financial-aid/',
}
const MENTION_ONLY_OPP = {
  id: 'opp-mention',
  title: 'Community Scholars Program',
  description: 'Apply online with two essays and a transcript. Students who complete the FAFSA may also qualify for additional federal aid programs.',
  application_url: 'https://example.org/apply',
}

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      created_by TEXT,
      display_name TEXT,
      primary_type TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      description TEXT,
      opportunity_kind TEXT,
      entity_types_allowed TEXT,
      application_url TEXT,
      source_url TEXT,
      source TEXT,
      record_origin TEXT,
      source_trust_tier TEXT,
      reality_status TEXT,
      is_active INTEGER
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      description TEXT,
      application_url TEXT,
      url TEXT
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT,
      match_explanation TEXT, matcher_version TEXT, updated_at DATETIME, computed_at DATETIME
    );
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  _resetMasterVaultSchemaCache()
  return db
}

async function setSection(db, profileId, sectionKey, data) {
  await db.prepare('DELETE FROM profile_sections WHERE profile_id = ? AND section_key = ?').run(profileId, sectionKey)
  await db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(profileId, sectionKey, JSON.stringify(data))
}

async function insertOpp(db, opp) {
  await db.prepare(`INSERT OR REPLACE INTO funding_opportunities
    (id, title, description, opportunity_kind, entity_types_allowed, application_url,
     source_url, source, record_origin, source_trust_tier, reality_status, is_active)
    VALUES (?, ?, ?, 'direct_grant', ?, ?, ?, 'curated_verified', 'curated_verified', 'official', 'real', 1)`)
    .run(
      opp.id,
      opp.title,
      opp.description,
      JSON.stringify(['student', 'individual']),
      opp.application_url || null,
      opp.application_url || null,
    )
}

// ── 1. Recognition ──────────────────────────────────────────────────────────

describe('FAFSA-link recognition (classifier)', () => {
  it('marks awards-determined-from-FAFSA copy as fafsa_link', () => {
    const c = classifyFundingSource({ opportunity: LINK_ONLY_OPP })
    expect(c.fafsa_link).toBe(true)
    expect(c.automation_type).toBe('auto_profile')
    expect(c.reasons.some((r) => r.rule === 'fafsa.link_only')).toBe(true)
  })

  it('marks "import your FAFSA" portal copy as fafsa_link', () => {
    expect(classifyFundingSource({ opportunity: IMPORT_OPP }).fafsa_link).toBe(true)
  })

  it('marks "link your FAFSA" phrasing and explicit application_mode=fafsa', () => {
    expect(detectFafsaLinkRequirement({
      opportunity: { title: 'State Aid', description: 'College students: link your FAFSA to the state portal to receive your award.' },
    }).fafsa_link).toBe(true)
    expect(detectFafsaLinkRequirement({
      opportunity: { title: 'Pell', application_mode: 'fafsa', description: '' },
    }).fafsa_link).toBe(true)
  })

  it('recognizes the signal on a GRANT row (pipeline item without a catalog twin)', () => {
    expect(detectFafsaLinkRequirement({
      grant: { title: 'FAFSA-based state aid', description: 'Students are considered automatically based on the FAFSA; no separate application.' },
    }).fafsa_link).toBe(true)
  })

  // FALSE-POSITIVE GUARDS: mere FAFSA mention ≠ link-only portal.
  it('does NOT flag a page that merely mentions FAFSA eligibility', () => {
    const c = classifyFundingSource({ opportunity: MENTION_ONLY_OPP })
    expect(c.fafsa_link).toBe(false)
  })

  it('does NOT flag "FAFSA encouraged / recommended" advisory copy', () => {
    expect(detectFafsaLinkRequirement({
      opportunity: { title: 'Local Scholarship', description: 'Submit the application form by March 1. We encourage all students to file the FAFSA as well.' },
    }).fafsa_link).toBe(false)
  })

  it('does NOT flag linkage verbs without any FAFSA in the copy', () => {
    expect(detectFafsaLinkRequirement({
      opportunity: { title: 'Data Grant', description: 'Link your ORCID account and import your publications to apply.' },
    }).fafsa_link).toBe(false)
  })

  it('is additive: a plain portal source still classifies portal with fafsa_link=false', () => {
    const c = classifyFundingSource({ opportunity: { id: 'x', title: 'Makers Grant', application_url: 'https://makers.example.org/apply' } })
    expect(c.automation_type).toBe('portal')
    expect(c.fafsa_link).toBe(false)
  })
})

// ── 2. Profile FAFSA readiness + preflight/recheck ──────────────────────────

describe('profileFafsaCompleted + preflight fafsa_link ask', () => {
  it('reads the legacy boolean, the canonical lifecycle, and a deep-scanned flag', () => {
    expect(profileFafsaCompleted({ education: { fafsa_completed: true } })).toBe(true)
    expect(profileFafsaCompleted({ education: { fafsa_status: { stage: 'processed' } } })).toBe(true)
    expect(profileFafsaCompleted({ education: { fafsa_status: { stage: 'in_progress' } } })).toBe(false)
    expect(profileFafsaCompleted({ education: { fafsa_completed: false } })).toBe(false)
    expect(profileFafsaCompleted({ academic: { nested: { fafsa_completed: 'true' } } })).toBe(true)
    // resolved-field operator cache counts as an answer
    expect(profileFafsaCompleted({}, { fafsa_link: 'submitted 2026-01' })).toBe(true)
    expect(profileFafsaCompleted({})).toBe(false)
  })

  it('preflight raises ONE structured fafsa_link ask only while the FAFSA is not filed', async () => {
    const db = makeDb()
    const profileNoFafsa = {
      id: demo_stem_student,
      basic_information: { first_name: 'Demo Student', last_name: 'Steele', email: 'a@example.com' },
      education: { fafsa_completed: false },
    }
    const r1 = await preflightSingleSource(db, {
      profile: profileNoFafsa, profileId: demo_stem_student,
      source: { opportunity_id: LINK_ONLY_OPP.id }, opportunity: LINK_ONLY_OPP, grant: null,
    })
    expect(r1.classification.fafsa_link).toBe(true)
    expect(r1.blockers.filter((b) => b.key === FAFSA_LINK_FIELD_KEY)).toHaveLength(1)

    const profileFiled = { ...profileNoFafsa, education: { fafsa_completed: true } }
    const r2 = await preflightSingleSource(db, {
      profile: profileFiled, profileId: demo_stem_student,
      source: { opportunity_id: LINK_ONLY_OPP.id }, opportunity: LINK_ONLY_OPP, grant: null,
    })
    expect(r2.blockers.some((b) => b.key === FAFSA_LINK_FIELD_KEY)).toBe(false)

    // A non-FAFSA source never raises the ask, filed or not.
    const r3 = await preflightSingleSource(db, {
      profile: profileNoFafsa, profileId: demo_stem_student,
      source: { opportunity_id: MENTION_ONLY_OPP.id }, opportunity: MENTION_ONLY_OPP, grant: null,
    })
    expect(r3.blockers.some((b) => b.key === FAFSA_LINK_FIELD_KEY)).toBe(false)
  })

  it('fafsa_link is in the self-heal field class and rechecks honestly', () => {
    expect(PREFLIGHT_PROFILE_FIELD_KEYS).toContain(FAFSA_LINK_FIELD_KEY)
    expect(recheckMissingProfileFields({ education: { fafsa_completed: false } }, [FAFSA_LINK_FIELD_KEY]))
      .toContain(FAFSA_LINK_FIELD_KEY)
    expect(recheckMissingProfileFields({ education: { fafsa_status: { stage: 'submitted' } } }, [FAFSA_LINK_FIELD_KEY]))
      .toHaveLength(0)
  })
})

// ── 3. The full loop, profile-generic (two students) ────────────────────────

describe('FAFSA-link fulfillment loop (Demo Student + Robert — profile-generic)', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await db.prepare("INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES (?, 'u-ana', 'Demo Student Steele', 'college_student')").run(demo_stem_student)
    await db.prepare("INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES (?, 'u-rob', 'Robert Michael White', 'college_student')").run(ROBERT)
    await insertOpp(db, LINK_ONLY_OPP)
    await insertOpp(db, IMPORT_OPP)
    for (const profileId of [demo_stem_student, ROBERT]) {
      for (const opportunityId of [LINK_ONLY_OPP.id, IMPORT_OPP.id]) {
        await db.prepare(`INSERT INTO profile_opportunity_matches
          (profile_id, opportunity_id, match_score, match_decision, matcher_version, updated_at, computed_at)
          VALUES (?, ?, 90, 'accept', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
          .run(profileId, opportunityId)
      }
    }
  })

  it('parks a FAFSA-linked task on ONE honest ask, resolves it profile-wide when the FAFSA is filed, and completes without inventing a linkage', async () => {
    // Demo Student: FAFSA not filed yet (legacy boolean shape).
    await setSection(db, demo_stem_student, 'education', { fafsa_completed: false })

    const r1 = await automateSingleSource(db, {
      profileId: demo_stem_student, userId: 'u-ana', source: { opportunity_id: LINK_ONLY_OPP.id },
    })
    const r2 = await automateSingleSource(db, {
      profileId: demo_stem_student, userId: 'u-ana', source: { opportunity_id: IMPORT_OPP.id },
    })
    expect(r1.waiting_on_fafsa).toBe(true)
    expect(r1.task.status).toBe('waiting_for_missing_info')
    expect(r2.task.status).toBe('waiting_for_missing_info')
    // The honest ask is recorded as a structured field item, once per task.
    const items1 = await listMissingInfo(db, r1.task.id, { includeResolved: false })
    expect(items1.filter((m) => m.kind === 'field' && m.key === FAFSA_LINK_FIELD_KEY)).toHaveLength(1)
    // Honesty: the parked message never claims Hamilton files the FAFSA.
    expect(r1.task.last_agent_message).toMatch(/can't file it for you/i)

    // A reconcile while the FAFSA is still NOT filed resolves nothing.
    const noop = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(noop.fieldsResolved).toBe(0)
    expect((await getApplicationTask(db, r1.task.id)).status).toBe('waiting_for_missing_info')

    // Owner marks the FAFSA submitted ONCE on the profile → both portal tasks
    // clear and resume ("add it once, it clears everywhere").
    await setSection(db, demo_stem_student, 'education', { fafsa_completed: true })
    const rec = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(rec.fieldsResolved).toBe(2)
    expect(rec.tasksResumed).toBe(2)
    for (const taskId of [r1.task.id, r2.task.id]) {
      const t = await getApplicationTask(db, taskId)
      expect(t.status).toBe('ready')
      const resolved = (await listMissingInfo(db, taskId)).find((m) => m.key === FAFSA_LINK_FIELD_KEY)
      expect(resolved.resolved).toBe(true)
      // The recorded answer is the profile's own FAFSA stage — real signal only.
      expect(String(resolved.resolved_value)).toMatch(/^fafsa_/)
    }

    // The runner re-picks the ready task: it now completes honestly.
    const r1b = await automateSingleSource(db, {
      profileId: demo_stem_student, userId: 'u-ana', source: { opportunity_id: LINK_ONLY_OPP.id },
    })
    expect(r1b.task.status).toBe('completed')
    expect(r1b.task.audit_summary?.fafsa_link).toEqual({ required: true, fafsa_on_file: true })
    expect(r1b.task.last_agent_message).toMatch(/never logs into studentaid\.gov/i)
  })

  it('works identically for a second student using the canonical fafsa_status lifecycle (Robert)', async () => {
    // Robert: FAFSA in progress (lifecycle shape, not the legacy boolean).
    await setSection(db, ROBERT, 'education', { fafsa_status: { stage: 'in_progress' } })
    const r = await automateSingleSource(db, {
      profileId: ROBERT, userId: 'u-rob', source: { opportunity_id: LINK_ONLY_OPP.id },
    })
    expect(r.task.status).toBe('waiting_for_missing_info')

    // Robert submits his FAFSA — stage moves to 'processed'.
    await setSection(db, ROBERT, 'education', { fafsa_status: { stage: 'processed' }, fafsa_completed: true })
    const rec = await reconcileProfileFieldsToTasks(db, { profileId: ROBERT })
    expect(rec.fieldsResolved).toBe(1)
    expect(rec.tasksResumed).toBe(1)
    expect((await getApplicationTask(db, r.task.id)).status).toBe('ready')

    const done = await automateSingleSource(db, {
      profileId: ROBERT, userId: 'u-rob', source: { opportunity_id: LINK_ONLY_OPP.id },
    })
    expect(done.task.status).toBe('completed')
    expect(done.task.audit_summary?.fafsa_link?.fafsa_on_file).toBe(true)

    // Cross-profile isolation: Robert's filing never touched Demo Student.
    await setSection(db, demo_stem_student, 'education', { fafsa_completed: false })
    const t = await ensureApplicationTask(db, { profileId: demo_stem_student, opportunityId: IMPORT_OPP.id, automationType: 'auto_profile' })
    await updateApplicationTask(db, t.id, { status: 'waiting_for_missing_info' })
    await setMissingInfo(db, t.id, [{ kind: 'field', key: FAFSA_LINK_FIELD_KEY, label: 'Complete and submit your FAFSA', required: true }])
    const recAna = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(recAna.fieldsResolved).toBe(0)
    expect((await getApplicationTask(db, t.id)).status).toBe('waiting_for_missing_info')
  })

  it('a student whose FAFSA is already on file completes immediately — no ask ever filed', async () => {
    await setSection(db, ROBERT, 'education', { fafsa_status: { stage: 'school_received' } })
    const r = await automateSingleSource(db, {
      profileId: ROBERT, userId: 'u-rob', source: { opportunity_id: IMPORT_OPP.id },
    })
    expect(r.task.status).toBe('completed')
    expect(r.fafsa_link).toBe(true)
    const items = await listMissingInfo(db, r.task.id, { includeResolved: false })
    expect(items).toHaveLength(0)
  })

  it('NO invented data: a junk profile field literally named fafsa_link can never answer the ask', async () => {
    await setSection(db, demo_stem_student, 'education', { fafsa_completed: false })
    // A stray/imported field named fafsa_link with a non-empty junk value.
    await setSection(db, demo_stem_student, 'imported_misc', { fafsa_link: 'no / not sure' })
    const t = await ensureApplicationTask(db, { profileId: demo_stem_student, opportunityId: LINK_ONLY_OPP.id, automationType: 'auto_profile' })
    await updateApplicationTask(db, t.id, { status: 'waiting_for_missing_info' })
    await setMissingInfo(db, t.id, [{ kind: 'field', key: FAFSA_LINK_FIELD_KEY, label: 'Complete and submit your FAFSA', required: true }])

    const rec = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(rec.fieldsResolved).toBe(0)
    expect((await getApplicationTask(db, t.id)).status).toBe('waiting_for_missing_info')
  })
})

// ── 3b. Canonical field aliases + nested-path safety (audit #15) ─────────────

describe('reconcile resolves aliased field keys and never guesses across nested parties', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await db.prepare("INSERT INTO profiles (id, user_id, display_name) VALUES (?, 'u-a', 'Applicant')").run(demo_stem_student)
  })

  const flagField = async (key) => {
    const t = await ensureApplicationTask(db, { profileId: demo_stem_student, opportunityId: LINK_ONLY_OPP.id, automationType: 'auto_profile' })
    await updateApplicationTask(db, t.id, { status: 'waiting_for_missing_info' })
    await setMissingInfo(db, t.id, [{ kind: 'field', key, label: key, required: true }])
    return t
  }

  it('a portal flag named "given_name" is answered by the profile\'s first_name', async () => {
    await setSection(db, demo_stem_student, 'basic_information', { first_name: 'Demo Student' })
    const t = await flagField('given_name')
    const rec = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(rec.fieldsResolved).toBe(1)
    const resolved = (await listMissingInfo(db, t.id)).find((m) => m.key === 'given_name')
    expect(resolved.resolved).toBe(true)
    expect(String(resolved.resolved_value)).toBe('Demo Student')
  })

  it('other spellings resolve too: firstName / legal_first_name / postal_code / phone_number', async () => {
    await setSection(db, demo_stem_student, 'basic_information', { firstName: 'Ana', legal_last_name: 'Steele' })
    await setSection(db, demo_stem_student, 'contact', { postal_code: '37311', phone_number: '555-0100' })
    const tFirst = await flagField('first_name')
    const tZip = await flagField('zip_code')
    const tPhone = await flagField('telephone')
    const rec = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(rec.fieldsResolved).toBe(3)
    const val = async (t, k) => String((await listMissingInfo(db, t.id)).find((m) => m.key === k).resolved_value)
    expect(await val(tFirst, 'first_name')).toBe('Ana')
    expect(await val(tZip, 'zip_code')).toBe('37311')
    expect(await val(tPhone, 'telephone')).toBe('555-0100')
  })

  it('the APPLICANT\'s section-root first_name wins over a nested guardian.first_name', async () => {
    await setSection(db, demo_stem_student, 'basic_information', {
      first_name: 'Demo Student',
      guardian: { first_name: 'Margaret' },
    })
    const t = await flagField('first_name')
    const rec = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(rec.fieldsResolved).toBe(1)
    const resolved = (await listMissingInfo(db, t.id)).find((m) => m.key === 'first_name')
    expect(String(resolved.resolved_value)).toBe('Demo Student') // never the guardian's
  })

  it('a genuinely ambiguous bare leaf (two nested parties, no root) resolves NOTHING — no wrong guess', async () => {
    // phone is not derivable from display_name, so this isolates the nested
    // ambiguity: two parties carry a phone, neither at section root.
    await setSection(db, demo_stem_student, 'household', {
      guardian: { phone: '555-1111' },
      sibling: { phone: '555-2222' },
    })
    await flagField('phone') // bare, ambiguous
    const rec = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(rec.fieldsResolved).toBe(0)
  })

  it('an explicit nested path still resolves exactly its own value', async () => {
    await setSection(db, demo_stem_student, 'household', {
      guardian: { first_name: 'Margaret' },
      sibling: { first_name: 'Elyria' },
    })
    const t = await flagField('household.guardian.first_name')
    const rec = await reconcileProfileFieldsToTasks(db, { profileId: demo_stem_student })
    expect(rec.fieldsResolved).toBe(1)
    const resolved = (await listMissingInfo(db, t.id)).find((m) => m.key === 'household.guardian.first_name')
    expect(String(resolved.resolved_value)).toBe('Margaret')
  })
})

// ── 4. One deduped honest ask across N portals ──────────────────────────────

describe('one honest FAFSA ask across N portals (summary/action plan)', () => {
  it('collapses N per-task fafsa_link asks into ONE needs_you entry naming N portals', async () => {
    const db = makeDb()
    await db.prepare("INSERT INTO profiles (id, user_id, display_name) VALUES (?, 'u-ana', 'Demo Student Steele')").run(demo_stem_student)
    const mk = async (grantId, title) => {
      await db.prepare('INSERT INTO grants (id, profile_id, title) VALUES (?, ?, ?)').run(grantId, demo_stem_student, title)
      const t = await ensureApplicationTask(db, { profileId: demo_stem_student, grantId, automationType: 'auto_profile' })
      await updateApplicationTask(db, t.id, { status: 'waiting_for_missing_info' })
      await setMissingInfo(db, t.id, [{ kind: 'field', key: FAFSA_LINK_FIELD_KEY, label: 'Complete and submit your FAFSA', required: true }])
      return t
    }
    await mk('g-tsaa', 'Tennessee Student Assistance Award')
    await mk('g-pell', 'Federal Pell Grant')
    await mk('g-mtsu', 'MTSU Need-Based Aid')

    const summary = await buildHamiltonProfileSummary(db, demo_stem_student)
    const fafsaNeeds = summary.needs_you.filter((n) => n.id === 'fafsa:link')
    expect(fafsaNeeds).toHaveLength(1)
    expect(fafsaNeeds[0].task_count).toBe(3)
    expect(fafsaNeeds[0].detail).toMatch(/3 portals/)
    expect(fafsaNeeds[0].detail).toMatch(/never files the FAFSA/i)
    // No leftover per-task fafsa entries.
    const perTask = summary.needs_you.filter((n) => n.kind === 'missing_field' && n.field_key === FAFSA_LINK_FIELD_KEY)
    expect(perTask).toHaveLength(0)

    const category = await buildHamiltonTodoCategory(db, demo_stem_student)
    const fafsaItems = category.items.filter((i) => i.title === 'Complete and submit your FAFSA')
    expect(fafsaItems).toHaveLength(1)
  })
})
