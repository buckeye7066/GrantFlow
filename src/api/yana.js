import { apiFetch } from '@/api/apiClient'

// ── Student portals ──────────────────────────────────────────────

export function listStudentPortals(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/student-portals`)
}

export function createStudentPortal(profileId, payload) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/student-portals`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function patchStudentPortal(profileId, portalId, payload) {
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/student-portals/${encodeURIComponent(portalId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload || {}),
  })
}

// ── Funding portal links ─────────────────────────────────────────

export function listFundingPortalLinks(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/funding-portal-links`)
}

export function linkOpportunityPortal(opportunityId, payload) {
  return apiFetch(`/api/opportunities/${encodeURIComponent(opportunityId)}/link-student-portal`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

// ── Application tasks (Yana) ─────────────────────────────────────

export function listApplicationTasks({ profileId = null, status = null } = {}) {
  const params = new URLSearchParams()
  if (profileId) params.set('profile_id', profileId)
  if (status) params.set('status', status)
  const qs = params.toString()
  return apiFetch(`/api/application-tasks${qs ? `?${qs}` : ''}`)
}

export function getApplicationTask(taskId) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}`)
}

export function createApplicationTask({ profileId, opportunityId = null, grantId = null, portalId = null }) {
  return apiFetch(`/api/application-tasks`, {
    method: 'POST',
    body: JSON.stringify({
      profile_id: profileId,
      opportunity_id: opportunityId,
      grant_id: grantId,
      portal_id: portalId,
    }),
  })
}

export function startYana(taskId, opts = {}) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/yana/start`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}

export function continueYana(taskId, opts = {}) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/yana/continue`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}

export function supplyMissingInfo(taskId, items) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/missing-info`, {
    method: 'POST',
    body: JSON.stringify({ items: Array.isArray(items) ? items : [] }),
  })
}

export function approveAutoSubmit(taskId, enable = true) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/approve-submit`, {
    method: 'POST',
    body: JSON.stringify({ enable }),
  })
}

export function cancelApplicationTask(taskId, reason = null) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

// ── Real browser automation (gated by YANA_ENABLE_BROWSER_AUTOMATION) ─

const browserBase = (taskId) => `/api/application-tasks/${encodeURIComponent(taskId)}/yana/browser`

export function getBrowserStatus(taskId) {
  return apiFetch(`${browserBase(taskId)}/status`)
}

export function startBrowser(taskId, { headless = null } = {}) {
  return apiFetch(`${browserBase(taskId)}/start`, {
    method: 'POST',
    body: JSON.stringify(typeof headless === 'boolean' ? { headless } : {}),
  })
}

export function resumeBrowser(taskId) {
  return apiFetch(`${browserBase(taskId)}/resume`, { method: 'POST', body: '{}' })
}

export function userReadyContinue(taskId) {
  return apiFetch(`${browserBase(taskId)}/user-ready`, { method: 'POST', body: '{}' })
}

export function fillBrowser(taskId) {
  return apiFetch(`${browserBase(taskId)}/fill`, { method: 'POST', body: '{}' })
}

export function saveBrowserDraft(taskId) {
  return apiFetch(`${browserBase(taskId)}/save-draft`, { method: 'POST', body: '{}' })
}

export function approveBrowserSubmit(taskId) {
  return apiFetch(`${browserBase(taskId)}/approve-submit`, { method: 'POST', body: '{}' })
}

export function cancelBrowser(taskId, reason = null) {
  return apiFetch(`${browserBase(taskId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export function getBrowserAudit(taskId) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/yana/audit`)
}

export const BROWSER_SESSION_STATUS_LABELS = Object.freeze({
  not_started: 'Not started',
  launching_browser: 'Launching browser…',
  waiting_for_user_login: 'Please log in',
  waiting_for_2fa: 'Please complete 2FA',
  waiting_for_captcha: 'Please solve CAPTCHA',
  inspecting_form: 'Inspecting form',
  mapping_fields: 'Mapping fields',
  filling_fields: 'Filling fields',
  missing_info_required: 'Missing required info',
  waiting_for_user_review: 'Review the draft',
  ready_for_submit: 'Ready to submit',
  submitted: 'Submitted',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
})

export function browserStatusLabel(status) {
  return BROWSER_SESSION_STATUS_LABELS[status] || status || 'Unknown'
}

export const TASK_STATUS_LABELS = Object.freeze({
  queued: 'Queued',
  ready: 'Ready',
  waiting_for_user: 'Needs your input',
  waiting_for_admin: 'Awaiting admin review',
  blocked_login_required: 'Needs school login',
  blocked_missing_info: 'Missing info',
  blocked_2fa: 'Blocked: 2FA',
  blocked_captcha: 'Blocked: CAPTCHA',
  blocked_terms_or_policy: 'Blocked: terms',
  in_progress: 'Yana working',
  draft_completed: 'Draft ready',
  submitted: 'Submitted',
  failed: 'Failed',
  cancelled: 'Cancelled',
})

export const PORTAL_TYPE_LABELS = Object.freeze({
  financial_aid: 'Financial Aid portal',
  scholarship: 'Scholarship portal',
  admissions: 'Admissions portal',
  student_account: 'Student account portal',
  bursar: 'Bursar portal',
  department: 'Department scholarship',
  graduate_school: 'Graduate school portal',
  program_specific: 'Program portal',
  external_application: 'External application',
  manual_or_offline: 'Manual / offline',
})

export function statusLabel(status) {
  return TASK_STATUS_LABELS[status] || status || 'Unknown'
}

export function portalTypeLabel(portalType) {
  return PORTAL_TYPE_LABELS[portalType] || portalType || 'Portal'
}
