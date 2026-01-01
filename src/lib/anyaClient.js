import { apiFetch } from "@/api/client"

export async function getAnyaSessions({ limit } = {}) {
  const searchParams = new URLSearchParams()
  if (limit != null) {
    searchParams.set("limit", String(limit))
  }
  const query = searchParams.toString()
  const response = await apiFetch(`/api/anya/sessions${query ? `?${query}` : ""}`)
  return response?.sessions || []
}

export async function createAnyaSession({ profileId, title, metadata } = {}) {
  const payload = {}
  if (profileId) payload.profile_id = profileId
  if (title) payload.title = title
  if (metadata) payload.metadata = metadata
  return apiFetch("/api/anya/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function getAnyaMessages(sessionId, { limit, direction } = {}) {
  if (!sessionId) return []
  const searchParams = new URLSearchParams()
  if (limit != null) searchParams.set("limit", String(limit))
  if (direction) searchParams.set("direction", direction)
  const query = searchParams.toString()
  const response = await apiFetch(
    `/api/anya/sessions/${sessionId}/messages${query ? `?${query}` : ""}`,
  )
  return response?.messages || []
}

export async function postAnyaMessage(sessionId, message) {
  if (!sessionId) {
    throw new Error("Session id required")
  }
  return apiFetch(`/api/anya/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
  })
}

export async function listAnyaTools() {
  const response = await apiFetch("/api/anya/tools")
  return response?.tools || []
}

export async function invokeAnyaTool(toolName, parameters = {}, { sessionId } = {}) {
  if (!toolName) {
    throw new Error("Tool name required")
  }
  return apiFetch(`/api/anya/tools/${encodeURIComponent(toolName)}/invoke`, {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId ?? undefined,
      parameters,
    }),
  })
}

export async function getAnyaTasks(sessionId) {
  if (!sessionId) {
    throw new Error("Session id required")
  }
  const response = await apiFetch(`/api/anya/sessions/${sessionId}/tasks`)
  return response?.tasks || []
}

export async function createAnyaTask(sessionId, payload) {
  if (!sessionId) {
    throw new Error("Session id required")
  }
  return apiFetch(`/api/anya/sessions/${sessionId}/tasks`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function updateAnyaTask(sessionId, taskId, payload) {
  if (!sessionId) {
    throw new Error("Session id required")
  }
  if (!taskId) {
    throw new Error("Task id required")
  }
  return apiFetch(`/api/anya/sessions/${sessionId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  })
}

export async function getAnyaProfileTasks(profileId, { status = "active" } = {}) {
  if (!profileId) {
    throw new Error("Profile id required")
  }
  const searchParams = new URLSearchParams()
  if (status) {
    searchParams.set("status", status)
  }
  const query = searchParams.toString()
  const response = await apiFetch(
    `/api/anya/profiles/${encodeURIComponent(profileId)}/tasks${query ? `?${query}` : ""}`,
  )
  return response?.tasks || []
}
