function coerceId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'object') {
    const candidateKeys = ['id', 'grant_id', 'grantId', 'uuid'];
    for (const key of candidateKeys) {
      if (key in value) {
        const resolved = coerceId(value[key]);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

async function resolveByFields(entityApi, candidates) {
  for (const [field, raw] of candidates) {
    const value = coerceId(raw);
    if (!value) continue;
    if (!entityApi?.filter) continue;

    try {
      const results = await entityApi.filter({ [field]: value });
      if (Array.isArray(results) && results.length > 0) {
        return results[0].id ?? results[0].ID ?? null;
      }
    } catch (error) {
      console.warn(`Failed to resolve ${field}=${value}:`, error.message);
    }
  }
  return null;
}

export async function resolveGrantId(sdk, rawGrantId) {
  if (!sdk?.entities?.Grant) throw new Error('Grant entity API unavailable');
  const direct = coerceId(rawGrantId);
  if (direct) return direct;

  const fallbackId = await resolveByFields(sdk.entities.Grant, [
    ['slug', rawGrantId?.slug],
    ['external_id', rawGrantId?.external_id],
    ['reference_code', rawGrantId?.reference_code]
  ]);

  if (fallbackId) return fallbackId;
  throw new Error('Unable to resolve grant identifier');
}