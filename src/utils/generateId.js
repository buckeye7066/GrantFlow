// Single client-side id generator for locally-minted entity ids (university
// applications, contacts, stages, target-college sync rows). Prefer
// crypto.randomUUID; the fallback includes a timestamp so ids minted in the
// same millisecond-scale burst still differ by more than Math.random alone.
export function generateId(prefix = "item") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
