/**
 * hamiltonPreflight.js
 *
 * Pre-launch checks that run BEFORE the autopilot engine starts. The
 * goal is to fail fast — surface every missing field, document, URL,
 * credential strategy, or authorization while the user is still on
 * the launch screen, so Hamilton doesn't have to stop mid-flight.
 *
 * Returns a structured report:
 *   {
 *     ok: boolean,
 *     blockers: [{ kind, key, label, detail }],
 *     warnings: [{ kind, key, label, detail }],
 *     classification: <classifier output>,
 *     authorization: {
 *       complete_forms, upload_documents, generate_narratives,
 *       save_drafts, submit_applications, use_saved_session,
 *       use_saved_credentials_reference, use_standing_attestation
 *     }
 *   }
 *
 * Pure-ish: only reads from the database, never writes.
 */

import { classifyFundingSource } from './hamiltonAutomationClassifier.js'
import { assessHamiltonFundingSource } from './hamiltonFundingSourcePolicy.js'
import { isAuthorizationActive, listActiveAuthorizations } from './hamiltonAuthorizationStore.js'
import { parseFullName, looksLikeOrganization } from '../../../shared/nameParsing.js'
import { normalizeFafsaStatus, deriveFafsaCompleted } from '../college/fafsaStatus.js'

const REQUIRED_IDENTITY_FIELDS = [
  { key: 'first_name', paths: ['basic_information.first_name', 'first_name'] },
  { key: 'last_name', paths: ['basic_information.last_name', 'last_name'] },
  { key: 'email', paths: ['basic_information.email', 'email'] },
]

const STUDENT_HINT_PATTERNS = [
  /scholarship/i, /grant/i, /tuition/i, /aid/i, /fafsa/i, /college/i, /university/i,
  /student/i, /education/i, /book\s*stipend/i, /housing\s*aid/i, /work[-\s]?study/i,
]

const FINANCIAL_HINT_PATTERNS = [
  /need[-\s]*based/i, /income/i, /financial\s*aid/i, /hardship/i, /low[-\s]*income/i,
]

function get(obj, p) {
  if (!obj) return undefined
  let cur = obj
  for (const seg of p.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[seg]
  }
  return cur
}

function nonEmpty(v) { return v !== null && v !== undefined && String(v).trim() !== '' }

function pickFirst(profile, paths) {
  for (const p of paths) {
    const v = get(profile, p)
    if (nonEmpty(v)) return v
  }
  return undefined
}

function normKey(k) { return String(k || '').trim().toLowerCase().replace(/[\s-]+/g, '_') }

// Every reasonable spelling/synonym a value might be stored under, so a deep
// scan recognises it wherever it lives in the profile tree.
const FIELD_ALIASES = Object.freeze({
  first_name: ['first_name', 'firstname', 'given_name', 'givenname', 'fname'],
  last_name: ['last_name', 'lastname', 'surname', 'family_name', 'familyname', 'lname'],
  full_name: ['full_name', 'fullname', 'name', 'display_name', 'displayname', 'legal_name', 'legalname', 'applicant_name', 'student_name'],
  email: ['email', 'email_address', 'emailaddress', 'primary_email', 'contact_email'],
  phone: ['phone', 'phone_number', 'cell', 'cell_phone', 'cellphone', 'mobile', 'mobile_phone', 'telephone', 'contact_phone'],
  school_name: ['school_name', 'school', 'university', 'college', 'institution', 'current_school', 'current_institution', 'institution_name'],
  household_income: ['household_income', 'annual_income', 'annual_household_income', 'family_income', 'income', 'gross_income'],
})

/**
 * Deep-scan the WHOLE profile tree for the first non-empty value stored under
 * any of `keys` (or their aliases), at any nesting depth. This is the
 * "parse the whole profile" safety net: Hamilton should never raise a
 * missing-field hard stop for a value that is sitting somewhere in the profile
 * (e.g. school under academic_status.current_institution, a cell under
 * basic_information.demographics.phone) just because it is not at the one path
 * we happened to check first.
 */
function deepFindByKeys(root, keys) {
  const wanted = new Set()
  for (const k of keys) for (const a of (FIELD_ALIASES[normKey(k)] || [normKey(k)])) wanted.add(a)
  const seen = new Set()
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) { for (const item of node) stack.push(item); continue }
    for (const [k, v] of Object.entries(node)) {
      if (wanted.has(normKey(k)) && nonEmpty(v) && (typeof v !== 'object')) return v
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return undefined
}

