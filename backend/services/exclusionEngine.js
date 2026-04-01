export function evaluateExclusion(opportunity, rules) {
  const text = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase()

  for (const rule of (rules || [])) {
    const regex = new RegExp(rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    if (!regex.test(text)) continue

    return {
      decision: rule.action === 'auto_suppress' ? 'SUPPRESS' : 'WATCH',
      rule_id: rule.rule_id,
    }
  }

  return { decision: 'ALLOW' }
}
