/**
 * draftPacketPortalBridge.js — the bridge between internally drafted
 * application packets and Hamilton's portal-filling machinery.
 *
 * Owner directive (2026-08-03): the drafted application packets ("Start
 * Proposal" → Auto-populate → the per-grant `applications` +
 * `application_sections` rows the user reviews/edits in the Apply page) must
 * not stay internal-only — their prepared content must be carried into each
 * external portal's application form, GLOBALLY: every profile, every portal,
 * keyed only by the task's funding source. No per-school special-casing.
 *
 * What this module does:
 *   - `loadDraftPacketForTask` resolves the draft packet for a Hamilton
 *     portal task (task.grant_id directly, or task.opportunity_id through
 *     grants.funding_opportunity_id), PROFILE-SCOPED: the grant must belong
 *     to the task's profile or nothing is returned.
 *   - `buildPortalAnswersFromDraftPacket` maps the drafted sections onto the
 *     autopilot engine's long-form answer keys (`essay` / `goals` — the SAME
 *     narrow allow-list applyNarrativeAnswers enforces, so short factual
 *     fields always stay the profile's verbatim values). Field TARGETING is
 *     unchanged: the engine keeps matching portal fields by name/label/aria
 *     text (FIELD_RULES) — never guessed CSS.
 *
 * What this module NEVER does:
 *   - it never touches submission authority. Draft content is a FILL source;
 *     the run stays filled-not-submitted unless the existing
 *     allow_auto_submit / household-authorization / tailored-approval gates
 *     all pass, exactly as before.
 *   - it never types placeholder text into a live portal (mirrors the MBA
 *     proposal path's evidence-placeholder refusal).
 *
 * Every function is best-effort and returns null/{} instead of throwing —
 * a missing packet must never break a portal run.
 */

// Ordered, global mapping from draft section_keys to the engine's long-form
// answer keys. First bucket that yields content wins per answer key:
//   - essay: a purpose-written personal statement beats a composition of the
//     proposal's need + narrative sections; both beat nothing.
//   - goals: the first goals-shaped section present.
// The keys cover the auto-populate templates (applyEngine
// buildDefaultSectionsForStyle) plus common scholarship-draft section names,
// so template evolution picks up automatically without editing this bridge.
const ESSAY_SECTION_SOURCES = Object.freeze([
  ['personal_statement'],
  ['needs_statement', 'project_narrative'],
  ['cover_letter'],
])
const GOALS_SECTION_SOURCES = Object.freeze([
  ['career_goals'],
  ['goals'],
  ['goals_objectives'],
  ['future_plans'],
])

