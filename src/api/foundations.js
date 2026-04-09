import { apiFetch } from "@/api/client"

/** Search nonprofits/foundations via ProPublica 990 data */
export async function searchFoundations({ q, state, page = 0, ntee, c_code } = {}) {
  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (state) params.set("state", state)
  if (page) params.set("page", String(page))
  if (ntee) params.set("ntee", ntee)
  if (c_code) params.set("c_code", c_code)
  return apiFetch(`/api/foundations/search?${params}`)
}

/** Get organization detail + 990 filings by EIN */
export async function getFoundation(ein) {
  return apiFetch(`/api/foundations/${ein}`)
}

/** Get specific 990 filing */
export async function getFiling(ein, taxPeriod) {
  return apiFetch(`/api/foundations/${ein}/filing/${taxPeriod}`)
}

/** Search NSF awards */
export async function searchNSF({ keyword, state, program, offset = 1, limit = 25 } = {}) {
  const params = new URLSearchParams()
  if (keyword) params.set("keyword", keyword)
  if (state) params.set("state", state)
  if (program) params.set("program", program)
  if (offset > 1) params.set("offset", String(offset))
  if (limit !== 25) params.set("limit", String(limit))
  return apiFetch(`/api/foundations/nsf/search?${params}`)
}

/** Search CFDA federal assistance listings */
export async function searchFederalPrograms({ keyword, assistanceType, applicantType, page = 1, limit = 25 } = {}) {
  const params = new URLSearchParams()
  if (keyword) params.set("keyword", keyword)
  if (assistanceType) params.set("assistanceType", assistanceType)
  if (applicantType) params.set("applicantType", applicantType)
  if (page > 1) params.set("page", String(page))
  if (limit !== 25) params.set("limit", String(limit))
  return apiFetch(`/api/foundations/federal/search?${params}`)
}

/** Get calendar events (grant deadlines) */
export async function getCalendarDeadlines({ profileId, month } = {}) {
  const params = new URLSearchParams()
  if (profileId) params.set("profileId", profileId)
  if (month) params.set("month", month)
  return apiFetch(`/api/foundations/calendar/deadlines?${params}`)
}
