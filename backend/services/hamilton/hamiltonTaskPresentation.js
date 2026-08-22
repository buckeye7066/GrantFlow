/**
 * The ONE place a Hamilton task acquires the name a person reads.
 *
 * WHY. `application_tasks` has no title column — it never has. It carries
 * `grant_id` and `opportunity_id`, and the name lives on the row it points at.
 * `hamiltonProfileSummary` has resolved that join since it was written, which
 * is why `HamiltonWorkPanel` shows real funder names. The run dashboard
 * (`HamiltonAutomationWatch`) read `task.title || task.opportunity_title` —
 * two fields the API has never returned — so its fallback fired on EVERY row
 * and every card in the list read "Untitled funding source".
 *
 * Measured against production on 2026-08-21 (931 tasks): 418 rows can resolve
 * a grant title and 417 an opportunity title (594 distinct rows have one
 * somewhere), 337 have no title anywhere, and of those 337 nearly all still
 * carry an application or portal URL. So the truth is not "the names were
 * never captured" — for roughly two thirds of the fleet the name was sitting
 * one join away, and for most of the rest a real, distinguishing identifier
 * (the funder's own host) was too.
 *
 * This module is the single resolver. `hamiltonProfileSummary` delegates to it
 * rather than keeping a second copy, because two identity rules is how the two
 * surfaces drifted apart in the first place.
 */
import { isSearchEngineUrl } from '../../config/urlRules.js'
import { decodeHtmlEntities } from '../../utils/htmlTextHygiene.js'

/**
 * Nothing here should ever be presented as a funding source's NAME. Also decode
 * HTML entities: a title stored raw (ingested before the ingest-time decode, or
 * by a path that skipped it) rendered as markup in the owner-facing card —
 * "Improving global health security in C&ocirc;te d'Ivoire", "FY 2024 &ndash;
 * 2026 …", "Reception &amp; Placement". The decode is idempotent, so an
 * already-clean title is unchanged.
 */
function cleanText(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (s.length === 0) return null
  const decoded = decodeHtmlEntities(s).trim()
  return decoded.length > 0 ? decoded : null
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean).map(String))]
}

/**
 * The host, rendered the way a person recognises a funder: no scheme, no
 * "www.", no path. `studentaid.gov`, `clevelandstatecc.scholarships.ngwebsolutions.com`.
 */
export function hostLabelFromUrl(value) {
  const raw = cleanText(value)
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (!/^https?:$/i.test(parsed.protocol)) return null
    return parsed.hostname.replace(/^www\./i, '') || null
  } catch {
    return null
  }
}

/**
 * The page the owner would actually open for this task. A search-results page
 * is never one (the enforceNoSearchEngineApplicationTargets rule), and
 * returning null keeps the caller's own fallback honest.
 */
