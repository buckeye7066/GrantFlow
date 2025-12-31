function sanitizeList(items = [], fields = []) {
  return items.map((item) => {
    const sanitized = {};
    fields.forEach((field) => {
      if (item[field] !== undefined && item[field] !== null) {
        sanitized[field] = item[field];
      }
    });
    return sanitized;
  });
}

export function buildReminderPlanPrompt(deadlines = [], milestones = [], context = {}) {
  const payload = {
    deadlines: sanitizeList(deadlines.slice(0, 6), [
      'id',
      'title',
      'funder',
      'organizationName',
      'deadline',
      'status',
      'daysRemaining',
      'opportunityType',
      'amountRequested',
    ]),
    milestones: sanitizeList(milestones.slice(0, 6), [
      'id',
      'title',
      'description',
      'dueDate',
      'type',
      'reminderDays',
      'grantTitle',
      'organizationName',
      'daysRemaining',
    ]),
    additional_context: context?.additionalContext || null,
  };

  return `
You are an operations chief of staff for a grants team. Review the upcoming deadlines and milestones, then produce a concise operations plan for the next 1-2 weeks.

DATA:
${JSON.stringify(payload, null, 2)}

Return ONLY valid JSON with this shape:
{
  "summary": "2-3 sentences that explain the situation and overall focus.",
  "priority_actions": [
    { "title": "...", "due": "YYYY-MM-DD or null", "type": "deadline|milestone|compliance", "notes": "Why it matters and what to do next." }
  ],
  "collaboration": [
    { "title": "...", "owner": "ops|finance|program|executive|client", "notes": "Brief collaboration guidance." }
  ],
  "follow_up": [
    { "title": "...", "notes": "Items to prepare after the priority work is complete." }
  ],
  "ai_recommendations": [
    "Additional tips or reminders (max 3)."
  ]
}

Limit priority_actions to the top 3 items, collaboration and follow_up to the most relevant 3 each. Use concise, actionable language.`;
}
