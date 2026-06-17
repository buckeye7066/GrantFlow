import { apiFetch } from '@/api/client'

export const profileReadinessApi = {
  basic: (profileId) => apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/readiness`),
  detailed: (profileId) => apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/readiness/detailed`),
}

export default profileReadinessApi
