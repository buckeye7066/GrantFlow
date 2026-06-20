/**
 * John — evidence sufficiency.
 *
 * Pure functions, no I/O. Two jobs:
 *
 *   1. extractOrgSignals(lead)  — normalise the specific, personalizable facts
 *      Yana attached to a lead (mission, focus areas, program areas, website
 *      excerpt, a free-text hook). The email writer uses these to write
 *      grammatical, non-generic sentences; the orchestrator uses them to decide
 *      whether John has enough to work with.
 *
 *   2. assessLeadSufficiency(lead, interpretation) — decide whether the packet
 *      is rich enough for John to write a *personable, specific* email. If not,
 *      John asks Yana for more (see johnYanaBridge.requestLeadEnrichment). This
 *      is the trigger for John ↔ Yana communication.
 *
 * Why a dedicated module: the old writer derived its "hook" from a single
 * evidence field and, when that was thin, silently fell back to a generic
 * phrase — producing the bland, repetitive copy reviewers complained about.
 * Centralising "what specific material do we actually have?" means the writer
 * never has to invent filler and the agent can route thin leads back to Yana
 * instead of shipping a weak draft.
 */

/** Coerce to a trimmed string (or null). */
function str(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s || null
}

/** Coerce to a clean array of trimmed, de-duped, non-empty strings. */
function strList(v) {
  if (!Array.isArray(v)) return []
  const seen = new Set()
  const out = []
  for (const item of v) {
    const s = str(item)
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase())
      out.push(s)
    }
  }
  return out
}

/**
 * Pull the structured, factual signals Yana attached to the lead's
 * public_evidence. Mirrors the shape Yana writes in yanaLeadDiscovery
 * (mission_statement / focus_areas / program_areas / website_excerpt) but is
 * tolerant of loose/legacy shapes (plain strings, summary/headline fields).
 */
export function extractOrgSignals(lead) {
  const evidence = Array.isArray(lead?.public_evidence) ? lead.public_evidence : []

  let mission = null
  let focusAreas = []
  let programAreas = []
  let websiteExcerpt = null
  const freeText = []

  for (const e of evidence) {
    if (!e) continue
    if (typeof e === 'string') {
      const s = str(e)
      if (s) freeText.push(s)
      continue
    }
    if (typeof e !== 'object') continue

    switch (e.type) {
      case 'mission_statement':
        if (!mission) mission = str(e.text)
        break
      case 'focus_areas':
        focusAreas = focusAreas.concat(strList(e.value))
        break
      case 'program_areas':
        programAreas = programAreas.concat(strList(e.value))
        break
      case 'website_excerpt':
        if (!websiteExcerpt) websiteExcerpt = str(e.text)
        break
      case 'contact':
        // contact info is not a personalisation hook; ignore here.
        break
      default: {
        // Unknown/loose evidence: harvest any free-text we can use as a hook.
        const t = str(e.summary || e.text || e.headline || e.description)
        if (t) freeText.push(t)
      }
    }
  }

  focusAreas = strList(focusAreas)
  programAreas = strList(programAreas)

  // The single best free-text hook (mission first, then any other prose).
  const hookText =
    mission ||
    freeText.find((t) => t.length > 25) ||
    freeText[0] ||
    null

  // A substantive free-text hook (e.g. "replacing 25-year-old SCBA gear") is
  // enough for John to write a specific line, even without typed mission/focus
  // fields. Very short scraps ("grants", a bare org type) are not.
  const usableHook = Boolean(hookText && hookText.length >= 25)

  const specificCount =
    (mission ? 1 : 0) +
    (focusAreas.length ? 1 : 0) +
    (programAreas.length ? 1 : 0) +
    (websiteExcerpt ? 1 : 0) +
    (usableHook && hookText !== mission ? 1 : 0)

  return {
    mission,
    focusAreas,
    programAreas,
    websiteExcerpt,
    hookText,
    usableHook,
    funding_need_summary: str(lead?.funding_need_summary),
    grantflow_fit_summary: str(lead?.grantflow_fit_summary),
    recommended_outreach_angle: str(lead?.recommended_outreach_angle),
    /** at least one concrete, org-specific fact to write about. */
    hasSpecific: Boolean(
      mission || focusAreas.length || programAreas.length || websiteExcerpt || usableHook,
    ),
    specificCount,
  }
}

/**
 * Decide whether John can write a genuinely personalized email, or whether he
 * should ask Yana for enrichment first.
 *
 * Sufficient requires at least ONE concrete, org-specific signal (a mission,
 * focus areas, program areas, or a website excerpt). A generic
 * grantflow_fit_summary ("Organization with a contact channel…") does NOT
 * count — that is exactly the filler that produced bland drafts.
 *
 * Returns `missing[]` (machine-readable field names) and a human `note` John
 * passes to Yana so she knows precisely what to go find.
 */
export function assessLeadSufficiency(lead, interpretation = null) {
  const signals = extractOrgSignals(lead)
  const missing = []

  if (!signals.mission) missing.push('mission_statement')
  if (signals.focusAreas.length === 0 && signals.programAreas.length === 0) {
    missing.push('focus_or_program_areas')
  }
  if (!signals.websiteExcerpt) missing.push('website_excerpt')

  // A named recipient lifts the email from "Hi team," to "Hi <name>,". Not
  // required, but worth asking Yana to find when everything else is thin.
  const hasNamedContact = Boolean(
    interpretation?.contact?.name ||
      (Array.isArray(lead?.contact_points) &&
        lead.contact_points.some((p) => p && p.name)),
  )
  if (!hasNamedContact) missing.push('named_contact')

  const sufficient = signals.hasSpecific
  const orgName = str(lead?.organization_name) || 'this organization'

  let note = null
  if (!sufficient) {
    const want = missing
      .filter((m) => m !== 'named_contact')
      .map((m) => m.replace(/_/g, ' '))
    note =
      `John could not personalize outreach to ${orgName}: the packet has no ` +
      `mission, focus areas, program areas, or website excerpt to write about. ` +
      `Please enrich with ${want.join(', ') || 'public mission/program detail'}` +
      (hasNamedContact ? '.' : ', and a named contact if available.')
  }

  return { sufficient, missing, note, signals }
}

export default { extractOrgSignals, assessLeadSufficiency }