// Identity-name keys ONLY. Deliberately EXCLUDES the bare `name` key: a profile
// carries many nested `name` fields (a university_applications entry's school
// name, a scholarship's name, an org's name). A deep scan that accepted `name`
// returned an unrelated org-like string (e.g. "Middle Tennessee State
// University"), which looksLikeOrganization then rejected — raising a FALSE
// "missing first name" hard stop for a student who clearly has a name on file
// (display_name). Keeping this list identity-specific is the loader-independent
// net that actually holds when the profile also carries school/scholarship data.
const IDENTITY_NAME_KEYS = Object.freeze([
  'full_name', 'fullname', 'display_name', 'displayname',
  'legal_name', 'legalname', 'applicant_name', 'student_name',
])

// Find the profile OWNER's full name so first/last can be DERIVED instead of
// demanded. Prefer explicit identity paths; only then fall back to a deep scan
// restricted to identity-name keys (never the generic `name`, which collides
// with nested university/scholarship names).
function findFullName(profile) {
  const explicit = pickFirst(profile, [
    'basic_information.full_name', 'basic_information.legal_name',
    'full_name', 'display_name', 'legal_name', 'name',
  ])
  if (nonEmpty(explicit)) return String(explicit)

  const seen = new Set()
  const stack = [profile]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) { for (const item of node) stack.push(item); continue }
    for (const [k, v] of Object.entries(node)) {
      if (IDENTITY_NAME_KEYS.includes(normKey(k)) && nonEmpty(v) && typeof v !== 'object') return String(v)
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return null
}

// Derive a first/last name part from whatever full name the profile carries.
// Returns undefined for organizations (no personal name) or when no name is on
// file. This is the loader-independent safety net: the profile editor persists
// ONE canonical name (basic_information.full_name / profiles.display_name), so
// Hamilton must never raise a "missing first/last name" hard stop just because
// a particular loader didn't pre-split it.
function derivedNamePart(profile, key) {
  const nk = normKey(key)
  if (nk !== 'first_name' && nk !== 'last_name') return undefined
  const full = findFullName(profile)
  if (!full || looksLikeOrganization(full)) return undefined
  const parts = parseFullName(full)
  const v = nk === 'first_name' ? parts.first_name : parts.last_name
  return nonEmpty(v) ? v : undefined
}

// A field counts as present if it sits at an explicit path, OR anywhere in the
// profile under a known alias, OR the operator already supplied it (resolved
// field cache), OR — for name parts — it can be DERIVED from a full name the
// profile already carries. Only then do we trust a "missing" verdict.
function fieldPresent(profile, paths, key, resolvedFields) {
  if (nonEmpty(pickFirst(profile, paths))) return true
  if (resolvedFields && nonEmpty(resolvedFields[normKey(key)])) return true
  if (nonEmpty(deepFindByKeys(profile, [key]))) return true
  if (nonEmpty(derivedNamePart(profile, key))) return true
  return false
}

// ── FAFSA-linkage readiness (the "link your FAFSA" portal class) ─────────────
// The structured missing-info key a FAFSA-linked portal's single ask is filed
// under (kind 'field'), so the profile-wide reconcile can answer it everywhere
// at once the moment the profile says the FAFSA is filed.
export const FAFSA_LINK_FIELD_KEY = 'fafsa_link'
export const FAFSA_LINK_BLOCKER_LABEL = 'Complete and submit your FAFSA'

const FAFSA_TRUTHY = new Set(['true', '1', 'yes', 'y', 'completed', 'submitted', 'done'])
function fafsaBoolTrue(v) {
  if (v === true) return true
  return FAFSA_TRUTHY.has(String(v ?? '').trim().toLowerCase())
}

/**
 * Is the profile's FAFSA actually FILED (submitted or beyond)? Reads the
 * canonical education.fafsa_status lifecycle first (services/college/
 * fafsaStatus.js), then the legacy education.fafsa_completed boolean, then a
 * deep scan for the flag stored under another section. Profile-generic —
 * works for ANY profile's education record. Honesty rule (G-rules): this only
 * REPORTS what the profile already says; Hamilton never fabricates an FSA ID,
 * never files a FAFSA, and never invents a completion.
 */
