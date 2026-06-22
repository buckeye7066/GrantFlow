// crawler-os/stages.js
//
// THE canonical application-pipeline stage list. Doctrine #11 requires ONE
// 11-stage enum used everywhere (UI, storage, agents, Hamilton). No component
// may define its own stage strings or its own legal transitions.
//
// Pure, no I/O.

/**
 * The 11 canonical stages, in forward order. Exact strings are a contract:
 * storage rows, UI columns, and agent logic all use these and only these.
 */
export const PIPELINE_STAGE = Object.freeze({
  DISCOVERED: 'discovered',                 // surfaced by Robert / catalog, not yet acted on
  SAVED: 'saved',                           // user saved it
  INTERESTED: 'interested',                 // user flagged intent to pursue
  GATHERING_DOCUMENTS: 'gathering_documents', // collecting required docs
  DRAFTING: 'drafting',                     // Hamilton / user drafting the application
  READY_TO_SUBMIT: 'ready_to_submit',       // packet complete, awaiting authorization
  SUBMITTED: 'submitted',                   // application submitted
  FOLLOW_UP: 'follow_up',                   // awaiting funder response / providing more info
  AWARDED: 'awarded',                       // funding awarded
  DECLINED: 'declined',                     // funder declined
  ARCHIVED: 'archived',                     // closed out / withdrawn / no longer pursuing
});

/** Ordered array form (index = forward progression rank). */
export const PIPELINE_STAGES = Object.freeze([
  PIPELINE_STAGE.DISCOVERED,
  PIPELINE_STAGE.SAVED,
  PIPELINE_STAGE.INTERESTED,
  PIPELINE_STAGE.GATHERING_DOCUMENTS,
  PIPELINE_STAGE.DRAFTING,
  PIPELINE_STAGE.READY_TO_SUBMIT,
  PIPELINE_STAGE.SUBMITTED,
  PIPELINE_STAGE.FOLLOW_UP,
  PIPELINE_STAGE.AWARDED,
  PIPELINE_STAGE.DECLINED,
  PIPELINE_STAGE.ARCHIVED,
]);

/** Terminal stages — no forward progression past these. */
export const TERMINAL_STAGES = Object.freeze([
  PIPELINE_STAGE.AWARDED,
  PIPELINE_STAGE.DECLINED,
  PIPELINE_STAGE.ARCHIVED,
]);

export function isValidStage(stage) {
  return PIPELINE_STAGES.includes(stage);
}

/**
 * Legal transitions. The happy path moves forward one step, but real workflows
 * skip and double back, so the rules are permissive within sanity limits:
 *   - ARCHIVED is reachable from any non-terminal stage (withdraw any time).
 *   - You may move forward to any later active stage (skipping is allowed).
 *   - You may step backward by one active stage (e.g. ready_to_submit -> drafting)
 *     to fix something.
 *   - SUBMITTED -> {follow_up, awarded, declined, archived}.
 *   - follow_up -> {awarded, declined, archived}.
 *   - From a terminal stage you may only re-open into ARCHIVED (no resurrection
 *     of an awarded/declined record except to archive it).
 *
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (!isValidStage(from) || !isValidStage(to)) return false;
  if (from === to) return true;
  if (to === PIPELINE_STAGE.ARCHIVED) return true; // archive from anywhere

  const active = PIPELINE_STAGES.slice(0, PIPELINE_STAGES.indexOf(PIPELINE_STAGE.SUBMITTED) + 1);
  const fromIdx = PIPELINE_STAGES.indexOf(from);
  const toIdx = PIPELINE_STAGES.indexOf(to);

  // Terminal -> only archive (handled above); otherwise blocked.
  if (TERMINAL_STAGES.includes(from)) return false;

  // submitted / follow_up special forward set.
  if (from === PIPELINE_STAGE.SUBMITTED) {
    return [PIPELINE_STAGE.FOLLOW_UP, PIPELINE_STAGE.AWARDED, PIPELINE_STAGE.DECLINED].includes(to);
  }
  if (from === PIPELINE_STAGE.FOLLOW_UP) {
    return [PIPELINE_STAGE.AWARDED, PIPELINE_STAGE.DECLINED].includes(to);
  }

  // Within the active (pre-submit) band: forward any distance, back exactly one.
  if (active.includes(from)) {
    if (toIdx > fromIdx) return true;            // forward / skip ahead
    if (toIdx === fromIdx - 1) return true;       // one step back to fix
    return false;
  }
  return false;
}

/**
 * assertTransition — throw a clear error on an illegal stage move. Storage uses
 * this so an invalid transition is a loud failure, never a silent corruption.
 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`illegal pipeline transition: ${from} -> ${to}`);
  }
  return to;
}

export default {
  PIPELINE_STAGE, PIPELINE_STAGES, TERMINAL_STAGES,
  isValidStage, canTransition, assertTransition,
};
