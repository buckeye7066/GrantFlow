import { ensureBillingAccount, mapAccountRow } from '../services/billingAccounts.js'

export const TIER_CAPABILITIES = Object.freeze({
  PIPELINE_AUTOMATION: 'enable_pipeline_automation',
  ITEM_FUNDING: 'enable_item_funding',
  DOCUMENT_AI: 'enable_document_ai',
})

export async function getProfileBillingAccount(db, profileId) {
  if (!profileId) return null
  const row = await ensureBillingAccount(db, profileId)
  return mapAccountRow(row)
}

export async function requireTierCapability(req, res, profileId, capabilityKey) {
  if (req.ctx?.isAdmin) return true

  const billing = await getProfileBillingAccount(req.db, profileId)
  const allowed = Boolean(billing?.tier?.[capabilityKey])
  if (allowed) return true

  res.status(403).json({
    error: 'Tier upgrade required',
    capability: capabilityKey,
    message:
      'Your current billing tier does not include this feature. Please contact the GrantFlow team to adjust your tier.',
  })
  return false
}

