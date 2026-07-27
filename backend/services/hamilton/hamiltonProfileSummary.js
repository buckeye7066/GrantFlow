/**
 * hamiltonProfileSummary.js
 *
 * Single source of truth for "what is Hamilton working on for this profile and
 * WHERE does he need the owner's help". Extracted from the
 * GET /api/hamilton/automation/profile-summary route so the same data can feed
 * BOTH the profile-page Hamilton panel AND the Profile Action Plan
 * (/api/ai/profile-todo) — the owner asked that Hamilton's needs (missing
 * packet info, portals that need a side-by-side login) show up in the action
 * plan, not just Anya's items.
 *
 * Every sub-source is wrapped so a single failing store degrades to "skipped"
 * rather than failing the whole summary — this must never be a dead end.
 */

import {
  listApplicationTasks,
  listMissingInfoForTasks,
  TASK_BLOCKED_STATUSES,
  TASK_TERMINAL_STATUSES,
} from './applicationTaskStore.js'
import { getHamiltonReadiness } from './hamiltonScheduleService.js'
import { getMasterVaultStatus } from './hamiltonPortalMasterVault.js'
import { isSearchEngineUrl } from '../../config/urlRules.js'

// Canonical task vocabulary lives in applicationTaskStore (TASK_BLOCKED_STATUSES
// = blocked_* gates that need the owner; TASK_TERMINAL_STATUSES = done/failed/
// cancelled). We widen each with defensive aliases so an unexpected status is
// never silently mis-bucketed: anything blocked/waiting/needs-prefixed counts as
// "needs you", and a few extra finished synonyms count as terminal.
const TERMINAL_TASK_STATUS = new Set([
  ...TASK_TERMINAL_STATUSES,
  'completed', 'complete', 'done', 'canceled', 'archived', 'rejected', 'closed',
])
const NEEDS_USER_TASK_STATUS = new Set([
  ...TASK_BLOCKED_STATUSES,
  'needs_user', 'needs_info', 'blocked', 'awaiting_user', 'paused',
  'needs_authorization', 'waiting_on_user', 'waiting_for_user', 'action_required',
])

function taskNeedsUser(status) {
  return (
    NEEDS_USER_TASK_STATUS.has(status) ||
    status.startsWith('blocked') ||
    status.startsWith('waiting') ||
    status.startsWith('needs')
  )
}

