// Fields whose values are explicit requests. Narrative, contacts and inferred
// profile tags are deliberately excluded. Discovery and matching share this list.
export const DECLARED_NEED_FIELDS = Object.freeze([
  'needs', 'need_categories', 'primary_needs', 'support_needs', 'funding_needs',
  'item_needs', 'assistance_types', 'assistance_needs',
])
