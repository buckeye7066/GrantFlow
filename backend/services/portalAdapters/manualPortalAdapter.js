/**
 * manualPortalAdapter.js
 *
 * Adapter for the `manual_or_offline` portal type. By design this adapter
 * never submits anything — it always returns a clear instruction to the
 * user/admin.
 */

import { ADAPTER_OUTCOMES, makeAdapterResult } from './portalAdapterTypes.js'

export const manualPortalAdapter = Object.freeze({
  name: 'manual',
  portalTypes: ['manual_or_offline'],

  canHandle(portalLink) {
    return portalLink?.portal_type === 'manual_or_offline'
  },

  inspectRequirements({ opportunity }) {
    const requirements = [
      {
        kind: 'admin_review',
        key: 'manual_review',
        label: 'Manual review required',
        description:
          opportunity?.application_url
            ? `Open ${opportunity.application_url} and apply manually. Yana cannot automate this portal.`
            : 'Yana could not detect a portal automation path. Apply manually following the funder instructions.',
        required: true,
      },
    ]
    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.WAITING_FOR_ADMIN,
      message: 'This opportunity requires a manual application.',
      requirements,
      safeToProceed: false,
      blockingReason: 'manual_review_required',
    })
  },

  prepareApplication(ctx) { return this.inspectRequirements(ctx) },
  fillApplication(ctx) { return this.inspectRequirements(ctx) },

  submitApplication(_ctx) {
    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.WAITING_FOR_ADMIN,
      message: 'Manual portal — Yana will not submit. The user/admin must complete this application.',
      safeToProceed: false,
      blockingReason: 'manual_submission_only',
    })
  },

  getMissingInfo({ opportunity }) {
    return [{
      kind: 'admin_review',
      key: 'manual_review',
      label: 'Manual review required',
      description:
        opportunity?.application_url
          ? `Open ${opportunity.application_url} and apply manually.`
          : 'No automation path available — apply manually.',
      required: true,
    }]
  },

  getHumanReadableStatus({ opportunity }) {
    if (opportunity?.application_url) {
      return `Open ${opportunity.application_url} and submit the application yourself. Yana cannot automate this portal.`
    }
    return 'Apply manually following the funder instructions. Yana cannot automate this portal.'
  },
})
