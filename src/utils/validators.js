// src/utils/validators.js
//
// Shared, app-wide field validators. Forms were validating ad-hoc (some had email
// format checks, others none), so contact fields like phone slipped through. Route
// format checks through here so every form enforces the same rules.

/**
 * Valid email (mirrors the backend regex in backend/utils/validation.js).
 * Empty/missing is considered NOT valid here — callers that allow empty should
 * short-circuit on empty before calling (or use the zod `.or(z.literal(''))` form).
 */
export function isValidEmail(value) {
  if (!value || typeof value !== 'string') return false
  const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  return re.test(value.trim())
}

/**
 * Lenient phone validator: accepts common US / international formats —
 * +1 (234) 567-8900, 234-567-8900, 2345678900, +442071234567, etc. Strips spaces,
 * dashes, dots, parens, and a leading +, then requires 7–15 digits (E.164 range).
 */
export function isValidPhone(value) {
  if (!value || typeof value !== 'string') return false
  const digits = value.replace(/[\s().+-]/g, '')
  return /^\d{7,15}$/.test(digits)
}

export default { isValidEmail, isValidPhone }