export function profileFafsaCompleted(profile, resolvedFields = null) {
  if (resolvedFields && nonEmpty(resolvedFields[FAFSA_LINK_FIELD_KEY])) return true
  const education = get(profile, 'education') || get(profile, 'sections.education') || {}
  if (education?.fafsa_status && deriveFafsaCompleted(normalizeFafsaStatus(education).stage)) return true
  if (fafsaBoolTrue(education?.fafsa_completed)) return true
  // Deep scan: some imports store the flag off the canonical education section.
  const seen = new Set()
  const stack = [profile]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) { for (const item of node) stack.push(item); continue }
    for (const [k, v] of Object.entries(node)) {
      const nk = normKey(k)
      if (nk === 'fafsa_completed' && fafsaBoolTrue(v)) return true
      if (nk === 'fafsa_status' && v && typeof v === 'object' && deriveFafsaCompleted(v.stage)) return true
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return false
}

/**
 * Field keys the preflight can raise a MISSING-PROFILE-FIELD hard stop for.
 * Exported so the boot self-heal sweep (enforceInvariants) can recognise a
 * blocked task whose blocker is this class and re-check it with the SAME
 * presence logic used here — one source of truth, no drift.
 */
export const PREFLIGHT_PROFILE_FIELD_KEYS = Object.freeze([
  ...REQUIRED_IDENTITY_FIELDS.map((f) => f.key),
  'school_name',
  'household_income',
  FAFSA_LINK_FIELD_KEY,
])

/**
 * Re-evaluate a set of previously-flagged profile-field keys against the
 * CURRENT profile. Returns the keys that are STILL missing (empty array =
 * the original preflight blocker no longer reproduces). Uses the exact
 * per-key presence rules preflightSingleSource applies, including full-name
 * derivation and the resolved-field cache.
 */
export function recheckMissingProfileFields(profile, keys = [], resolvedFields = null) {
  const stillMissing = []
  for (const rawKey of keys) {
    const key = normKey(rawKey)
    if (key === 'school_name') {
      const apps = pickFirst(profile, ['university_applications.applications']) || []
      const firstApp = Array.isArray(apps) && apps.length > 0 ? apps[0] : null
      const present = (firstApp && nonEmpty(firstApp.name)) ||
        fieldPresent(profile, [], 'school_name', resolvedFields)
      if (!present) stillMissing.push(key)
      continue
    }
    if (key === 'household_income') {
      if (!fieldPresent(profile, ['financial_information.household_income', 'household.income', 'household_income'], 'household_income', resolvedFields)) {
        stillMissing.push(key)
      }
      continue
    }
    if (key === FAFSA_LINK_FIELD_KEY) {
      // Answered ONLY by a real profile signal: the education section says the
      // FAFSA is filed (or the operator cached it). Never inferred.
      if (!profileFafsaCompleted(profile, resolvedFields)) stillMissing.push(key)
      continue
    }
    const spec = REQUIRED_IDENTITY_FIELDS.find((f) => f.key === key)
    if (!fieldPresent(profile, spec?.paths || [], key, resolvedFields)) stillMissing.push(key)
  }
  return stillMissing
}

function looksLikeStudentFunding(opportunity) {
  const text = [opportunity?.title, opportunity?.description, opportunity?.eligibility_text]
    .filter(Boolean).join(' ')
  return STUDENT_HINT_PATTERNS.some((rx) => rx.test(text))
}

function requiresFinancialFields(opportunity) {
  const text = [opportunity?.title, opportunity?.description, opportunity?.eligibility_text]
    .filter(Boolean).join(' ')
  return FINANCIAL_HINT_PATTERNS.some((rx) => rx.test(text))
}

async function listProfileDocuments(db, profileId) {
  if (!db || !profileId) return []
  try {
    const rows = await db.prepare(
      `SELECT d.* FROM documents d
        JOIN profile_documents pd ON pd.document_id = d.id
       WHERE pd.profile_id = ?`,
    ).all(String(profileId))
    return rows || []
  } catch {
    try {
      const rows = await db.prepare(
        `SELECT * FROM documents WHERE profile_id = ?`,
      ).all(String(profileId))
      return rows || []
    } catch { return [] }
  }
}

function hasDocOfType(documents, predicate) {
  return (documents || []).some((d) => predicate(d))
}

/**
 * Check ONE source. Returns the per-source report described above.
 */
