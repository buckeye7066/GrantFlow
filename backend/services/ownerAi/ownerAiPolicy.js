// Owner-authorized order: subscription, configured paid APIs, free/local models.
// A deployment can still explicitly disable metered fallback.
export const OWNER_AI_POLICY_ENV_KEYS = Object.freeze({ PAID_FALLBACK: 'OWNER_AI_ALLOW_PAID_FALLBACK' })
export function ownerPaidFallbackAllowed(env = process.env) {
  const configured = env[OWNER_AI_POLICY_ENV_KEYS.PAID_FALLBACK]
  return configured === undefined || configured === '' || configured === 'true'
}
