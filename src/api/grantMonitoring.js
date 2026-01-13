import { apiFetch } from "@/api/client"

export async function listGrantMonitoringAlerts(params = {}) {
  const search = new URLSearchParams()
  if (params.organization_id) search.set("organization_id", params.organization_id)
  const query = search.toString()
  return apiFetch(`/api/grant-monitoring/alerts${query ? `?${query}` : ""}`)
}

export async function listGrantMonitoringLogs(params = {}) {
  const search = new URLSearchParams()
  if (params.organization_id) search.set("organization_id", params.organization_id)
  if (params.limit) search.set("limit", String(params.limit))
  const query = search.toString()
  return apiFetch(`/api/grant-monitoring/logs${query ? `?${query}` : ""}`)
}

export async function checkGrantAlerts(payload = {}) {
  return apiFetch("/api/grant-monitoring/check", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function acknowledgeMonitoringEvent(eventId) {
  return apiFetch(`/api/grant-monitoring/logs/${eventId}`, {
    method: "PUT",
    body: JSON.stringify({ acknowledged: true, acknowledged_at: new Date().toISOString() }),
  })
}

