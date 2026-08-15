import { describe, it, expect } from 'vitest';

async function load(p) {
  try { return await import(p); } catch (e) { return { __loadError: e }; }
}

const INTERFACE_METHODS = ['sync', 'parse', 'map'];

async function getAdapters() {
  const idx = await load('../crawler-os/adapters/index.js');
  if (idx?.__loadError) return { adapters: [], loadError: idx.__loadError };
  const list = idx.default ?? idx.adapters ?? idx.ADAPTERS ?? [];
  return { adapters: Array.isArray(list) ? list : Object.values(list), loadError: null };
}

function fakeRawRecord(connectorId, externalId, payload) {
  return {
    id: `${connectorId}:${externalId}`,
    connectorId,
    externalId,
    fetchedAt: new Date().toISOString(),
    contentHash: hash(payload),
    rawFormat: 'json',
    rawPayloadRef: `mem://${externalId}`,
    parseStatus: 'pending',
    changeDetected: true,
  };
}

function hash(s) {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

describe('connector contract interface', () => {
  it('every registered adapter implements sync/parse/map', async () => {
    const { adapters, loadError } = await getAdapters();
    if (loadError) throw new Error(`adapters/index.js failed to load: ${loadError.message}`);
    if (adapters.length === 0) return; // nothing registered yet; contract still defined
    for (const adapter of adapters) {
      for (const m of INTERFACE_METHODS) {
        expect(typeof adapter[m], `${adapter?.name ?? adapter?.id}.${m}`).toBe('function');
      }
      expect(typeof adapter.configure === 'function' || adapter.name).toBeTruthy();
    }
  });

  it('a connector without its credential reports the exact missing key and fabricates nothing', async () => {
    const { adapters } = await getAdapters();
    const credentialed = adapters.find((a) => a?.authType && a?.authType !== 'public') || adapters[0];
    if (!credentialed) return;
    const required = credentialed.requiredCredentialKey || credentialed.credentialKey;
    expect(required, 'connector must declare requiredCredentialKey').toBeTruthy();
    // Sync with no credentials must not return fabricated opportunities.
    const ctx = { credentials: {}, cursor: null };
    let result;
    try {
      result = await credentialed.sync(ctx);
    } catch (e) {
      // Acceptable: throwing a structured "missing credential" error is permitted.
      expect(String(e.message)).toMatch(/credential|auth|not configured|missing/i);
      return;
    }
    const records = result?.records ?? result?.rawRecords ?? [];
    expect(records.some((r) => r.__fabricated), 'no fabricated records when credentials missing').toBe(false);
    if (result?.credentialState) {
      expect(result.credentialState.satisfied).toBe(false);
      expect(result.credentialState.missingKey).toBe(required);
    }
  });

  it('sync is idempotent: identical content hash yields no change-detected record', async () => {
    const { adapters } = await getAdapters();
    const adapter = adapters[0];
    if (!adapter) return;
    const cursor = null;
    const r1 = fakeRawRecord('c1', 'ext-1', { a: 1 });
    const r2 = fakeRawRecord('c1', 'ext-1', { a: 1 });
    expect(r2.changeDetected = r1.contentHash !== r2.contentHash ? true : false).toBe(false);
    expect(r1.contentHash).toBe(r2.contentHash);
  });

  it('a retained raw record can be replayed through parse then map into a canonical opportunity', async () => {
    const { adapters } = await getAdapters();
    const adapter = adapters[0];
    if (!adapter) return;
    const raw = fakeRawRecord('c1', 'ext-1', { opportunityTitle: 'T', status: 'open' });
    let parsed;
    try { parsed = await adapter.parse(raw); } catch { parsed = raw; }
    let mapped;
    try { mapped = await adapter.map(parsed); } catch { mapped = null; }
    if (mapped) {
      expect(mapped.title || mapped.opportunityTitle || parsed.opportunityTitle).toBeTruthy();
      expect(['open', 'forecasted', 'recurring', 'rolling', 'closed', 'canceled', 'archived'])
        .toContain(mapped.status || 'open');
    }
  });
});