export async function preflightSingleSource(db, {
  profile, profileId, source, opportunity, grant, portalLink = null, resolvedFields = null,
} = {}) {
  const blockers = []
  const warnings = []
  const classification = classifyFundingSource({ opportunity, grant, profile, portalLink })

  const fundingPolicy = await assessHamiltonFundingSource(db, {
    profileId: profileId || profile?.id,
    opportunity,
    grant,
  })
  if (!fundingPolicy.ok) {
    blockers.push({
      kind: 'funding_source_policy', key: 'crawler_profile_rules',
      label: 'Funding source does not meet GrantFlow rules',
      detail: fundingPolicy.message,
      reasons: fundingPolicy.reasons || [],
    })
  } else if (fundingPolicy.warnings?.includes('no_profile_match')) {
    warnings.push({
      kind: 'funding_source_policy', key: 'no_profile_match',
      label: 'No profile-specific crawler match found',
      detail: 'Hamilton found no accepted profile-specific crawler match for this source; hard trust rules passed, but review before continuing.',
    })
  }

  // 1. Required identity / contact fields. A field is only "missing" if it is
  // absent at its explicit path AND nowhere else in the profile under a known
  // alias AND not already in the resolved-field cache — so Hamilton parses the
  // whole profile before flagging anything.
  for (const f of REQUIRED_IDENTITY_FIELDS) {
    if (!fieldPresent(profile, f.paths, f.key, resolvedFields)) {
      blockers.push({
        kind: 'missing_field', key: f.key,
        label: `Profile is missing ${f.key.replace(/_/g, ' ')}`,
        detail: `Hamilton needs ${f.key.replace(/_/g, ' ')} on the profile before she can fill applications.`,
      })
    }
  }

  // 2. Student funding requires school + program info. Accept a school named in
  // a university_applications entry OR anywhere else in the profile (e.g.
  // academic_status.current_institution, basic_information.current_school) so a
  // student already carrying their school on the profile is never blocked.
  if (looksLikeStudentFunding(opportunity)) {
    const apps = pickFirst(profile, ['university_applications.applications']) || []
    const firstApp = Array.isArray(apps) && apps.length > 0 ? apps[0] : null
    const hasSchool = (firstApp && nonEmpty(firstApp.name)) ||
      fieldPresent(profile, [], 'school_name', resolvedFields)
    if (!hasSchool) {
      blockers.push({
        kind: 'missing_field', key: 'school_name',
        label: 'Profile is missing school / university',
        detail: 'This funding source looks student-related; add the school under university_applications.',
      })
    }
  }

  // 3. Financial-aid sources require income/household info.
  if (requiresFinancialFields(opportunity)) {
    if (!fieldPresent(profile, ['financial_information.household_income', 'household.income', 'household_income'], 'household_income', resolvedFields)) {
      warnings.push({
        kind: 'missing_field', key: 'household_income',
        label: 'Household income not on file',
        detail: 'Need-based aid usually requires income on the application. Hamilton will leave it blank if absent.',
      })
    }
  }

  // 3b. FAFSA-linked portals ("link your FAFSA" is the whole application).
  // If the profile already shows the FAFSA FILED there is nothing to ask —
  // the profile record answers the portal's only requirement. Otherwise raise
  // ONE structured ask under the canonical key so the profile-wide reconcile
  // (reconcileProfileFieldsToTasks) clears it across EVERY FAFSA-linked task
  // the moment education.fafsa_status/fafsa_completed turns real. Hamilton
  // never files the FAFSA, never creates an FSA ID, and never claims a
  // portal-side linkage happened.
  if (classification.fafsa_link && !profileFafsaCompleted(profile, resolvedFields)) {
    blockers.push({
      kind: 'missing_field', key: FAFSA_LINK_FIELD_KEY,
      label: FAFSA_LINK_BLOCKER_LABEL,
      detail: 'This portal awards aid straight from your FAFSA — completing and submitting the FAFSA at studentaid.gov is the only application step. Once your profile shows it submitted, every FAFSA-linked portal task resumes automatically. Hamilton cannot file the FAFSA for you.',
    })
  }

  // 4. Required documents.
  const docs = await listProfileDocuments(db, profileId || profile?.id)
  if (looksLikeStudentFunding(opportunity)) {
    if (!hasDocOfType(docs, (d) => /transcript/i.test(`${d.name || ''} ${d.type || ''}`))) {
      warnings.push({
        kind: 'missing_document', key: 'transcript',
        label: 'No transcript on file',
        detail: 'Most scholarships require a transcript. Hamilton will fill what she can but flag the upload.',
      })
    }
    if (!hasDocOfType(docs, (d) => /personal\s*statement|essay|narrative/i.test(`${d.name || ''} ${d.type || ''}`))) {
      // not a hard blocker; the packet generator can produce one from
      // essays.* if `generate_narratives` is authorized.
      warnings.push({
        kind: 'missing_document', key: 'personal_statement',
        label: 'No personal statement / essay document on file',
        detail: 'Hamilton can generate one from profile essays when generate_narratives is authorized.',
      })
    }
  }

  // 5. Pathway-specific blockers.
  if (classification.automation_type === 'portal') {
    if (!nonEmpty(classification.resolved_url)) {
      blockers.push({
        kind: 'missing_url', key: 'application_url',
        label: 'Portal URL is missing',
        detail: 'Add an application_url on the funding opportunity before Hamilton can drive the portal.',
      })
    }
  }
  if (classification.automation_type === 'mail' && !nonEmpty(classification.mailing_address)) {
    blockers.push({
      kind: 'missing_address', key: 'mailing_address',
      label: 'Funder mailing address is missing',
      detail: 'Add a mailing_address on the funding opportunity. Hamilton refuses to invent one.',
    })
  }
  if (classification.automation_type === 'fax' && !nonEmpty(classification.apply_fax)) {
    blockers.push({
      kind: 'missing_fax', key: 'apply_fax',
      label: 'Funder fax number is missing',
      detail: 'Add an apply_fax on the funding opportunity.',
    })
  }
  if (classification.automation_type === 'email' && !nonEmpty(classification.apply_email)) {
    blockers.push({
      kind: 'missing_email', key: 'apply_email',
      label: 'Funder submission email is missing',
      detail: 'Add an apply_email on the funding opportunity.',
    })
  }

  // 6. Authorizations — the *active* set the user has granted on
  //    profile/funding-source/task scope.
  const authorization = await readAuthorizations(db, {
    profileId: profileId || profile?.id,
    fundingSourceId: source?.opportunity_id || source?.grant_id || null,
    taskId: source?.task_id || null,
  })

  // Hamilton will refuse to actually submit unless submit_applications is
  // authorized. We record this as a *warning* (so the run can still
  // start in draft-only mode) UNLESS the user explicitly asked for
  // "submit on completion" — in which case it becomes a blocker.
  if (source?.options?.allow_auto_submit && !authorization.submit_applications) {
    blockers.push({
      kind: 'missing_authorization', key: 'submit_applications',
      label: 'Auto-submit not authorized',
      detail: 'You asked Hamilton to submit on completion but did not authorize submit_applications.',
    })
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    classification,
    authorization,
    documents_count: docs.length,
  }
}

