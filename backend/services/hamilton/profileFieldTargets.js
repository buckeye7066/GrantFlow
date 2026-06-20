/**
 * profileFieldTargets.js  (backend)
 *
 * Maps a missing-info field `key` (as carried in a hamilton_blockers metadata
 * row — e.g. "first_name") to the profile_section + field it lives in, so an
 * inline hard-stop fix knows WHERE to write the value the operator types.
 *
 * This is the server-side twin of src/config/missingInfoTargets.js. The two
 * MUST stay aligned — this file decides where the backend writes; that file
 * decides where the UI deep-links. Only scalar, inline-fillable fields are
 * listed here: documents, saved logins, payments, etc. are NOT inline-fixable
 * (they live outside profile_sections) and resolve to null so callers fall
 * back to the navigate-to-fix flow.
 */

// key → { section, field, label }. Keep aligned with MISSING_INFO_TARGETS, BUT
// `field` is the guard-accepted column name (verified against SECTION_METADATA),
// which can differ from the blocker key — e.g. key "zip" writes to "zip_code".
// Only fields the section guard accepts are listed; offering anything else would
// let the UI show an input the save would reject.
const FIELD_TARGETS = Object.freeze({
  // basic_information
  full_name:   { section: 'basic_information', field: 'full_name',   label: 'Full name' },
  first_name:  { section: 'basic_information', field: 'first_name',  label: 'First name' },
  middle_name: { section: 'basic_information', field: 'middle_name', label: 'Middle name' },
  last_name:   { section: 'basic_information', field: 'last_name',   label: 'Last name' },
  email:       { section: 'basic_information', field: 'email',       label: 'Email address' },
  phone:       { section: 'basic_information', field: 'phone',       label: 'Phone number' },
  website:     { section: 'basic_information', field: 'website',     label: 'Website' },
  address:     { section: 'basic_information', field: 'address',     label: 'Mailing address' },
  city:        { section: 'basic_information', field: 'city',        label: 'City' },
  state:       { section: 'basic_information', field: 'state',       label: 'State' },
  zip:         { section: 'basic_information', field: 'zip_code',    label: 'ZIP code' },
  zip_code:    { section: 'basic_information', field: 'zip_code',    label: 'ZIP code' },

  // financial_information
  household_income: { section: 'financial_information', field: 'household_income', label: 'Household income' },
})

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * Resolve a field key to its inline-writable target, or null when the key is
 * not a scalar profile field (documents, logins, fees → handled elsewhere).
 *
 * @returns {{ key: string, section: string, field: string, label: string } | null}
 */
export function resolveProfileFieldTarget(key) {
  const k = normalizeKey(key)
  if (!k) return null
  const t = FIELD_TARGETS[k]
  return t ? { key: k, ...t } : null
}

/** The field key a missing/ambiguous-info blocker points at, if any. */
function blockerFieldKey(blocker) {
  const m = blocker?.metadata || {}
  return m.field || m.key || m.missing_info_key || m.missing_field || null
}

const INLINE_FIXABLE_BLOCKER_TYPES = new Set([
  'missing_required_information',
  'ambiguous_required_field',
])

/**
 * Resolve the inline-fix descriptor for a blocker, or null if it's not an
 * inline-fixable missing/ambiguous scalar field. Authoritative: this is what
 * the API attaches to each blocker so the UI only ever shows an input the
 * save endpoint will actually accept.
 *
 * @returns {{ fieldKey: string, sectionKey: string, field: string, label: string } | null}
 */
export function inlineFieldForBlocker(blocker) {
  if (!blocker || !INLINE_FIXABLE_BLOCKER_TYPES.has(blocker.blocker_type)) return null
  const target = resolveProfileFieldTarget(blockerFieldKey(blocker))
  if (!target) return null
  return { fieldKey: target.key, sectionKey: target.section, field: target.field, label: target.label }
}

export const PROFILE_FIELD_TARGETS = FIELD_TARGETS

export default { PROFILE_FIELD_TARGETS, resolveProfileFieldTarget, inlineFieldForBlocker }
