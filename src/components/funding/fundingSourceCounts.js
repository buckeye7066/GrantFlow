/**
 * Count direct opportunities and directory/referral resources independently.
 * Supports the new API's `resource_count` and the older `directories` array so
 * a rolling frontend/backend deployment cannot hide resource-only results.
 */
export function fundingSourceCounts(data) {
  const direct = Number(data?.total) || 0
  const resources = Number(data?.resource_count ?? data?.directories?.length) || 0
  return { direct, resources, any: direct + resources > 0 }
}

export default fundingSourceCounts