function humanizeAutomationType(t) {
  const s = String(t || '').trim()
  if (!s || s === 'unknown') return 'Application'
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Best-effort, batched title + portal-URL resolution from the grants /
// funding_opportunities tables so tasks read as real funding-source names
// instead of raw ids, and so a blocked task can carry the REAL portal page the
// owner must visit. Missing tables or rows simply leave the fallbacks in place.
async function resolveTaskTitles(db, tasks, profileId) {
  const map = new Map()
  const urlMap = new Map()
  const grantIds = [...new Set((tasks || []).map((t) => t.grant_id).filter(Boolean).map(String))]
  const oppIds = [...new Set((tasks || []).map((t) => t.opportunity_id).filter(Boolean).map(String))]
  if (grantIds.length && profileId) {
    try {
      const ph = grantIds.map(() => '?').join(',')
      // TRAP (the #946/#954 schema-drift class): prod Postgres `grants` has NO
      // source_url column (SQLite does) — selecting it here would throw, the
      // catch would swallow it, and every task would silently lose its real
      // TITLE too. Reference only columns that exist in BOTH dialects.
      const rows = await db
        .prepare(`SELECT id, title, application_url, url FROM grants WHERE profile_id = ? AND id IN (${ph})`)
        .all(String(profileId), ...grantIds)
      for (const r of rows || []) {
        if (r?.title) map.set(`grant:${r.id}`, r.title)
        const u = r?.application_url || r?.url
        if (u) urlMap.set(`grant:${r.id}`, u)
      }
    } catch { /* table/shape mismatch — keep fallbacks */ }
  }
  if (oppIds.length) {
    try {
      const ph = oppIds.map(() => '?').join(',')
      const rows = await db
        .prepare(`SELECT id, title, application_url, source_url FROM funding_opportunities WHERE id IN (${ph})`)
        .all(...oppIds)
      for (const r of rows || []) {
        if (r?.title) map.set(`opp:${r.id}`, r.title)
        const u = r?.application_url || r?.source_url
        if (u) urlMap.set(`opp:${r.id}`, u)
      }
    } catch { /* table/shape mismatch — keep fallbacks */ }
  }
  return { titleMap: map, urlMap }
}

function taskTitleFromMap(task, titleMap) {
  return (
    (task.grant_id && titleMap.get(`grant:${task.grant_id}`)) ||
    (task.opportunity_id && titleMap.get(`opp:${task.opportunity_id}`)) ||
    humanizeAutomationType(task.automation_type)
  )
}

// The REAL page the owner must visit for a task: the task's own recorded
// application/portal URL first, then the linked grant's, then the catalog
// row's. Only a plain http(s), non-search-engine URL qualifies — a Google
// results page is never a portal (the enforceNoSearchEngineApplicationTargets
// class), and returning null keeps the internal-navigation fallback honest.
function taskPortalUrl(task, urlMap) {
  const candidates = [
    task.application_url,
    task.portal_url,
    task.grant_id ? urlMap.get(`grant:${task.grant_id}`) : null,
    task.opportunity_id ? urlMap.get(`opp:${task.opportunity_id}`) : null,
  ]
  for (const raw of candidates) {
    const u = String(raw || '').trim()
    if (!/^https?:\/\//i.test(u)) continue
    if (isSearchEngineUrl(u)) continue
    return u
  }
  return null
}

/**
 * Compute Hamilton's live work + needs for a profile.
 * @returns {Promise<{working_on: Array, needs_you: Array, next_run_at: string|null}>}
 */
export async function buildHamiltonProfileSummary(db, profileId) {
  const workingOn = []
  const needsYou = []

  // 1. Active tasks + their unresolved missing info.
  let tasks = []
  try { tasks = await listApplicationTasks(db, { profileId, limit: 200 }) } catch { tasks = [] }
  const { titleMap, urlMap } = await resolveTaskTitles(db, tasks, profileId)
  // One batched read for every task's missing info — a per-task query inside
  // the loop below was up to 200 serial round-trips, slow enough under a
  // contended pool to trip the edge-proxy timeout on the profile page.
  let missingByTask = new Map()
  try {
    missingByTask = await listMissingInfoForTasks(db, (tasks || []).map((t) => t.id), { includeResolved: false })
  } catch { missingByTask = new Map() }
  for (const t of tasks || []) {
    const status = String(t.status || '').toLowerCase()
    if (TERMINAL_TASK_STATUS.has(status)) continue
    const title = taskTitleFromMap(t, titleMap)
    if (taskNeedsUser(status)) {
      needsYou.push({
        id: `task:${t.id}`,
        kind: 'task_blocked',
        title: `${title} — needs your input`,
        detail: t.last_agent_message || t.current_step || 'Open the task to see what Hamilton is waiting on.',
        where: 'action-plan',
        task_id: t.id,
        // The REAL portal/application page for this task, so "Go there" can
        // open the actual destination instead of an internal fallback area.
        link_url: taskPortalUrl(t, urlMap),
      })
    } else {
      workingOn.push({
        id: t.id,
        title,
        automation_type: t.automation_type,
        status: t.status,
        current_step: t.current_step,
        last_message: t.last_agent_message,
        updated_at: t.updated_at,
      })
    }
    const missing = missingByTask.get(String(t.id)) || []
    for (const m of missing) {
      if (m.resolved) continue
      const isDoc = String(m.kind || '').toLowerCase() === 'document'
      needsYou.push({
        id: `missing:${m.id}`,
        kind: isDoc ? 'missing_document' : 'missing_field',
        title: m.label || m.key || (isDoc ? 'Document needed' : 'Information needed'),
        detail: m.description || `${title}: ${isDoc ? 'Hamilton needs this document.' : 'Hamilton needs this information.'}`,
        where: isDoc ? 'documents' : 'profile',
        task_id: t.id,
        field_key: isDoc ? null : (m.key || null),
        required: Boolean(m.required),
      })
    }
  }

  // 2. Portals that still need a captured login session ("sign in once").
  let readiness = null
  try { readiness = await getHamiltonReadiness(db, { profileId }) } catch { readiness = null }
  for (const host of readiness?.portals_needing_capture || []) {
    needsYou.push({
      id: `session:${host}`,
      kind: 'portal_session',
      title: `Sign in once to ${host}`,
      detail: 'Hamilton needs a captured login session here (SSO/2FA portals can’t be entered from a saved password alone).',
      where: 'pipeline',
      host,
    })
  }

  // 3. Master vault: set / unlock so Hamilton can provision and use portal logins.
  let vault = null
  try { vault = await getMasterVaultStatus(db, profileId) } catch { vault = null }
  if (vault && !vault.has_passphrase) {
    needsYou.push({
      id: 'vault:set', kind: 'vault',
      title: 'Set Hamilton’s master passphrase',
      detail: 'One passphrase lets Hamilton create and manage a unique, strong login for each portal.',
      where: 'pipeline',
    })
  } else if (vault && vault.has_passphrase && !vault.is_unlocked) {
    needsYou.push({
      id: 'vault:unlock', kind: 'vault',
      title: 'Unlock Hamilton’s vault',
      detail: 'Enter the master passphrase so Hamilton can use the saved logins for this session.',
      where: 'pipeline',
    })
  }

  return { working_on: workingOn, needs_you: needsYou, next_run_at: readiness?.next_run_at || null }
}

// How a needs_you item deep-links from the Action Plan. `go_to` mirrors
// ProfileDetail's URL contract (?tab=&focus=) and PrintableProfileTodo's
// field_key path (buildProfileSectionLink) — one of the two is enough for the
// frontend to take the user right to where the need is.
function todoItemFromNeed(need) {
  const kind = String(need.kind || '')
  const base = {
    title: need.title,
    priority: kind === 'missing_field' || kind === 'missing_document'
      ? (need.required ? 'critical' : 'high')
      : kind === 'portal_session' || kind === 'vault' ? 'high' : 'medium',
    deadline: null,
    instructions: need.detail || '',
    resources_needed: null,
    contact_or_location: null,
    profile_section: null,
    field_key: null,
    source: 'hamilton',
    hamilton_kind: kind,
  }
  if (kind === 'missing_field') {
    base.field_key = need.field_key || null
    base.instructions = `${need.detail || ''}\n\nUse "Go there" to jump straight to the profile field, fill it in, and Hamilton picks it up on his next pass automatically.`.trim()
    base.go_to = { tab: 'profile' }
  } else if (kind === 'missing_document') {
    base.profile_section = 'documents'
    base.instructions = `${need.detail || ''}\n\nUpload the file here (or use "Upload file" on this item) and Hamilton attaches it to the application automatically.`.trim()
    base.go_to = { tab: 'documents' }
  } else if (kind === 'portal_session') {
    base.instructions = `Hamilton can’t get into ${need.host} with a saved password alone (SSO/2FA). Sign in once side-by-side with Hamilton watching — he captures the session and reuses it for every future application on this portal.\n\nUse "Go there" to open the portal area, find ${need.host}, and click its sign-in button.`
    base.contact_or_location = need.host
    base.go_to = { tab: 'pipeline', focus: 'portal-logins' }
  } else if (kind === 'vault') {
    base.instructions = `${need.detail || ''}\n\nUse "Go there" to open the portal area — the vault controls are at the top.`.trim()
    base.go_to = { tab: 'pipeline', focus: 'portal-logins' }
  } else if (need.link_url) {
    // task_blocked with a KNOWN portal/application page: "Go there" must open
    // the ACTUAL destination (the owner report 2026-07-27: the MTSU off-campus
    // housing task's "Go there" dumped the owner on an internal page instead
    // of the portal). The frontend opens link_url side-by-side with Hamilton
    // watching, so anything unlocked there is captured for the application.
    base.link_url = need.link_url
    base.instructions = `${need.detail || ''}\n\n"Go there" opens this application's own portal page side-by-side with Hamilton watching — finish the step it is stuck on and he continues automatically.`.trim()
  } else {
    // task_blocked with no recorded URL, and anything unexpected → the task
    // details live in the pipeline/portal area alongside the Hamilton panel.
    base.go_to = { tab: 'pipeline', focus: 'portal-logins' }
  }
  return base
}

/**
 * Map Hamilton's live needs onto a Profile Action Plan category. Returned
 * FRESH on every read (never persisted) so the checklist always reflects what
 * Hamilton is blocked on RIGHT NOW; items disappear on their own once the
 * underlying need is resolved. Item titles are stable (field labels / hosts),
 * so the plan's category::title completion keys still apply.
 *
 * @returns {Promise<object|null>} category or null when Hamilton needs nothing.
 */
export async function buildHamiltonTodoCategory(db, profileId) {
  let summary = null
  try { summary = await buildHamiltonProfileSummary(db, profileId) } catch { return null }
  const needs = summary?.needs_you || []
  if (needs.length === 0) return null

  // The action plan reads better with each need listed once — task_blocked
  // rows often duplicate a missing_field/portal_session need for the same
  // task, so fold exact-duplicate titles.
  const seen = new Set()
  const items = []
  for (const need of needs) {
    const item = todoItemFromNeed(need)
    const key = item.title.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  if (items.length === 0) return null

  return {
    name: 'Hamilton needs (application agent)',
    icon: 'target',
    source: 'hamilton',
    live: true,
    description: 'Live list from Hamilton: profile facts and documents his applications are missing, plus portals that need you to sign in once with him watching.',
    items,
  }
}

export default { buildHamiltonProfileSummary, buildHamiltonTodoCategory }
