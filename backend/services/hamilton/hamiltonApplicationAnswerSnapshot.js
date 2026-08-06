/**
 * Resolve a frozen, target-scoped application answer set.
 *
 * University/application facts are never taken from `applications[0]`.  A
 * school-specific value is usable only when the current portal/source resolves
 * to exactly one application record; ambiguous values become a human-review
 * blocker.  Provenance stores field/source identifiers, never the values.
 */
import crypto from 'node:crypto'

const TARGET_SCOPED_KEYS = Object.freeze([
  'school', 'major', 'degree_level', 'student_id', 'expected_graduation',
])

function pick(obj, paths) {
  if (!obj) return undefined
  for (const path of paths) {
    let current = obj
    let missing = false
    for (const segment of path.split('.')) {
      if (current === null || current === undefined) { missing = true; break }
      current = current[segment]
    }
    if (!missing && current !== null && current !== undefined && String(current).trim() !== '') return current
  }
  return undefined
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function hostOf(value) {
  try { return new URL(String(value)).hostname.toLowerCase() } catch { return null }
}

function domainsForApplication(application) {
  const urls = [
    application?.website_url,
    application?.application_url,
    ...Object.values(application?.portals || {}),
  ].filter(Boolean)
  return [...new Set(urls.map(hostOf).filter(Boolean))]
}

function nameHints({ opportunity, grant, task }) {
  return [
    opportunity?.institution_name,
    opportunity?.school_name,
    opportunity?.organization_name,
    opportunity?.sponsor,
    grant?.institution_name,
    grant?.school_name,
    grant?.organization_name,
    grant?.sponsor,
    task?.institution_name,
    task?.school_name,
  ].map(normalizeText).filter(Boolean)
}

function idHints({ opportunity, grant, task }) {
  return new Set([
    opportunity?.university_application_id,
    opportunity?.institution_id,
    grant?.university_application_id,
    grant?.institution_id,
    task?.university_application_id,
    task?.institution_id,
  ].map((value) => String(value || '').trim()).filter(Boolean))
}

function scoreApplication(application, context) {
  let score = 0
  const reasons = []
  const ids = idHints(context)
  for (const value of [application?.id, application?.application_id, application?.institution_id]) {
    if (value && ids.has(String(value))) { score += 100; reasons.push('exact_target_id') }
  }
  const portalHost = hostOf(context.portalUrl)
  if (portalHost && domainsForApplication(application).some((host) => (
    portalHost === host || portalHost.endsWith(`.${host}`) || host.endsWith(`.${portalHost}`)
  ))) {
    score += 50
    reasons.push('portal_domain')
  }
  const appName = normalizeText(application?.name || application?.school_name || application?.institution_name)
  if (appName) {
    for (const hint of nameHints(context)) {
      if (hint === appName) { score += 40; reasons.push('exact_institution_name'); break }
      if (hint.includes(appName) || appName.includes(hint)) { score += 20; reasons.push('institution_name_overlap'); break }
    }
  }
  return { application, score, reasons }
}

export function resolveTargetUniversityApplication(profile, context = {}) {
  const apps = pick(profile, ['university_applications.applications', 'sections.university_applications.applications'])
  const applications = Array.isArray(apps) ? apps.filter((app) => app && typeof app === 'object') : []
  const ranked = applications.map((application) => scoreApplication(application, context))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  if (ranked.length === 0) {
    return { application: null, status: applications.length > 0 ? 'unresolved' : 'not_present', candidates: [] }
  }
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    return {
      application: null,
      status: 'ambiguous',
      candidates: ranked.filter((entry) => entry.score === ranked[0].score).map((entry) => ({
        id: entry.application.id || entry.application.application_id || null,
        reasons: entry.reasons,
      })),
    }
  }
  return { application: ranked[0].application, status: 'resolved', candidates: [] }
}

function add(values, provenance, key, value, source) {
  if (value === undefined || value === null || String(value).trim() === '') return
  values[key] = value
  provenance[key] = { source }
}