export function taskApplyUrl(task = {}, urlMap = new Map()) {
  const candidates = [
    task.application_url,
    task.portal_url,
    task.grant_id ? urlMap.get(`grant:${task.grant_id}`) : null,
    task.opportunity_id ? urlMap.get(`opp:${task.opportunity_id}`) : null,
  ]
  for (const candidate of candidates) {
    const value = cleanText(candidate)
    if (!value) continue
    if (!/^https?:\/\//i.test(value)) continue
    if (isSearchEngineUrl(value)) continue
    return value
  }
  return null
}

/**
 * Batched title/funder/URL lookup for a list of tasks.
 *
 * TRAP (the #946/#954 schema-drift class, inherited verbatim from
 * hamiltonProfileSummary): prod Postgres `grants` has NO `source_url` column
 * even though SQLite does. Selecting it here would throw, the catch would
 * swallow it, and every task would silently lose its TITLE as well. Reference
 * only columns that exist in BOTH dialects.
 */
export async function resolveTaskSourceRows(db, tasks = []) {
  const titleMap = new Map()
  const funderMap = new Map()
  const urlMap = new Map()

  const list = Array.isArray(tasks) ? tasks : []
  const grantIds = uniqueStrings(list.map((t) => t?.grant_id))
  const oppIds = uniqueStrings(list.map((t) => t?.opportunity_id))
  // Scope grant reads to the profiles the tasks themselves name, so this can
  // never widen past the tasks the caller was already authorised to see.
  const profileIds = uniqueStrings(list.map((t) => t?.profile_id))

  if (grantIds.length && profileIds.length) {
    try {
      const idPh = grantIds.map(() => '?').join(',')
      const profilePh = profileIds.map(() => '?').join(',')
      const rows = await db
        .prepare(
          `SELECT id, title, funder, application_url, url
             FROM grants
            WHERE id IN (${idPh}) AND profile_id IN (${profilePh})`,
        )
        .all(...grantIds, ...profileIds)
      for (const row of rows || []) {
        const title = cleanText(row?.title)
        if (title) titleMap.set(`grant:${row.id}`, title)
        const funder = cleanText(row?.funder)
        if (funder) funderMap.set(`grant:${row.id}`, funder)
        const url = cleanText(row?.application_url) || cleanText(row?.url)
        if (url) urlMap.set(`grant:${row.id}`, url)
      }
    } catch { /* table/shape mismatch — keep the fallbacks */ }
  }

  if (oppIds.length) {
    try {
      const ph = oppIds.map(() => '?').join(',')
      const rows = await db
        .prepare(
          `SELECT id, title, sponsor, application_url, source_url
             FROM funding_opportunities
            WHERE id IN (${ph})`,
        )
        .all(...oppIds)
      for (const row of rows || []) {
        const title = cleanText(row?.title)
        if (title) titleMap.set(`opp:${row.id}`, title)
        const sponsor = cleanText(row?.sponsor)
        if (sponsor) funderMap.set(`opp:${row.id}`, sponsor)
        const url = cleanText(row?.application_url) || cleanText(row?.source_url)
        if (url) urlMap.set(`opp:${row.id}`, url)
      }
    } catch { /* table/shape mismatch — keep the fallbacks */ }
  }

  return { titleMap, funderMap, urlMap }
}

/**
 * The display identity of ONE task, with its PROVENANCE.
 *
 * `title_source` is the load-bearing part: a caller must be able to tell a real
 * funder name from a host we fell back to from a placeholder. A surface that
 * cannot tell those apart is how 931 rows came to read identically.
 */
export function resolveTaskIdentity(task = {}, maps = {}) {
  const titleMap = maps.titleMap || new Map()
  const funderMap = maps.funderMap || new Map()
  const urlMap = maps.urlMap || new Map()

  const grantKey = task.grant_id ? `grant:${task.grant_id}` : null
  const oppKey = task.opportunity_id ? `opp:${task.opportunity_id}` : null

  const title = (grantKey && titleMap.get(grantKey)) || (oppKey && titleMap.get(oppKey)) || null
  const funder = (grantKey && funderMap.get(grantKey)) || (oppKey && funderMap.get(oppKey)) || null
  const applyUrl = taskApplyUrl(task, urlMap)

  if (title) {
    return { display_title: title, title_source: 'source_record', funder_name: funder, apply_url: applyUrl }
  }

  // No stored name. A funder's own host is a REAL identifier — it tells the
  // owner which organisation this row is about and it differs row to row,
  // which a shared placeholder never does.
  const host = hostLabelFromUrl(applyUrl)
  if (host) {
    return { display_title: host, title_source: 'host', funder_name: funder, apply_url: applyUrl }
  }

  if (funder) {
    return { display_title: funder, title_source: 'funder', funder_name: funder, apply_url: applyUrl }
  }

  // Genuinely nothing to say. Say THAT, and name the row so two of them are
  // still distinguishable — never a placeholder shared by every card.
  const shortId = String(task.id || '').slice(0, 8)
  return {
    display_title: shortId ? `Unnamed source (${shortId})` : 'Unnamed source',
    title_source: 'none',
    funder_name: null,
    apply_url: applyUrl,
  }
}

/**
 * The event that put a terminal task into its final state — specifically WHO
 * did it.
 *
 * This is the fact the tracker could not tell you. In production, of the 43
 * tasks reading `submitted`, 41 carry an event whose actor_role is `admin` and
 * whose message is "User marked this application submitted from the
 * Application Tracker", stamped inside 85 seconds on 2026-08-03; only 17
 * `submitted` events anywhere carry actor_role `agent` (Hamilton's own
 * evidence-gated path). Those are completely different claims and the product
 * rendered them with the same word.
 */
export async function resolveTerminalActors(db, tasks = []) {
  const byTask = new Map()
  const terminalIds = uniqueStrings(
    (Array.isArray(tasks) ? tasks : [])
      .filter((t) => ['submitted', 'cancelled', 'failed'].includes(String(t?.status || '').toLowerCase()))
      .map((t) => t?.id),
  )
  if (!terminalIds.length) return byTask

  try {
    const ph = terminalIds.map(() => '?').join(',')
    const rows = await db
      .prepare(
        `SELECT task_id, event_type, actor_role, message, created_at
           FROM application_task_events
          WHERE task_id IN (${ph})
            AND event_type IN ('submitted', 'cancelled', 'failed')
          ORDER BY created_at ASC`,
      )
      .all(...terminalIds)
    // Ascending order + unconditional overwrite leaves the LATEST event per
    // task, which is the one that decided its final state.
    for (const row of rows || []) {
      byTask.set(String(row.task_id), {
        actor_role: cleanText(row?.actor_role),
        event_type: cleanText(row?.event_type),
        message: cleanText(row?.message),
        at: row?.created_at || null,
      })
    }
  } catch { /* events table unavailable — callers fall back to the task row */ }

  return byTask
}

/**
 * Who a submission should be ATTRIBUTED to, in the product's own words.
 *
 * Only three answers are honest, and "we do not know" is one of them: a task
 * whose submitted event predates actor recording, or whose event row is gone,
 * must not be attributed to either party.
 */
export function submissionActor(task = {}, terminalEvent = null) {
  if (String(task?.status || '').toLowerCase() !== 'submitted') return null
  const role = String(terminalEvent?.actor_role || '').toLowerCase()
  if (role === 'agent') return 'hamilton'
  if (role === 'admin' || role === 'owner' || role === 'user' || role === 'member') return 'owner'
  return 'unrecorded'
}

/**
 * Attach display identity, the terminal actor, and the recorded reason to a
 * list of tasks. This is what every task-list surface should render from.
 */
export async function attachTaskPresentation(db, tasks = []) {
  const list = Array.isArray(tasks) ? tasks : []
  if (!list.length) return []

  const maps = await resolveTaskSourceRows(db, list)
  const actors = await resolveTerminalActors(db, list)

  return list.map((task) => {
    const identity = resolveTaskIdentity(task, maps)
    const terminalEvent = actors.get(String(task.id)) || null
    return {
      ...task,
      ...identity,
      // The reason is ALREADY persisted on every cancelled row — all 331 in
      // production carry one — it simply was never shown. Surfacing it is the
      // whole fix; inventing one where none exists is forbidden.
      outcome_reason: cleanText(task.last_agent_message),
      terminal_actor_role: terminalEvent?.actor_role || null,
      terminal_actor_message: terminalEvent?.message || null,
      terminal_actor_at: terminalEvent?.at || null,
      submitted_by: submissionActor(task, terminalEvent),
    }
  })
}

export default {
  attachTaskPresentation,
  resolveTaskSourceRows,
  resolveTaskIdentity,
  resolveTerminalActors,
  submissionActor,
  taskApplyUrl,
  hostLabelFromUrl,
}