/**
 * Run preflight across many sources. Aggregates all blockers.
 */
export async function preflightSelected(db, { profile, profileId, selectedSources = [] } = {}) {
  if (!Array.isArray(selectedSources)) selectedSources = []
  const out = { ok: true, results: [] }
  for (const source of selectedSources) {
    const scopedProfileId = profileId || profile?.id || null
    const opportunity = source.opportunity_id
      ? await loadOpportunity(db, source.opportunity_id, scopedProfileId)
      : null
    const grant = source.grant_id
      ? await loadGrant(db, source.grant_id)
      : null
    const r = await preflightSingleSource(db, {
      profile,
      profileId: scopedProfileId,
      source,
      opportunity,
      grant,
    })
    if (!r.ok) out.ok = false
    out.results.push({ source, ...r })
  }
  return out
}

async function loadOpportunity(db, id, profileId = null) {
  if (!db || !id) return null
  try {
    const row = profileId
      ? await db.prepare(
          'SELECT * FROM funding_opportunities WHERE id = ? AND (profile_id IS NULL OR profile_id = ?) LIMIT 1',
        ).get(String(id), String(profileId))
      : await db.prepare(
          'SELECT * FROM funding_opportunities WHERE id = ? AND profile_id IS NULL LIMIT 1',
        ).get(String(id))
    return row || null
  } catch { return null }
}
async function loadGrant(db, id) {
  if (!db || !id) return null
  try {
    const row = await db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(id))
    return row || null
  } catch { return null }
}

/**
 * Resolve the authorization status for every Autopilot capability
 * relative to (profile, funding-source, task). Reads the active
 * authorizations table.
 */
export async function readAuthorizations(db, { profileId, fundingSourceId = null, taskId = null } = {}) {
  const out = {
    complete_forms: false,
    upload_documents: false,
    generate_narratives: false,
    save_drafts: false,
    submit_applications: false,
    use_saved_session: false,
    use_saved_credentials_reference: false,
    use_standing_attestation: false,
  }
  if (!db || !profileId) return out
  const list = await listActiveAuthorizations(db, { profileId, fundingSourceId, taskId })
  for (const a of list) {
    if (a.authorization_type in out) out[a.authorization_type] = true
  }
  void isAuthorizationActive // keep import for future single-flag lookup convenience
  return out
}
