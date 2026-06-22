import { apiFetch } from '@/api/client'

// One-time login announcements shown to the user (e.g. "how to merge your portals").
export async function listPendingAnnouncements() {
  return apiFetch('/api/announcements/pending')
}

export async function dismissAnnouncement(id) {
  if (!id) throw new Error('announcement id required')
  return apiFetch(`/api/announcements/${encodeURIComponent(id)}/dismiss`, { method: 'POST' })
}
