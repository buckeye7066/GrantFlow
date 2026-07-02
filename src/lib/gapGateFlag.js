/**
 * gapGateFlag — the ONE source of truth for whether Anya's profile gap
 * interview ("gap gate") is enabled.
 *
 * DEFAULT ON: the interview runs everywhere (login launcher + profile
 * Overview mount) unless the build explicitly opts out with
 * VITE_GAP_GATE_ENABLED=false.
 *
 * History: the gate originally shipped dark (required VITE_GAP_GATE_ENABLED
 * === 'true', which was unset in prod, so it never ran). This flips the
 * default so the feature is live globally after deploy while keeping a
 * one-env-var kill switch.
 *
 * @param {Record<string, unknown>} [env] injectable for tests; defaults to
 *   the Vite build env.
 * @returns {boolean}
 */
export function isGapGateEnabled(env) {
  const resolved =
    env !== undefined
      ? env
      : typeof import.meta !== 'undefined'
        ? import.meta.env
        : undefined
  return resolved?.VITE_GAP_GATE_ENABLED !== 'false'
}
