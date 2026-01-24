export function canUseFeature(billing, capabilityKey) {
  if (!capabilityKey) return false
  const tier = billing?.tier ?? null
  if (!tier) return false
  return Boolean(tier?.[capabilityKey])
}