function readOrgNarrative(profile) {
  const mission = pick(profile, [
    'narrative.mission_statement', 'sections.narrative.mission_statement',
    'organization_details.mission_statement', 'sections.organization_details.mission_statement',
    'mission_statement',
  ])
  const programs = pick(profile, [
    'narrative.programs_description', 'sections.narrative.programs_description',
    'organization_details.programs_description', 'sections.organization_details.programs_description',
  ])
  return [mission, programs].filter(Boolean).join('\n\n') || undefined
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

export function buildTargetScopedAnswerSnapshot({
  profile,
  task = {},
  opportunity = {},
  grant = {},
  portalUrl,
  narrativeAnswers = null,
} = {}) {
  if (!profile) throw new Error('profile required')
  const values = {}
  const provenance = {}
  const scoped = resolveTargetUniversityApplication(profile, { task, opportunity, grant, portalUrl })

  const fields = [
    ['first_name', ['basic_information.first_name', 'sections.basic_information.first_name', 'first_name']],
    ['last_name', ['basic_information.last_name', 'sections.basic_information.last_name', 'last_name']],
    ['email', ['basic_information.email', 'sections.basic_information.email', 'email']],
    ['phone', ['basic_information.phone', 'sections.basic_information.phone', 'phone']],
    ['address1', ['basic_information.address1', 'sections.basic_information.address1', 'basic_information.address', 'sections.basic_information.address']],
    ['address2', ['basic_information.address2', 'sections.basic_information.address2']],
    ['city', ['basic_information.city', 'sections.basic_information.city']],
    ['state', ['basic_information.state', 'sections.basic_information.state']],
    ['zip', ['basic_information.zip', 'sections.basic_information.zip']],
    ['country', ['basic_information.country', 'sections.basic_information.country']],
    ['gpa', ['student_info.gpa', 'sections.student_info.gpa', 'gpa']],
    ['act_score', ['student_info.act_score', 'sections.student_info.act_score', 'act_score']],
    ['sat_score', ['student_info.sat_score', 'sections.student_info.sat_score', 'sat_score']],
    ['household_income', ['financial_information.household_income', 'sections.financial_information.household_income', 'household.income', 'household_income']],
    ['household_size', ['financial_information.household_size', 'sections.financial_information.household_size', 'household.size', 'household_size']],
    ['fafsa_efc', ['financial_information.fafsa_efc', 'sections.financial_information.fafsa_efc', 'financial_information.sai', 'sections.financial_information.sai']],
  ]
  for (const [key, paths] of fields) add(values, provenance, key, pick(profile, paths), `profile:${paths[0]}`)
  const fullName = [values.first_name, values.last_name].filter(Boolean).join(' ')
  add(values, provenance, 'full_name', fullName, 'derived:profile_name_parts')

  const app = scoped.application
  if (app) {
    const appId = String(app.id || app.application_id || app.institution_id || 'target-scoped')
    add(values, provenance, 'school', app.name || app.school_name || app.institution_name, `university_application:${appId}:name`)
    add(values, provenance, 'major', app.major, `university_application:${appId}:major`)
    add(values, provenance, 'degree_level', app.degree_level, `university_application:${appId}:degree_level`)
    add(values, provenance, 'student_id', app.student_id, `university_application:${appId}:student_id`)
    add(values, provenance, 'expected_graduation', app.expected_graduation, `university_application:${appId}:expected_graduation`)
  }

  add(values, provenance, 'essay', pick(profile, [
    'essays.primary', 'sections.essays.primary', 'essays.personal_statement',
    'sections.essays.personal_statement', 'personal_statement',
  ]) ?? readOrgNarrative(profile), 'profile:narrative')
  add(values, provenance, 'goals', pick(profile, [
    'essays.goals', 'sections.essays.goals', 'goals', 'career_goals',
  ]), 'profile:goals')
  for (const key of ['essay', 'goals']) {
    const value = narrativeAnswers?.[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      values[key] = String(value)
      provenance[key] = { source: `target_scoped_narrative:${key}` }
    }
  }

  const conflicts = []
  if (scoped.status === 'ambiguous') {
    conflicts.push({
      kind: 'ambiguous_target_application',
      fields: TARGET_SCOPED_KEYS,
      candidate_ids: scoped.candidates.map((candidate) => candidate.id).filter(Boolean),
    })
  } else if (scoped.status === 'unresolved') {
    conflicts.push({
      kind: 'unresolved_target_application',
      fields: TARGET_SCOPED_KEYS,
    })
  }

  const payload = stable({ values, provenance, target_application_status: scoped.status })
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const targetApplicationId = app?.id || app?.application_id || app?.institution_id || 'unresolved'
  return {
    values,
    provenance,
    hash,
    conflicts,
    target_application_status: scoped.status,
    target_application_id: targetApplicationId,
  }
}

export function requiredFieldsMissingOrAmbiguous(snapshot, requiredKeys = []) {
  const required = [...new Set((requiredKeys || []).map(String).filter(Boolean))]
  const missing = required.filter((key) => {
    const value = snapshot?.values?.[key]
    return value === undefined || value === null || String(value).trim() === ''
  })
  const ambiguous = snapshot?.conflicts?.some((conflict) => (
    (conflict.fields || []).some((field) => required.includes(field))
  )) ? required.filter((key) => TARGET_SCOPED_KEYS.includes(key)) : []
  return { ok: missing.length === 0 && ambiguous.length === 0, missing, ambiguous }
}

export const _internal = Object.freeze({ normalizeText, hostOf, scoreApplication, stable })
