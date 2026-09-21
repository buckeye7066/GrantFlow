// Operational labels describe profile management, never a funding topic.
const RESERVED_PROFILE_TAGS = new Set([
  'designated', 'source-safe', 'source safe', 'source', 'safe', 'synthetic',
  'test', 'demo', 'organization', 'individual', 'profile', 'active',
  'amy', 'amy crawler training', 'allow sam cleanup',
])

export function isBookkeepingInterest(value) {
  const term = String(value ?? '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return RESERVED_PROFILE_TAGS.has(term) || /^amy (?:run|scenario)\s*:/.test(term)
}
