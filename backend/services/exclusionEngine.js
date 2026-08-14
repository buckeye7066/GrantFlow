export function evaluateExclusion(opportunity, rules) {
  const text = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase()

  for (const rule of (rules || [])) {
    if (!rule.pattern) {
  console.warn(`[exclusionEngine] Rule ${rule.rule_id} has no pattern — skipping`)
  continue
}
let regex
try {
  regex = new RegExp(rule.pattern, 'i')
} catch (e) {
  console.warn(`[exclusionEngine] Invalid pattern in rule ${rule.rule_id}: ${e.message}`)
  continue
}
    if (!regex.test(text)) continue

    return {
      decision: rule.action === 'auto_suppress' ? 'SUPPRESS' : 'WATCH',
      rule_id: rule.rule_id,
    }
  }

  return { decision: 'ALLOW' }
}