// Never type an unfinished placeholder into a live portal form. Mirrors the
// MBA-proposal path's hasEvidencePlaceholder posture.
const PLACEHOLDER_RX = /\[\s*(?:INSERT|EVIDENCE\s+NEEDED|TODO|TBD|PLACEHOLDER|YOUR\s)/i

function usableSectionContent(section) {
  const text = String(section?.content || '').trim()
  if (!text) return null
  if (PLACEHOLDER_RX.test(text)) return null
  return text
}

/**
 * Load the drafted application packet for a Hamilton task's funding source.
 *
 * Resolution (profile-scoped at every step):
 *   1. grantId given → grant must exist AND grants.profile_id === profileId.
 *   2. else opportunityId given → newest grant of THIS profile linked via
 *      grants.funding_opportunity_id.
 *   3. newest `applications` row for that grant, plus its non-empty sections.
 *
 * @returns {Promise<{
 *   application_id: string, grant_id: string, status: string|null,
 *   sections: Array<{ section_key: string, title: string|null, content: string }>,
 * } | null>} null when no draft packet (with usable content) exists.
 */
export async function loadDraftPacketForTask(db, { profileId, grantId = null, opportunityId = null } = {}) {
  if (!db || !profileId || (!grantId && !opportunityId)) return null
  try {
    let resolvedGrantId = null
    if (grantId) {
      const g = await db
        .prepare('SELECT id, profile_id FROM grants WHERE id = ? LIMIT 1')
        .get(String(grantId))
      if (!g || String(g.profile_id || '') !== String(profileId)) return null
      resolvedGrantId = g.id
    } else {
      const g = await db
        .prepare(
          `SELECT id FROM grants
            WHERE profile_id = ? AND funding_opportunity_id = ?
            ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(String(profileId), String(opportunityId))
      if (!g) return null
      resolvedGrantId = g.id
    }

    const app = await db
      .prepare('SELECT id, grant_id, status FROM applications WHERE grant_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(String(resolvedGrantId))
    if (!app) return null

    const rows = await db
      .prepare(
        'SELECT section_key, title, content FROM application_sections WHERE application_id = ? ORDER BY section_key ASC',
      )
      .all(String(app.id))
    const sections = (rows || [])
      .map((r) => ({
        section_key: String(r.section_key || ''),
        title: r.title ?? null,
        content: String(r.content || ''),
      }))
      .filter((s) => s.section_key && s.content.trim() !== '')
    if (sections.length === 0) return null

    return { application_id: app.id, grant_id: app.grant_id, status: app.status ?? null, sections }
  } catch {
    // Tables may not exist (fresh installs, unit fixtures) — no packet, no error.
    return null
  }
}

/**
 * Map a draft packet's sections onto the engine's long-form portal answers.
 *
 * @param {Array<{section_key:string, content:string}>} sections
 * @returns {{
 *   answers: { essay?: string, goals?: string },
 *   sources: { essay?: string[], goals?: string[] },
 * }} `sources` records exactly which draft section_keys produced each answer
 *    key, so the task/run record can say what was filled from which section.
 */
export function buildPortalAnswersFromDraftPacket(sections) {
  const out = { answers: {}, sources: {} }
  if (!Array.isArray(sections) || sections.length === 0) return out
  const byKey = new Map()
  for (const s of sections) {
    if (!s || !s.section_key || byKey.has(s.section_key)) continue
    byKey.set(s.section_key, s)
  }

  const compose = (buckets) => {
    for (const bucket of buckets) {
      const used = []
      const parts = []
      for (const key of bucket) {
        const text = usableSectionContent(byKey.get(key))
        if (text) { parts.push(text); used.push(key) }
      }
      if (parts.length > 0) return { text: parts.join('\n\n'), used }
    }
    return null
  }

  const essay = compose(ESSAY_SECTION_SOURCES)
  if (essay) {
    out.answers.essay = essay.text
    out.sources.essay = essay.used
  }
  const goals = compose(GOALS_SECTION_SOURCES)
  if (goals) {
    out.answers.goals = goals.text
    out.sources.goals = goals.used
  }
  return out
}

/**
 * Given the engine result's `filled_fields`, report exactly which answer keys
 * were actually WRITTEN into the portal from the draft packet — the auditable
 * "filled from draft section X" record. Written ≠ sent: `submitted` is carried
 * separately so a filled-and-staged run can never read as a submission.
 *
 * @returns {{ application_id: string, filled_from_draft: Array<{key:string, draft_sections:string[]}>, submitted: boolean } | null}
 */
export function summarizeDraftFill({ applicationId, sources, engineResult } = {}) {
  if (!applicationId || !sources || typeof sources !== 'object') return null
  const filledKeys = new Set(
    (Array.isArray(engineResult?.filled_fields) ? engineResult.filled_fields : []).map((f) => f?.key).filter(Boolean),
  )
  const filled_from_draft = Object.entries(sources)
    .filter(([key]) => filledKeys.has(key))
    .map(([key, draftSections]) => ({ key, draft_sections: [...draftSections] }))
  return {
    application_id: applicationId,
    filled_from_draft,
    submitted: engineResult?.status === 'submitted',
  }
}
