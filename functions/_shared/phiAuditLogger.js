function buildAuditPayload(event = {}) {
  const {
    action = 'access',
    entity = 'unknown',
    entity_id = null,
    function_name = 'unspecified',
    metadata = {}
  } = event;

  return {
    action,
    entity,
    entity_id,
    function_name,
    metadata,
    occurred_at: new Date().toISOString()
  };
}

export async function logPHIAccess(sdk, event) {
  if (!sdk?.entities) return;

  const payload = buildAuditPayload(event);
  const targets = [
    ['PHIAuditLog', { severity: 'information' }],
    ['AuditLog', { category: 'phi' }]
  ];

  for (const [entityName, defaults] of targets) {
    const entity = sdk.entities[entityName];
    if (!entity?.create) continue;

    try {
      await entity.create({ ...defaults, ...payload });
      return;
    } catch (error) {
      console.warn(`Failed to log PHI access to ${entityName}:`, error.message);
    }
  }

  console.warn('PHI audit entity not available. Event:', payload);
}