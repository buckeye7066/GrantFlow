/**
 * Pure logic for the School Card AI Assist feature, extracted from the
 * adjacent .jsx module so Node's --test runner (which doesn't transform
 * JSX) can import it directly in unit tests.
 *
 * The .jsx component re-exports `mapAIDataToApplicationPatch` from here so
 * call sites stay unchanged.
 */

/**
 * Maps camelCase AI response keys to the application model's snake_case fields.
 * Returns a patch object suitable for onQuickUpdate.
 *
 * @param {Object} aiData - the AI response payload (camelCase keys)
 * @param {Object} [existingApplication] - the current application row, used
 *   to deep-merge nested objects (`portals`, `theme`, `costs`) so AI updates
 *   never blow away values the user already entered. The parent component's
 *   patch flow does a shallow merge ({ ...application, ...patch }), so any
 *   nested object in the patch must be pre-merged here.
 */
export function mapAIDataToApplicationPatch(aiData, existingApplication = null) {
  if (!aiData || typeof aiData !== 'object') return {}

  const parsePercent = (v) => {
    if (!v || v === '—') return null
    const m = String(v).match(/([\d.]+)/)
    return m ? parseFloat(m[1]) / 100 : null
  }

  const parseCurrency = (v) => {
    if (!v || v === '—') return null
    const m = String(v).replace(/,/g, '').match(/([\d.]+)/)
    return m ? parseFloat(m[1]) : null
  }

  const parseRatio = (v) => {
    if (!v || v === '—') return null
    const m = String(v).match(/(\d+)/)
    return m ? parseInt(m[1], 10) : null
  }

  const isUrl = (v) =>
    typeof v === 'string' && v !== '—' && /^https?:\/\//i.test(v.trim())

  const isHexColor = (v) =>
    typeof v === 'string' && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim())

  const normaliseHex = (v) => {
    const t = String(v || '').trim()
    return t.startsWith('#') ? t : `#${t}`
  }

  const patch = {}

  if (aiData.acceptanceRate && aiData.acceptanceRate !== '—')
    patch.acceptance_rate = parsePercent(aiData.acceptanceRate)
  if (aiData.avgGPA && aiData.avgGPA !== '—')
    patch.avg_gpa = parseFloat(aiData.avgGPA) || null
  if (aiData.satRange && aiData.satRange !== '—')
    patch.sat_range = aiData.satRange
  if (aiData.tuition && aiData.tuition !== '—')
    patch.tuition = parseCurrency(aiData.tuition)
  if (aiData.fafsaCode && aiData.fafsaCode !== '—')
    patch.fafsa_code = aiData.fafsaCode
  if (aiData.graduationRate && aiData.graduationRate !== '—')
    patch.graduation_rate = parsePercent(aiData.graduationRate)
  if (aiData.studentTeacher && aiData.studentTeacher !== '—')
    patch.student_teacher_ratio = parseRatio(aiData.studentTeacher)
  if (aiData.avgClassSize && aiData.avgClassSize !== '—')
    patch.avg_class_size = parseRatio(aiData.avgClassSize)
  if (aiData.estCost && aiData.estCost !== '—') {
    const cost = parseCurrency(aiData.estCost)
    if (cost) {
      patch.costs = { ...(existingApplication?.costs ?? {}), on_campus_total: cost }
    }
  }
  if (aiData.type && aiData.type !== '—') {
    const t = aiData.type.toLowerCase()
    if (t.includes('private')) patch.institution_type = 'private'
    else if (t.includes('public')) patch.institution_type = 'public'
    else patch.institution_type = aiData.type
  }

  // Top-level website on the application card. Don't overwrite a value
  // the user already entered — the user's value is canonical.
  if (isUrl(aiData.websiteUrl) && !existingApplication?.website_url) {
    patch.website_url = aiData.websiteUrl.trim()
  }

  // Portal URLs. Deep-merge into the existing portals object: only fill
  // entries that are currently empty, so AI never clobbers a saved
  // url-of-record (e.g. an MTSU MyMT URL the user customized).
  const portalUpdates = {}
  const portalMappings = [
    ['admissionsUrl', 'admissions_url'],
    ['financialAidUrl', 'financial_aid_url'],
    ['scholarshipsUrl', 'scholarship_url'],
    ['housingUrl', 'housing_url'],
    ['studentPortalUrl', 'student_portal_url'],
  ]
  for (const [src, dst] of portalMappings) {
    const v = aiData[src]
    if (!isUrl(v)) continue
    const existing = existingApplication?.portals?.[dst]
    if (existing && String(existing).trim()) continue
    portalUpdates[dst] = String(v).trim()
  }
  if (Object.keys(portalUpdates).length > 0) {
    patch.portals = { ...(existingApplication?.portals ?? {}), ...portalUpdates }
  }

  // Theme: official school colors + mascot + cheer line. Only fills
  // empty entries on the existing theme so the user's customizations win.
  const themeUpdates = {}
  if (isHexColor(aiData.primaryColor) && !existingApplication?.theme?.primary_color) {
    themeUpdates.primary_color = normaliseHex(aiData.primaryColor)
  }
  if (isHexColor(aiData.secondaryColor) && !existingApplication?.theme?.secondary_color) {
    themeUpdates.secondary_color = normaliseHex(aiData.secondaryColor)
  }
  if (typeof aiData.cheerLine === 'string' && aiData.cheerLine !== '—' && aiData.cheerLine.trim()
      && !existingApplication?.theme?.cheer_line) {
    themeUpdates.cheer_line = aiData.cheerLine.trim()
  }
  if (typeof aiData.mascot === 'string' && aiData.mascot !== '—' && aiData.mascot.trim()
      && !existingApplication?.theme?.mascot) {
    themeUpdates.mascot = aiData.mascot.trim()
  }
  if (Object.keys(themeUpdates).length > 0) {
    patch.theme = { ...(existingApplication?.theme ?? {}), ...themeUpdates }
  }

  return patch
}
