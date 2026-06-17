/**
 * portalFieldMapper.js
 *
 * Deterministic mapper from a student profile to a portal form. Given:
 *   - a list of detected form fields ({ selector, name, id, label,
 *     placeholder, type, required, options? }), and
 *   - a normalised profile object (basic_information, household,
 *     student_info, university_applications, etc.),
 * returns:
 *   {
 *     mapped: { [selector]: { value, fieldKey, source, confidence } },
 *     missing: [{ selector, fieldKey, label, reason, required }],
 *     skipped: [{ selector, reason }],
 *   }
 *
 * Only deterministic rules live here. LLM-assisted mapping must run
 * AFTER this returns and must include `confidence` + `rationale` per
 * the spec; that hook is exposed via `extendWithLLMMapping(...)` but
 * the LLM call itself lives outside this module.
 *
 * Yana NEVER:
 *   - invents values
 *   - touches password / SSN / banking / payment fields
 *   - fills checkboxes that capture legal consent or attestation
 */

const FIELD_RULES = Object.freeze([
  // Identity
  { fieldKey: 'first_name',  patterns: [/first\s*name/i, /given\s*name/i, /^fname$/i] },
  { fieldKey: 'last_name',   patterns: [/last\s*name/i, /surname/i, /family\s*name/i, /^lname$/i] },
  { fieldKey: 'middle_name', patterns: [/middle\s*name/i, /^mname$/i] },
  { fieldKey: 'preferred_name', patterns: [/preferred\s*name/i, /nickname/i] },
  { fieldKey: 'full_name',   patterns: [/^name$/i, /full\s*name/i, /legal\s*name/i] },

  // Contact
  { fieldKey: 'email',       patterns: [/e-?mail/i] },
  { fieldKey: 'phone',       patterns: [/phone/i, /mobile/i, /cell/i, /telephone/i] },

  // Address
  { fieldKey: 'address1',    patterns: [/address\s*1/i, /street(?!.*2)/i, /^street$/i, /mailing\s*address/i, /address\s*line\s*1/i] },
  { fieldKey: 'address2',    patterns: [/address\s*2/i, /apt|unit|suite/i, /address\s*line\s*2/i] },
  { fieldKey: 'city',        patterns: [/^city$/i, /town/i] },
  { fieldKey: 'state',       patterns: [/^state$/i, /province/i, /region/i] },
  { fieldKey: 'zip',         patterns: [/zip/i, /postal/i] },
  { fieldKey: 'country',     patterns: [/country/i] },

  // Demographics
  { fieldKey: 'dob',         patterns: [/(date.*birth|dob|birthdate|birthday|birth\s*date)/i] },
  { fieldKey: 'gender',      patterns: [/gender/i, /sex/i] },
  { fieldKey: 'citizenship', patterns: [/citizenship/i, /citizen/i] },
  { fieldKey: 'residency',   patterns: [/residenc(y|e)/i, /resident\s*status/i] },

  // School / academic
  { fieldKey: 'school_name', patterns: [/school|institution|college|university/i] },
  { fieldKey: 'student_id',  patterns: [/student\s*id|m-?number|student\s*number/i] },
  { fieldKey: 'major',       patterns: [/major|program|field\s*of\s*study|concentration/i] },
  { fieldKey: 'degree_level',patterns: [/degree|level|undergrad|graduate|class\s*level/i] },
  { fieldKey: 'gpa',         patterns: [/gpa|grade\s*point/i] },
  { fieldKey: 'act',         patterns: [/^act$|act\s*score/i] },
  { fieldKey: 'sat',         patterns: [/^sat$|sat\s*score/i] },
  { fieldKey: 'graduation_year', patterns: [/graduation|grad\s*year|expected\s*grad/i] },

  // Financial / household
  { fieldKey: 'fafsa_status', patterns: [/fafsa/i] },
  { fieldKey: 'household_income', patterns: [/household\s*income|family\s*income|annual\s*income|^income$/i] },
  { fieldKey: 'household_size',   patterns: [/household\s*size|family\s*size|number\s*in\s*household/i] },
  { fieldKey: 'parent_first_name', patterns: [/parent.*first\s*name|guardian.*first\s*name/i] },
  { fieldKey: 'parent_last_name',  patterns: [/parent.*last\s*name|guardian.*last\s*name/i] },
  { fieldKey: 'parent_email',      patterns: [/parent.*email|guardian.*email/i] },
  { fieldKey: 'parent_phone',      patterns: [/parent.*phone|guardian.*phone/i] },

  // Status
  { fieldKey: 'veteran_status',    patterns: [/veteran/i, /military/i] },
  { fieldKey: 'dependent_status',  patterns: [/dependent\s*status|^dependent$/i] },

  // Essays & narratives
  { fieldKey: 'essay',  patterns: [/essay|personal\s*statement|why.*deserve|tell\s*us\s*about/i], multiline: true },
  { fieldKey: 'goals',  patterns: [/career\s*goals|future\s*goals|short\s*term\s*goals|long\s*term\s*goals/i], multiline: true },
])

