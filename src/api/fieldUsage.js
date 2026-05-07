import { apiFetch } from '@/api/client'

/**
 * Mission Goal 11 — Field-to-Funding accountability.
 *
 * Thin wrapper around the /api/field-usage endpoints. Components should
 * use the React-Query hooks below instead of calling these directly so
 * the registry is fetched once per session and shared across the tree.
 */

export async function fetchFieldUsageBundle() {
  const res = await apiFetch('/api/field-usage')
  return res
}

export async function fetchFieldUsageById(id) {
  const safe = String(id || '').trim()
  if (!safe) return null
  const res = await apiFetch(`/api/field-usage/${encodeURIComponent(safe)}`)
  return res?.entry ?? null
}
