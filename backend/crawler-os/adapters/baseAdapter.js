// crawler-os/adapters/baseAdapter.js
//
// ONE adapter contract. An adapter is the thin, source-specific glue between a
// registry row and the generic pipeline. It does THREE things and nothing more:
//
//   1. missingEnv(env)            -> which required env keys are absent (honest skip)
//   2. buildRequests(thesis,src,env) -> [{ url, init?, parseCfg }]  (what to fetch + how to parse)
//   3. mapCandidate(raw,ctx)      -> a candidate object (or null) for the reality gate
//
// Everything else — fetching (SSRF-safe), parsing dispatch, the reality gate,
// normalization, storage, matching — lives in the shared pipeline. Adding a new
// real source is: add a registry row + a createBaseAdapter({...}) config. There
// is intentionally NO bespoke per-source crawler logic anywhere else.
//
// Pure, no I/O.

/**
 * createBaseAdapter — build an adapter from a declarative config.
 *
 * @param {object} cfg
 * @param {string} cfg.source_id
 * @param {'api'|'directory'|'html'|'pdf'} cfg.family
 * @param {string[]} [cfg.requiredEnv]
 * @param {(thesis:object, source:object, env:object)=>Array<{url:string, init?:object, parseCfg?:object}>} cfg.buildRequests
 * @param {(raw:object, ctx:{thesis:object, source:object})=>object|null} cfg.mapCandidate
 * @param {(resp:object, req:object)=>boolean} [cfg.benignFetchFailure] declare a
 *   specific non-ok response as an honest END OF DATA (e.g. ProPublica 404s on
 *   page overrun) so the pipeline treats it as a clean empty page, never a
 *   FETCH_ERROR. Optional; default = every failure is a real failure.
 * @returns {{ source_id:string, family:string, missingEnv:Function, buildRequests:Function, mapCandidate:Function, benignFetchFailure?:Function }}
 */
export function createBaseAdapter(cfg) {
  if (!cfg || !cfg.source_id) throw new Error('createBaseAdapter: source_id required');
  if (typeof cfg.buildRequests !== 'function') throw new Error('createBaseAdapter: buildRequests required');
  if (typeof cfg.mapCandidate !== 'function') throw new Error('createBaseAdapter: mapCandidate required');
  const requiredEnv = Array.isArray(cfg.requiredEnv) ? cfg.requiredEnv : [];

  return {
    source_id: cfg.source_id,
    family: cfg.family ?? 'api',
    ...(typeof cfg.benignFetchFailure === 'function'
      ? { benignFetchFailure: cfg.benignFetchFailure }
      : {}),
    /** Return the subset of required env keys that are missing/empty. */
    missingEnv(env = {}) {
      return requiredEnv.filter((k) => {
        const v = env?.[k];
        return v == null || String(v).trim() === '';
      });
    },
    buildRequests(thesis = {}, source = {}, env = {}) {
      const reqs = cfg.buildRequests(thesis, source, env) ?? [];
      // Stamp the parse family onto each request so the pipeline stays generic.
      return reqs.map((r) => ({ family: cfg.family ?? 'api', ...r }));
    },
    mapCandidate(raw, ctx = {}) {
      const c = cfg.mapCandidate(raw, ctx);
      if (!c) return null;
      // Guarantee source_id is present so dedup/evidence keys are stable.
      return { source_id: cfg.source_id, ...c };
    },
  };
}

export default { createBaseAdapter };
