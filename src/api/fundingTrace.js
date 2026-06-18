import { apiFetch } from "@/api/client"

/**
 * Trace where an entity gets its funding.
 * @param {string} entity      free-text company / public entity / individual
 * @param {string} entityType  'company' | 'public_entity' | 'individual'
 * @param {boolean} useAi      include AI-synthesized funding channels
 */
export async function traceFunding(entity, { entityType = "company", useAi = true } = {}) {
  return apiFetch("/api/admin/funding-trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity, entity_type: entityType, use_ai: useAi }),
  })
}

/** Add a single traced funding source to the GrantFlow catalog. */
export async function addTracedSource(source, entity) {
  return apiFetch("/api/admin/funding-trace/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, entity }),
  })
}
