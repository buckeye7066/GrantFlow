// crawler-os/agents/robert.js
//
// Robert — funding discovery & recommendation. Robert drives the discovery spine
// (pipeline.runDiscovery), builds the funding universe whether or not anyone is
// logged in, and matches every newly stored opportunity against ALL known
// profiles (doctrine: "store unmatched but valid funding for future profiles").
//
// Robert invents nothing: every opportunity is gated by the canonical reality
// gate inside the pipeline, and every decision comes from the canonical match
// engine. Robert only orchestrates and aggregates.

import { buildThesis } from '../profileIntelligence.js';
import { runDiscovery } from '../pipeline.js';
import { heartbeat, recordAgentJob, getMatchesForProfile } from '../storage.js';

const AGENT_ID = 'robert';

/** A broad thesis used when there are no profiles yet: selects all in-scope sources. */
function broadThesis() {
  return {
    profile_id: null,
    applicant_types: ['*'],
    needs: [],
    location: { state: null, county: null, zip: null, city: null },
    loan_allowed: false,
    cost_share_allowed: false,
    is_student: false,
    is_org: false,
    school: null,
    min_match_score: 55,
    keywords: ['grant', 'funding', 'assistance'],
    raw_profile_present: false,
  };
}

export function createRobert(deps = {}) {
  const { store, fetcher, env = {}, clock = () => Date.now() } = deps;
  if (!store || !fetcher) throw new Error('createRobert: store and fetcher required');

  return {
    id: AGENT_ID,

    /**
     * run — one discovery pass.
     * @param {{ profiles?:object[], runId?:string }} [opts] profiles are raw profile objects
     * @returns {Promise<object>} aggregate result
     */
    async run(opts = {}) {
      let profileCount = 0;
      try {
        heartbeat(store, AGENT_ID, { now: clock(), status: 'running' });
        const profiles = opts.profiles ?? [];
        const theses = profiles.map((p) => buildThesis(p));
        profileCount = theses.length;
        const matchProfiles = theses; // match every stored opp to every profile

        const runs = [];
        let storedTotal = 0;
        let recommendedTotal = 0;

        if (theses.length === 0) {
          // No profiles: still build the universe; store globally, match later.
          const r = await runDiscovery({ store, fetcher, env, clock }, { thesis: broadThesis(), matchProfiles: [], runId: opts.runId });
          runs.push(r); storedTotal += r.stored;
        } else {
          for (const th of theses) {
            const r = await runDiscovery({ store, fetcher, env, clock }, { thesis: th, matchProfiles, runId: opts.runId });
            runs.push(r); storedTotal += r.stored; recommendedTotal += r.recommendations.length;
          }
        }

        // Per-profile recommendation rollup (ACCEPT-band only) over the catalog.
        const recommendationsByProfile = {};
        for (const th of theses) {
          if (!th.profile_id) continue;
          recommendationsByProfile[th.profile_id] = getMatchesForProfile(store, th.profile_id, { minScore: th.min_match_score })
            .filter((m) => m.decision === 'accept');
        }

        const summary = {
          agent: AGENT_ID,
          runs: runs.map((r) => ({ run_id: r.run_id, profile_id: r.profile_id, stored: r.stored, rejected: r.rejected, recommendations: r.recommendations.length, zero_result: r.zero_result?.zero_result_reason ?? null })),
          stored_total: storedTotal,
          recommended_total: recommendedTotal,
          recommendations_by_profile: recommendationsByProfile,
        };
        recordAgentJob(store, { agent_id: AGENT_ID, kind: 'discovery', status: 'ok', detail: { stored_total: storedTotal, profiles: theses.length } });
        return summary;
      } catch (error) {
        const message = error?.message || String(error);
        try {
          recordAgentJob(store, { agent_id: AGENT_ID, kind: 'discovery', status: 'error', detail: { error: message, profiles: profileCount } });
        } catch (recordError) {
          console.error('Robert failed to record discovery error:', recordError?.message || recordError);
        }
        throw error;
      } finally {
        try {
          heartbeat(store, AGENT_ID, { now: clock(), status: 'idle' });
        } catch (heartbeatError) {
          console.error('Robert failed to mark heartbeat idle:', heartbeatError?.message || heartbeatError);
        }
      }
    },
  };
}

export default { createRobert };
