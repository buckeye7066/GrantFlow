// crawler-os/coverageMatrix.js
//
// The need-category × US-state COVERAGE MATRIX over the source registry —
// the structural totality guard behind the owner directive: "no source can
// serve a TN disability profile" must be a TEST FAILURE, not a user discovery.
// (The class that hid the ECF CHOICES gap: the legacy ECF crawler was never
// registered in the OS, so after the cutover a TN disability profile was
// structurally uncrawlable and nothing failed until a real member noticed.)
//
// Semantics (mirrors planner.js servesNeed/servesGeo):
//   - a NATIONAL source ({ geography: { national: true } }) serves EVERY state
//   - a state-scoped source serves exactly its geography.states
//   - a '*' need wildcard serves EVERY need category
//   - dedicatedOnly: ignore '*' wildcards — "which sources DECLARE this need?"
//     This is the honest bar for the critical-need guard: grants.gov's '*'
//     technically "covers disability" for an org, but a disabled individual in
//     TN is not served by an institutional NOFO feed. A dedicated national
//     lane (ssa_disability, state_hcbs_waivers, …) is what actually serves.
//
// Pure data + pure functions. No I/O. Consumed by:
//   - backend/crawler-os/tests/coverageMatrix.test.mjs  (the guard test)
//   - backend/services/coverageGapScoreboard.js         (structural_matrix
//     scoreboard section → Amy's adapter wishlist, fleet-independent)

import { allSources } from './sourceRegistry.js';

/**
 * The 50 US states + DC — the geography axis of the matrix. Territories
 * (PR/GU/VI/AS/MP) and Canadian provinces are deliberately NOT on the guard
 * axis: national sources serve them too, but the registry has no
 * territory-scoped lanes yet and putting them on the axis would only pad the
 * documented-gaps list without a serviceable adapter backlog behind it.
 */
export const US_STATES = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
]);

/**
 * CRITICAL NEEDS — the person/org needs that must NEVER be state-orphaned.
 * A cell (critical need × any US state) with zero DEDICATED sources is a
 * guard-test failure, full stop — never a documented-gaps entry.
 *
 * Slugs are the registry's OWN need vocabulary (see the need_categories
 * values in sourceRegistry.js), not invented labels. The owner's list maps:
 *   housing             → 'housing'
 *   food                → 'food'
 *   medical/healthcare  → 'medical' + 'healthcare' (both slugs are live in the
 *                         registry; tn_ecf_choices/state_hcbs_waivers carry
 *                         'healthcare', the other 22 medical lanes 'medical')
 *   disability          → 'disability'
 *   utilities           → 'energy' + 'utility' (the registry's two
 *                         utility-assistance slugs — LIHEAP is 'energy',
 *                         211's utility-bill lane is 'utility')
 *   employment          → 'employment'
 *   education           → 'education'
 */
export const CRITICAL_NEEDS = Object.freeze([
  'housing',
  'food',
  'medical',
  'healthcare',
  'disability',
  'energy',
  'utility',
  'employment',
  'education',
]);

/**
 * DOCUMENTED GAPS — the accepted-for-now uncovered NON-critical cells
 * (dedicated-coverage tier). This is the adapter-wishlist backlog, NOT a list
 * of gaps accepted forever: every entry needs a per-entry comment saying what
 * closing it takes, and the guard test fails when an entry here is actually
 * covered (prune it) or when a real gap is missing from here (fix or document).
 *
 * Entry shape: { need: '<registry need slug>', state: '<2-letter US state>',
 *               reason: '<why this is open + what closes it>' }
 *
 * EMPTY as of 2026-07-07: every registry need category has at least one
 * NATIONAL dedicated source, so no (need × state) cell is uncovered. New
 * entries appear here only when a state-scoped-only need lands in the
 * registry — add the missing states' cells with a reason, or better, add a
 * national fallback source for the need.
 */
export const DOCUMENTED_GAPS = Object.freeze([]);

/** Canonical cell key: `${need}|${state}` (needs never contain '|'). */
export function cellKey(need, state) {
  return `${need}|${state}`;
}

/** The registry's concrete need vocabulary ('*' wildcard excluded), sorted. */
export function needVocabulary({ sources = allSources() } = {}) {
  const needs = new Set();
  for (const s of sources) {
    for (const n of Array.isArray(s?.need_categories) ? s.need_categories : []) {
      if (n && n !== '*') needs.add(n);
    }
  }
  return [...needs].sort();
}

function sourceCoversNeed(source, need, dedicatedOnly) {
  const cats = Array.isArray(source?.need_categories) ? source.need_categories : [];
  if (!dedicatedOnly && cats.includes('*')) return true;
  return cats.includes(need);
}

function sourceServesState(source, state) {
  const geo = source?.geography || {};
  if (geo.national) return true;
  return (Array.isArray(geo.states) ? geo.states : []).includes(state);
}

/**
 * Build the full coverage matrix: for every (need_category × US state) cell,
 * the source_ids that can serve it.
 *
 * @param {object} [opts]
 * @param {Array}   [opts.sources]       source rows (default: live registry incl. Amy's additive overrides)
 * @param {string[]} [opts.needs]        need axis (default: the registry's own vocabulary)
 * @param {string[]} [opts.states]       state axis (default: US_STATES)
 * @param {boolean} [opts.dedicatedOnly] ignore '*' need wildcards (default false)
 * @returns {{ needs:string[], states:string[], dedicated_only:boolean,
 *             cells:Record<string,string[]>,
 *             stats:{ total_cells:number, covered_cells:number, uncovered_cells:number,
 *                     per_need:Record<string,{covered_states:number, uncovered_states:string[]}> } }}
 */
export function buildCoverageMatrix({
  sources = allSources(),
  needs = needVocabulary({ sources }),
  states = US_STATES,
  dedicatedOnly = false,
} = {}) {
  const cells = {};
  const per_need = {};
  let covered = 0;

  for (const need of needs) {
    // Pre-split per need so the inner state loop only geo-checks matching rows.
    const needSources = sources.filter((s) => sourceCoversNeed(s, need, dedicatedOnly));
    const uncovered_states = [];
    for (const state of states) {
      const ids = needSources.filter((s) => sourceServesState(s, state)).map((s) => s.source_id);
      cells[cellKey(need, state)] = ids;
      if (ids.length > 0) covered += 1;
      else uncovered_states.push(state);
    }
    per_need[need] = { covered_states: states.length - uncovered_states.length, uncovered_states };
  }

  const total = needs.length * states.length;
  return {
    needs: [...needs],
    states: [...states],
    dedicated_only: dedicatedOnly,
    cells,
    stats: { total_cells: total, covered_cells: covered, uncovered_cells: total - covered, per_need },
  };
}

/**
 * List the uncovered (need × state) cells, optionally restricted to a subset
 * of needs/states.
 *
 * @param {object} [opts]  same options as buildCoverageMatrix
 * @returns {Array<{need:string, state:string}>}
 */
export function listUncoveredCells({ needs, states, sources, dedicatedOnly = false } = {}) {
  const matrix = buildCoverageMatrix({
    ...(sources ? { sources } : {}),
    ...(needs ? { needs } : {}),
    ...(states ? { states } : {}),
    dedicatedOnly,
  });
  const out = [];
  for (const need of matrix.needs) {
    for (const state of matrix.stats.per_need[need].uncovered_states) {
      out.push({ need, state });
    }
  }
  return out;
}

export default {
  US_STATES,
  CRITICAL_NEEDS,
  DOCUMENTED_GAPS,
  cellKey,
  needVocabulary,
  buildCoverageMatrix,
  listUncoveredCells,
};
