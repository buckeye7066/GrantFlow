/**
 * basePortalAdapter.js
 *
 * Default implementations for the portal-adapter contract. Concrete
 * adapters (manual, external, financial-aid, scholarship) extend / shadow
 * these methods.
 *
 * Contract (every adapter exports an object with these methods):
 *   - canHandle(portalLink, opportunity, profile) → boolean
 *   - inspectRequirements(context) → AdapterResult (always READY or
 *     blocked_missing_info; never SUBMITTED)
 *   - prepareApplication(context) → AdapterResult
 *   - fillApplication(context) → AdapterResult
 *   - submitApplication(context) → AdapterResult — only callable when
 *     context.options.allowSubmit === true
 *   - getMissingInfo(context) → array of requirement objects
 *   - getHumanReadableStatus(context) → string
 */

import { ADAPTER_OUTCOMES, makeAdapterResult } from './portalAdapterTypes.js'

export const baseAdapter = Object.freeze({
  name: 'base',
  portalTypes: [],

  canHandle: () => false,

  inspectRequirements: (ctx) => makeAdapterResult({
    outcome: ADAPTER_OUTCOMES.READY,
    message: 'Base adapter has no requirement checks; subclass should override.',
    requirements: [],
  }),

  prepareApplication: (_ctx) => makeAdapterResult({
    outcome: ADAPTER_OUTCOMES.READY,
    message: 'Base prepare — nothing to do.',
  }),

  fillApplication: (_ctx) => makeAdapterResult({
    outcome: ADAPTER_OUTCOMES.READY,
    message: 'Base fill — nothing to fill.',
  }),

  submitApplication: (_ctx) => makeAdapterResult({
    outcome: ADAPTER_OUTCOMES.WAITING_FOR_USER,
    message: 'Base adapter cannot submit; the user must finalise the application.',
    safeToProceed: false,
  }),

  getMissingInfo: () => [],

  getHumanReadableStatus: (_ctx) => 'No portal-specific status available.',
})

/**
 * Helper for adapters that defer most work to user/admin. Marks the
 * outcome as waiting_for_user, attaches the requirements so the UI can
 * render the missing-info form, and surfaces a plain-language message.
 */
export function makeBlockedMissingResult({ message, requirements }) {
  return makeAdapterResult({
    outcome: ADAPTER_OUTCOMES.BLOCKED_MISSING,
    message,
    requirements,
    safeToProceed: false,
    blockingReason: 'missing_info',
  })
}

/**
 * Helper for adapters that need a credentialed login the system cannot
 * complete on the user's behalf. Always sets safe_to_proceed=false.
 */
export function makeBlockedLoginResult({ message, requirements = [] }) {
  return makeAdapterResult({
    outcome: ADAPTER_OUTCOMES.BLOCKED_LOGIN,
    message,
    requirements: requirements.length
      ? requirements
      : [{ kind: 'login', key: 'portal_login', label: 'Portal login', description: message, required: true }],
    safeToProceed: false,
    blockingReason: 'login_required',
  })
}
