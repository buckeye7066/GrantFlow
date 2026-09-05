/**
 * needsPlanAutoSearch.js — ROBERT SEARCHES THE PROFILE'S KNOWN ITEM NEEDS
 * WITHOUT BEING ASKED (owner directive 2026-09-05).
 *
 * "For the specific item finder … there should be a prepopulated list of items
 * that are known needs for the profile and Robert should already be able to
 * start searching for funding sources for those items automatically. A
 * nonprofit needing a 15-passenger van; an army vet in West Virginia wanting to
 * start a food truck needs licenses, a truck, product, etc."
 *
 * The LIST is `orgNeedsTaxonomy.deriveOrgNeeds` (profile-type blueprints plus
 * the venture / program-vehicle conditionals added the same day); the SEARCH is
 * `itemNeedSearch.searchItemNeeds` — the one two-lane engine the item scanner
 * and the needs-plan route already use, so nothing here invents a second
 * relevance authority. This module only decides WHEN to run it (after every
 * live crawl of a real profile) and WHERE the answer lives afterwards
 * (`system_kv needs_plan_auto_search:<profileId>`), so the owner opens the
 * needs plan and finds funding sources already found.
 *
 * Bounded (`NEEDS_PLAN_AUTO_SEARCH_MAX_NEEDS` per run, a time budget) and
 * best-effort: a search-provider outage is RECORDED as such (`search_backends`),
 * never presented as "nothing exists". Never throws into the crawl.
 */
import { deriveOrgNeeds } from './orgNeedsTaxonomy.js'
import { searchItemNeeds, ITEM_SEARCH_MAX_ITEMS } from '../itemNeedSearch.js'

export const NEEDS_PLAN_AUTO_SEARCH_KEY_PREFIX = 'needs_plan_auto_search:'
export const NEEDS_PLAN_AUTO_SEARCH_MAX_NEEDS = Math.max(1, Number(process.env.NEEDS_PLAN_AUTO_SEARCH_MAX_NEEDS) || ITEM_SEARCH_MAX_ITEMS)
export const NEEDS_PLAN_AUTO_SEARCH_TIME_BUDGET_MS = Math.max(5000, Number(process.env.NEEDS_PLAN_AUTO_SEARCH_TIME_BUDGET_MS) || 90000)

function changesOf(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0) || 0
}

async function kvSet(db, key, value) {
  const now = new Date().toISOString()
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
  const updated = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(stringValue, now, key)
  if (!changesOf(updated)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, stringValue, now)
  }
}

async function kvGet(db, key) {
  const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key)
  return row?.value ?? null
}

export function needsPlanAutoSearchKey(profileId) {
  return `${NEEDS_PLAN_AUTO_SEARCH_KEY_PREFIX}${String(profileId ?? '').trim()}`
}

/** The last automatic search for a profile, or null when none has run. */
export async function readNeedsPlanAutoSearch(db, profileId) {
  if (!db || !profileId) return null
  try {
    const raw = await kvGet(db, needsPlanAutoSearchKey(profileId))
    if (!raw) return null
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The needs the automatic search will run, in plan order: OPEN blueprint needs
 * first (the prepopulated list), then the owner's own typed items. Deduped by
 * search subject so one subject is never searched twice in a run.
 */
export function selectAutoSearchNeeds(plan, { maxNeeds = NEEDS_PLAN_AUTO_SEARCH_MAX_NEEDS } = {}) {
  const bySubject = new Map()
  for (const entry of [
    ...(plan?.open ?? []).map((need) => ({ code: need.code, label: need.label, subject: need.search_subject, source: need.source })),
    ...(plan?.user_added ?? []).map((need) => ({ code: null, label: need.label, subject: need.search_subject, source: 'user_added' })),
  ]) {
    const key = String(entry.subject ?? '').trim().toLowerCase()
    if (!key || bySubject.has(key)) continue
    bySubject.set(key, entry)
  }
  const all = [...bySubject.values()]
  return { selected: all.slice(0, maxNeeds), remaining: Math.max(0, all.length - maxNeeds), total: all.length }
}

/**
 * Derive the profile's needs plan and search every open need, then persist the
 * result. Returns the persisted record. `searchFn` is injectable for tests.
 */
export async function runNeedsPlanAutoSearch(db, {
  profileId,
  profileContext,
  searchFn = searchItemNeeds,
  maxNeeds = NEEDS_PLAN_AUTO_SEARCH_MAX_NEEDS,
  timeBudgetMs = NEEDS_PLAN_AUTO_SEARCH_TIME_BUDGET_MS,
  trigger = 'post_crawl',
  now = () => Date.now(),
} = {}) {
  const startedAt = now()
  const profile = profileContext?.profile ?? {}
  const sections = profileContext?.sections ?? {}
  const plan = deriveOrgNeeds({ profile, sections })
  const { selected, remaining, total } = selectAutoSearchNeeds(plan, { maxNeeds })
  const record = {
    profile_id: String(profileId),
    trigger,
    generated_at: new Date(startedAt).toISOString(),
    taxonomy_version: plan.taxonomy_version,
    blueprint: plan.blueprint,
    plan_open_count: plan.open.length,
    plan_user_added_count: plan.user_added.length,
    searched_count: 0,
    remaining,
    total_needs: total,
    searched_needs: [],
    items: [],
    search_backends: null,
    note: null,
    duration_ms: 0,
  }
  if (selected.length === 0) {
    record.note = plan.blueprint?.source === 'not_an_organization'
      ? 'This profile declares no organization type and no venture, so it has no prepopulated needs plan; person-shaped item needs run through the item scanner.'
      : (total === 0 ? 'Every need in this plan is either already held or not applicable. Nothing to search.' : 'No searchable need selected.')
    record.duration_ms = now() - startedAt
    await kvSet(db, needsPlanAutoSearchKey(profileId), record)
    return record
  }
  const remainingBudget = () => Math.max(1000, timeBudgetMs - (now() - startedAt))
  let report
  try {
    report = await searchFn(db, {
      profileId,
      items: selected.map((w) => ({ item: w.subject, code: w.code })),
      blueprintKey: plan.blueprint?.key ?? null,
      profileContext,
      variant: 'funding',
      timeoutMs: Math.min(12000, remainingBudget()),
    })
  } catch (error) {
    record.note = `search failed: ${error?.message || error}`
    record.duration_ms = now() - startedAt
    await kvSet(db, needsPlanAutoSearchKey(profileId), record)
    return record
  }
  record.searched_count = selected.length
  record.searched_needs = selected.map((w) => ({ code: w.code, label: w.label, subject: w.subject, source: w.source }))
  record.items = Array.isArray(report?.items) ? report.items : []
  record.search_backends = report?.search_backends ?? report?.searchMeta ?? null
  record.result_counts = {
    catalog: record.items.filter((i) => i?.lane === 'catalog' || i?.source_lane === 'catalog').length,
    web: record.items.filter((i) => i?.lane === 'web' || i?.source_lane === 'web').length,
    total: record.items.length,
  }
  if (record.items.length === 0) record.note = 'Searched every selected need and found nothing that states funding for it; the plan stays listed so the next crawl re-searches it.'
  record.duration_ms = now() - startedAt
  await kvSet(db, needsPlanAutoSearchKey(profileId), record)
  return record
}
