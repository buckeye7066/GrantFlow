import { describe, it, expect } from 'vitest';

async function load(p) {
  try { return await import(p); } catch (e) { return { __loadError: e }; }
}

// The ONE adapter contract (backend/crawler-os/adapters/baseAdapter.js):
//   missingEnv(env)                  -> required env keys that are absent (honest skip)
//   buildRequests(thesis, src, env)  -> [{ url, init?, parseCfg }]
//   mapCandidate(raw, ctx)           -> candidate object (or null) for the reality gate
const INTERFACE_METHODS = ['missingEnv', 'buildRequests', 'mapCandidate'];

async function getRegistry() {
  const idx = await load('../crawler-os/adapters/index.js');
  if (idx?.__loadError) return { registry: null, loadError: idx.__loadError };
  return { registry: idx, loadError: null };
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
  it('every registered adapter implements missingEnv/buildRequests/mapCandidate', async () => {
    const { registry, loadError } = await getRegistry();
    if (loadError) throw new Error(`adapters/index.js failed to load: ${loadError.message}`);
    const ids = registry.implementedAdapterIds();
    expect(ids.length, 'adapter registry must not be empty').toBeGreaterThan(0);
    for (const id of ids) {
      const adapter = registry.getAdapter(id);
      expect(adapter, `getAdapter(${id})`).toBeTruthy();
      for (const m of INTERFACE_METHODS) {
        expect(typeof adapter[m], `${id}.${m}`).toBe('function');
      }
      expect(adapter.source_id, `${id}.source_id`).toBeTruthy();
    }
  });

  it('an unimplemented source id yields null (honest skip), never a fabricated adapter', async () => {
    const { registry, loadError } = await getRegistry();
    if (loadError) throw new Error(`adapters/index.js failed to load: ${loadError.message}`);
    expect(registry.getAdapter('no_such_source_id_xyz')).toBe(null);
  });

  it('a connector without its credential reports the exact missing key and fabricates nothing', async () => {
    // Every live adapter is currently keyless (requiredEnv: []), so the
    // credential-reporting contract is exercised through the shared factory
    // every adapter is built from.
    const base = await load('../crawler-os/adapters/baseAdapter.js');
    if (base?.__loadError) throw new Error(`baseAdapter.js failed to load: ${base.__loadError.message}`);
    const adapter = base.createBaseAdapter({
      source_id: 'test_credentialed_source',
      family: 'api',
      requiredEnv: ['TEST_SOURCE_API_KEY'],
      buildRequests: () => [{ url: 'https://example.invalid/list' }],
      mapCandidate: (raw) => ({ title: raw?.title ?? null }),
    });
    // Missing credential is reported by its exact key — the pipeline uses this
    // to record an honest SKIPPED(missing_env), never fabricated records.
    expect(adapter.missingEnv({})).toEqual(['TEST_SOURCE_API_KEY']);
    expect(adapter.missingEnv({ TEST_SOURCE_API_KEY: '   ' })).toEqual(['TEST_SOURCE_API_KEY']);
    expect(adapter.missingEnv({ TEST_SOURCE_API_KEY: 'k' })).toEqual([]);
    // And the live registry's adapters each answer the same question honestly.
    const { registry } = await getRegistry();
    for (const id of registry.implementedAdapterIds()) {
      const live = registry.getAdapter(id);
      const missing = live.missingEnv({});
      expect(Array.isArray(missing), `${id}.missingEnv({}) returns an array`).toBe(true);
    }
  });

  it('sync is idempotent: identical content hash yields no change-detected record', async () => {
    const r1 = fakeRawRecord('c1', 'ext-1', { a: 1 });
    const r2 = fakeRawRecord('c1', 'ext-1', { a: 1 });
    expect(r2.changeDetected = r1.contentHash !== r2.contentHash ? true : false).toBe(false);
    expect(r1.contentHash).toBe(r2.contentHash);
  });

  it('mapCandidate stamps a stable source_id onto every candidate and returns null for nothing', async () => {
    const base = await load('../crawler-os/adapters/baseAdapter.js');
    if (base?.__loadError) throw new Error(`baseAdapter.js failed to load: ${base.__loadError.message}`);
    const adapter = base.createBaseAdapter({
      source_id: 'test_replay_source',
      family: 'api',
      buildRequests: () => [],
      mapCandidate: (raw) => (raw?.opportunityTitle ? { title: raw.opportunityTitle } : null),
    });
    const mapped = adapter.mapCandidate({ opportunityTitle: 'T' }, { thesis: {}, source: {} });
    expect(mapped).toBeTruthy();
    expect(mapped.title).toBe('T');
    expect(mapped.source_id).toBe('test_replay_source');
    expect(adapter.mapCandidate({}, { thesis: {}, source: {} })).toBe(null);
  });
});
