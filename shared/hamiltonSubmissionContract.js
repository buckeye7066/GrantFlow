/**
 * Canonical external-submission contract shared by Hamilton's API and UI.
 *
 * A new version is required whenever the authority, irreversible actions, or
 * proof requirements change. Workers must match this exact version at every
 * external mutation; accepting a newer/older row by accident is fail-open.
 */
export const HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION = 'hamilton-external-submit-v2'

export { IRREVERSIBLE_ACTION_CONTRACT_VERSION } from './irreversibleActionContract.js'

export const HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT = (
  'Hamilton may prepare the selected application, open its exact portal, fill '
  + 'profile-sourced answers, upload the documents you selected, and save a '
  + 'draft. Hamilton may click the portal’s final Submit action only when this '
  + 'profile’s auto-submit toggle is on and a current, target-scoped Submit '
  + 'authorization remains active. Hamilton pauses for login, MFA, CAPTCHA, '
  + 'payment, signatures, terms, releases, and legal or accuracy attestations. '
  + 'Using an existing saved login does not authorize creation of a new portal '
  + 'account. Account creation requires its own explicit, target-scoped option '
  + 'and a reviewed portal-specific registration contract; otherwise Hamilton '
  + 'hands registration and email activation to you. '
  + 'A click, draft, review page, or screenshot alone is not a confirmed '
  + 'submission; GrantFlow reports external receipt only from portal-issued or '
  + 'independently verified evidence bound to this application attempt.'
)

export const HAMILTON_SUBMISSION_LIFECYCLE = Object.freeze({
  PREPARED: 'prepared',
  PORTAL_DRAFT_SAVED: 'portal_draft_saved',
  HUMAN_ACTION_REQUIRED: 'human_action_required',
  READY_FOR_FINAL_SUBMIT: 'ready_for_final_submit',
  SUBMISSION_IN_FLIGHT: 'submission_in_flight',
  RECONCILIATION_REQUIRED: 'reconciliation_required',
  EXTERNALLY_RECEIVED: 'externally_received',
  EXTERNALLY_VALIDATED: 'externally_validated',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
})

export const HAMILTON_HUMAN_ACTION_KINDS = Object.freeze([
  'login',
  'mfa',
  'captcha',
  'signature',
  'attestation',
  'terms',
  'release',
  'payment',
  'role_aor',
  'manual_upload',
  'final_review_submit',
  'missing_information',
  'unknown_portal_state',
])

export const HAMILTON_EXTERNAL_ACTIONS = Object.freeze({
  BROWSER_LAUNCH: 'browser_launch',
  USE_CREDENTIAL: 'use_credential',
  USE_SAVED_SESSION: 'use_saved_session',
  CREATE_PORTAL_ACCOUNT: 'create_portal_account',
  FILL_FORM: 'fill_form',
  UPLOAD_DOCUMENT: 'upload_document',
  SAVE_DRAFT: 'save_draft',
  ADVANCE_PAGE: 'advance_page',
  FINAL_SUBMIT: 'final_submit',
  FINAL_SUBMIT_COMMIT: 'final_submit_commit',
  PERSIST_PROOF: 'persist_proof',
})

export const HAMILTON_MUTATION_AUTHORIZATION = Object.freeze({
  browser_launch: 'complete_forms',
  use_credential: 'use_saved_credentials_reference',
  use_saved_session: 'use_saved_session',
  create_portal_account: 'create_portal_account',
  fill_form: 'complete_forms',
  upload_document: 'upload_documents',
  save_draft: 'save_drafts',
  advance_page: 'complete_forms',
  final_submit: 'submit_applications',
  final_submit_commit: 'submit_applications',
  persist_proof: 'submit_applications',
})

export const HAMILTON_TERMINAL_RECEIPT_STATES = Object.freeze([
  HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_RECEIVED,
  HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_VALIDATED,
])