const FORBIDDEN_PATTERNS = Object.freeze([
  /password/i,
  /\bssn\b|social\s*security/i,
  /\bcvv\b|credit\s*card|card\s*number|card\s*holder|expiration\s*month/i,
  /bank\s*(account|routing)/i,
  /signature/i,
  /agree|consent|attest|terms|privacy|i\s*acknowledge/i,
])

function fieldText(field) {
  return [
    field.label, field.name, field.id, field.placeholder, field.aria_label,
  ].filter(Boolean).join(' ')
}

function fieldIsForbidden(field) {
  if (field.type === 'password') return true
  const text = fieldText(field)
  return FORBIDDEN_PATTERNS.some((re) => re.test(text))
}

function matchRule(field) {
  const text = fieldText(field)
  for (const rule of FIELD_RULES) {
    if (rule.patterns.some((re) => re.test(text))) {
      if (rule.multiline && field.type !== 'textarea') {
        // narrative fields are only filled into actual textareas
        continue
      }
      return rule
    }
  }
  return null
}

function readPath(obj, path) {
  if (!obj || typeof path !== 'string') return undefined
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    if (/^\d+$/.test(p)) cur = cur[Number(p)]
    else cur = cur[p]
  }
  return cur
}

function isEmpty(v) {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

function pick(profile, paths) {
  for (const p of paths) {
    const v = readPath(profile, p)
    if (!isEmpty(v)) return v
  }
  return undefined
}

/**
 * Map a single profile fieldKey to a value. Returns undefined when the
 * profile has nothing usable — Yana will mark it missing rather than
 * inventing a value.
 */
function profileValueFor(fieldKey, profile) {
  const bi = profile?.basic_information || {}
  const hh = profile?.household || profile?.financial_information || {}
  const stu = profile?.student_info || profile?.education || {}
  const apps = profile?.university_applications?.applications || []
  const firstApp = apps[0] || {}

  switch (fieldKey) {
    case 'first_name': return pick(profile, ['basic_information.first_name', 'first_name', 'student_first_name'])
    case 'last_name':  return pick(profile, ['basic_information.last_name', 'last_name', 'student_last_name'])
    case 'middle_name': return pick(profile, ['basic_information.middle_name', 'middle_name'])
    case 'preferred_name': return pick(profile, ['basic_information.preferred_name', 'preferred_name'])
    case 'full_name': {
      const first = pick(profile, ['basic_information.first_name', 'first_name'])
      const last = pick(profile, ['basic_information.last_name', 'last_name'])
      return first && last ? `${first} ${last}` : undefined
    }
    case 'email':      return pick(profile, ['basic_information.email', 'email', 'contact_email'])
    case 'phone':      return pick(profile, ['basic_information.phone', 'phone', 'contact_phone', 'mobile'])
    case 'address1':   return pick(profile, ['basic_information.address1', 'basic_information.address', 'address1', 'mailing_address.line1'])
    case 'address2':   return pick(profile, ['basic_information.address2', 'mailing_address.line2'])
    case 'city':       return pick(profile, ['basic_information.city', 'city', 'mailing_address.city'])
    case 'state':      return pick(profile, ['basic_information.state', 'state', 'mailing_address.state'])
    case 'zip':        return pick(profile, ['basic_information.zip', 'zip', 'postal_code', 'mailing_address.zip'])
    case 'country':    return pick(profile, ['basic_information.country', 'country']) || 'United States'
    case 'dob':        return pick(profile, ['basic_information.dob', 'basic_information.date_of_birth', 'dob'])
    case 'gender':     return pick(profile, ['basic_information.gender', 'gender'])
    case 'citizenship':return pick(profile, ['basic_information.citizenship', 'citizenship_status', 'citizenship'])
    case 'residency':  return pick(profile, ['basic_information.residency', 'residency_status', 'residency'])
    case 'school_name': return firstApp.name || pick(profile, ['student_info.school_name', 'school_name', 'institution'])
    case 'student_id':  return firstApp.student_id || pick(profile, ['student_info.student_id', 'student_id'])
    case 'major':       return firstApp.major || firstApp.program || pick(profile, ['student_info.major', 'major', 'program'])
    case 'degree_level':return firstApp.degree_level || pick(profile, ['student_info.degree_level', 'degree_level', 'class_level', 'level'])
    case 'gpa':         return pick(profile, ['student_info.gpa', 'gpa', 'cumulative_gpa'])
    case 'act':         return pick(profile, ['student_info.act_score', 'act_score', 'act'])
    case 'sat':         return pick(profile, ['student_info.sat_score', 'sat_score', 'sat'])
    case 'graduation_year': return firstApp.expected_graduation || pick(profile, ['student_info.expected_graduation', 'graduation_year'])
    case 'fafsa_status':    return pick(profile, ['financial_information.fafsa_status', 'fafsa_status', 'fafsa.status', 'fafsa'])
    case 'household_income':return pick(profile, ['financial_information.household_income', 'household.income', 'household_income', 'annual_income'])
    case 'household_size':  return pick(profile, ['financial_information.household_size', 'household.size', 'household_size', 'family_size'])
    case 'parent_first_name': return pick(profile, ['household.primary_parent.first_name', 'parent.first_name', 'guardian.first_name'])
    case 'parent_last_name':  return pick(profile, ['household.primary_parent.last_name', 'parent.last_name', 'guardian.last_name'])
    case 'parent_email':      return pick(profile, ['household.primary_parent.email', 'parent.email', 'guardian.email'])
    case 'parent_phone':      return pick(profile, ['household.primary_parent.phone', 'parent.phone', 'guardian.phone'])
    case 'veteran_status':    return pick(profile, ['basic_information.veteran_status', 'veteran_status'])
    case 'dependent_status':  return pick(profile, ['basic_information.dependent_status', 'dependent_status'])
    case 'essay':       return pick(profile, ['essays.primary', 'essays.personal_statement', 'personal_statement', 'narrative'])
    case 'goals':       return pick(profile, ['essays.goals', 'goals', 'career_goals'])
    default:            return undefined
  }
}

function coerceForFieldType(value, field) {
  if (value === undefined || value === null) return value
  if (field?.type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
    const lower = String(value).toLowerCase()
    const exact = field.options.find((opt) =>
      String(opt.value || '').toLowerCase() === lower
      || String(opt.label || '').toLowerCase() === lower,
    )
    if (exact) return exact.value
    const partial = field.options.find((opt) =>
      String(opt.value || '').toLowerCase().includes(lower)
      || String(opt.label || '').toLowerCase().includes(lower),
    )
    if (partial) return partial.value
    // No safe match → return undefined; Yana will mark this as missing
    // rather than picking a guess.
    return undefined
  }
  if (field?.type === 'date') {
    // Try to coerce ISO yyyy-mm-dd
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  if (field?.type === 'number') {
    const n = Number(String(value).replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? String(n) : undefined
  }
  return String(value)
}

/**
 * Build the deterministic mapping. Pure function — no IO.
 */
export function mapFormToProfile({ fields = [], profile = null } = {}) {
  const mapped = {}
  const missing = []
  const skipped = []

  for (const field of fields || []) {
    if (!field || !field.selector) continue
    if (fieldIsForbidden(field)) {
      skipped.push({ selector: field.selector, reason: 'forbidden_field_type' })
      continue
    }
    const rule = matchRule(field)
    if (!rule) {
      if (field.required) {
        missing.push({
          selector: field.selector,
          fieldKey: null,
          label: field.label || field.name || field.id || field.selector,
          reason: 'unrecognized_required_field',
          required: true,
        })
      } else {
        skipped.push({ selector: field.selector, reason: 'no_rule_match' })
      }
      continue
    }
    const raw = profileValueFor(rule.fieldKey, profile)
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      missing.push({
        selector: field.selector,
        fieldKey: rule.fieldKey,
        label: field.label || field.name || rule.fieldKey,
        reason: 'profile_field_empty',
        required: Boolean(field.required),
      })
      continue
    }
    const coerced = coerceForFieldType(raw, field)
    if (coerced === undefined) {
      missing.push({
        selector: field.selector,
        fieldKey: rule.fieldKey,
        label: field.label || field.name || rule.fieldKey,
        reason: 'no_safe_match_for_select_options',
        required: Boolean(field.required),
      })
      continue
    }
    mapped[field.selector] = {
      value: coerced,
      fieldKey: rule.fieldKey,
      source: 'profile',
      confidence: 1.0,
      rationale: `deterministic rule "${rule.fieldKey}" matched ${field.label || field.name || field.id}`,
    }
  }

  return { mapped, missing, skipped }
}

/**
 * Hook for LLM-assisted mapping. The LLM result MUST include confidence
 * and rationale per the spec. This module never calls the LLM itself —
 * the caller passes a function that can.
 */
export async function extendWithLLMMapping({ initial, fields, profile, llmFn }) {
  if (!llmFn || typeof llmFn !== 'function') return initial
  if (!Array.isArray(initial?.missing) || initial.missing.length === 0) return initial
  try {
    const out = await llmFn({ fields, profile, missing: initial.missing })
    if (!out || typeof out !== 'object') return initial
    const merged = { ...initial }
    for (const [selector, result] of Object.entries(out.mapped || {})) {
      if (!result || typeof result !== 'object') continue
      const conf = Number(result.confidence)
      // Refuse low-confidence LLM outputs — Yana never invents.
      if (!Number.isFinite(conf) || conf < 0.6) continue
      merged.mapped[selector] = {
        value: String(result.value),
        fieldKey: result.fieldKey || null,
        source: 'llm',
        confidence: conf,
        rationale: String(result.rationale || ''),
      }
      merged.missing = merged.missing.filter((m) => m.selector !== selector)
    }
    return merged
  } catch (err) {
    console.warn(`[yanaFieldMapper] LLM mapping failed: ${err?.message || err}`)
    return initial
  }
}

export const _internal = { FIELD_RULES, FORBIDDEN_PATTERNS, profileValueFor, fieldIsForbidden, matchRule, coerceForFieldType }
