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
import { isAuthorizationActive, listActiveAuthorizations } from './hamiltonAuthorizationStore.js'
import { parseFullName, looksLikeOrganization } from '../../../shared/nameParsing.js'

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

// Find a single full-name string anywhere on the profile (basic_information.
// full_name, profiles.display_name mirrored to the top level, or any aliased
// key at any depth), so first/last name can be DERIVED instead of demanded.
function findFullName(profile) {
  const v = deepFindByKeys(profile, ['full_name'])
  return nonEmpty(v) ? String(v) : null
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
    const opportunity = source.opportunity_id
      ? await loadOpportunity(db, source.opportunity_id)
      : null
    const grant = source.grant_id
      ? await loadGrant(db, source.grant_id)
      : null
    const r = await preflightSingleSource(db, {
      profile,
      profileId: profileId || profile?.id,
      source,
      opportunity,
      grant,
    })
    if (!r.ok) out.ok = false
    out.results.push({ source, ...r })
  }
  return out
}

async function loadOpportunity(db, id) {
  if (!db || !id) return null
  try {
    const row = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(id))
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
