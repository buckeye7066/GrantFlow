/**
 * listingApplyRunner.js — the `applyItem` runner that `decomposeListing` was
 * missing (gap 2 of the hub-harvester build, 2026-08-24).
 *
 * BEFORE: `hamiltonAutomationOrchestrator` called `decomposeListing` with NO
 * `applyItem` dep, so every ACCEPTed award with a real apply link fell to
 * `accepted_apply_deferred` → a child review task hard-coded to
 * `allowAutoSubmit:false`. A listing of awards the profile qualifies for could
 * therefore never be applied to autonomously, even under full-automation consent.
 *
 * AFTER: when — and ONLY when — the PARENT run is authorized (full automation +
 * `allow_auto_submit`), the orchestrator builds this runner and hands it to
 * `decomposeListing`. It re-enters the EXISTING per-task fill/submit flow for the
 * child award (`runChildApply`, injected — production re-invokes
 * `automateSingleSource` for the child opportunity), forwarding the parent's
 * consent VERBATIM. It NEVER widens consent: with `allowAutoSubmit !== true` it
 * refuses, so an unauthorized parent keeps the reviewed-child-task default.
 *
 * A submit is REPORTED only through the child engine's own evidence gate — this
 * runner passes the engine-style result through unchanged and never upgrades a
 * no-evidence click to "submitted".
 *
 * PURE: `runChildApply` is injected, so the consent/bound/normalization logic is
 * unit-testable without a browser, DB, or the orchestrator.
 */

import { LISTING_MAX_APPLIES } from './listingDecomposition.js'

/**
 * @param {object} args
 * @param {(ctx:{item:object,opportunityId:string,allowAutoSubmit:boolean})=>Promise<object>} args.runChildApply
 *   drives the child award through the existing per-task fill/submit flow.
 * @param {boolean} args.allowAutoSubmit  the PARENT run's consent — forwarded verbatim.
 * @param {number} [args.maxApplies]      hard fan-out bound (double-guards decomposeListing's).
 * @param {(msg:string,detail?:object)=>void} [args.log]
 * @returns {(item:object, ctx:{opportunityId:string})=>Promise<object>} an applyItem for decomposeListing.
 */
export function makeListingApplyItem({ runChildApply, allowAutoSubmit, maxApplies = LISTING_MAX_APPLIES, log = () => {} } = {}) {
  if (typeof runChildApply !== 'function') {
    throw new Error('makeListingApplyItem requires a runChildApply(ctx) function')
  }
  let attempted = 0
  return async function applyItem(item, { opportunityId } = {}) {
    // Consent is read verbatim and NEVER widened. Without explicit auto-submit
    // consent this runner refuses — the parent should not have built it at all,
    // so this is a defense-in-depth floor.
    if (allowAutoSubmit !== true) {
      return { status: 'blocked', blocker_kind: 'apply_unauthorized', detail: 'auto-submit consent not granted — child award not applied' }
    }
    if (!opportunityId) {
      return { status: 'blocked', blocker_kind: 'no_opportunity', detail: 'child award was not admitted to the catalog' }
    }
    if (attempted >= maxApplies) {
      return { status: 'blocked', blocker_kind: 'apply_fanout_capped', detail: `reached HAMILTON_LISTING_MAX_APPLIES=${maxApplies}` }
    }
    attempted += 1
    let result
    try {
      result = await runChildApply({ item, opportunityId, allowAutoSubmit })
    } catch (err) {
      return { status: 'failed', blocker_kind: 'apply_error', detail: err?.message || String(err) }
    }
    log(`listing applyItem: ${item?.title || opportunityId} → ${result?.status || 'unknown'}`)
    // Pass the child engine's result through unchanged — its evidence gate is the
    // sole authority on whether the run is 'submitted'. This runner never fabricates
    // a submitted status.
    return result || { status: 'blocked', blocker_kind: 'apply_no_result', detail: 'child apply returned nothing' }
  }
}

export default { makeListingApplyItem }
