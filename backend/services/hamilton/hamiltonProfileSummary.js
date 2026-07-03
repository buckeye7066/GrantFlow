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
  listMissingInfo,
  TASK_BLOCKED_STATUSES,
  TASK_TERMINAL_STATUSES,
} from './applicationTaskStore.js'
import { getHamiltonReadiness } from './hamiltonScheduleService.js'
import { getMasterVaultStatus } from './hamiltonPortalMasterVault.js'

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

// Best-effort, batched title resolution from the grants / funding_opportunities
// tables so tasks read as real funding-source names instead of raw ids. Missing
// tables or rows simply leave the fallback (humanized automation type) in place.
async function resolveTaskTitles(db, tasks, profileId) {
  const map = new Map()
  const grantIds = [...new Set((tasks || []).map((t) => t.grant_id).filter(Boolean).map(String))]
  const oppIds = [...new Set((tasks || []).map((t) => t.opportunity_id).filter(Boolean).map(String))]
  if (grantIds.length && profileId) {
    try {
      const ph = grantIds.map(() => '?').join(',')
      const rows = await db
        .prepare(`SELECT id, title FROM grants WHERE profile_id = ? AND id IN (${ph})`)
        .all(String(profileId), ...grantIds)
      for (const r of rows || []) if (r?.title) map.set(`grant:${r.id}`, r.title)
    } catch { /* table/shape mismatch — keep fallbacks */ }
  }
  if (oppIds.length) {
    try {
      const ph = oppIds.map(() => '?').join(',')
      const rows = await db.prepare(`SELECT id, title FROM funding_opportunities WHERE id IN (${ph})`).all(...oppIds)
      for (const r of rows || []) if (r?.title) map.set(`opp:${r.id}`, r.title)
    } catch { /* table/shape mismatch — keep fallbacks */ }
  }
  return map
}

function taskTitleFromMap(task, titleMap) {
  return (
    (task.grant_id && titleMap.get(`grant:${task.grant_id}`)) ||
    (task.opportunity_id && titleMap.get(`opp:${task.opportunity_id}`)) ||
    humanizeAutomationType(task.automation_type)
  )
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
  const titleMap = await resolveTaskTitles(db, tasks, profileId)
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
    let missing = []
    try { missing = await listMissingInfo(db, t.id, { includeResolved: false }) } catch { missing = [] }
    for (const m of missing || []) {
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
  } else {
    // task_blocked and anything unexpected → the task details live in the
    // pipeline/portal area alongside the Hamilton work panel.
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
