/**
 * John — Outreach Drafting Agent — type definitions and constants.
 *
 * John is GrantFlow's email-drafting agent. He reads qualified lead packets
 * from Yana (the lead-discovery agent), interprets them, writes a respectful,
 * specific outreach email, and places that email into Microsoft Outlook as a
 * DRAFT. John never sends. Dr. John White reviews and sends manually.
 *
 * This module is a pure-data module — no I/O, no database, no env reads —
 * so it can be safely imported anywhere (including frontend builds).
 */

export const JOHN_AGENT_NAME = 'John'

export const JOHN_MODES = Object.freeze({
  OBSERVE: 'observe',
  DRAFT: 'draft',
  REVISE: 'revise',
  VERIFY_ALIAS: 'verify-alias',
  FULL_CYCLE: 'full-cycle',
})

export const ALL_JOHN_MODES = Object.freeze([
  JOHN_MODES.OBSERVE,
  JOHN_MODES.DRAFT,
  JOHN_MODES.REVISE,
  JOHN_MODES.VERIFY_ALIAS,
  JOHN_MODES.FULL_CYCLE,
])

export const JOHN_TRIGGERS = Object.freeze({
  MANUAL: 'manual',
  STARTUP: 'startup',
  SCHEDULE: 'schedule',
  ADMIN: 'admin',
  TEST: 'test',
})

export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  DAILY_LIMIT_REACHED: 'daily_limit_reached',
})

/**
 * Allowed values for john_email_drafts.draft_status. Keep this list aligned
 * with the migration 083_john_tables.sql.
 */
export const DRAFT_STATUS = Object.freeze({
  CREATED: 'created',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  NEEDS_REVIEW: 'needs_review',
  NEEDS_SENDER_ALIAS_REVIEW: 'needs_sender_alias_review',
  REVIEWED: 'reviewed',
  SENT_MANUALLY: 'sent_manually',
  ARCHIVED: 'archived',
  // The operator deleted the draft from the Outlook mailbox. This is the
  // owner's curation decision ("I decide which get sent and which don't") — a
  // TERMINAL, handled state. It is intentionally NOT in hasDraftForLead's
  // re-draft-eligible exclusion set, so John never resurrects a draft the
  // owner has deliberately removed. Distinct from ARCHIVED (which IS eligible
  // to redraft) precisely so deletion reads as rejection, not loss.
  DELETED_BY_USER: 'deleted_by_user',
})

export const ALL_DRAFT_STATUSES = Object.freeze(Object.values(DRAFT_STATUS))

export const SAFETY_STATUS = Object.freeze({
  PASSED: 'passed',
  BLOCKED: 'blocked',
  WARN: 'warn',
})

export const AUDIT_STATUS = Object.freeze({
  DRAFT_CREATED: 'draft_created',
  DRAFT_BLOCKED: 'draft_blocked',
  DRAFT_FAILED: 'draft_failed',
  SUPPRESSED: 'suppressed',
  ALIAS_FAILED: 'alias_failed',
  SAFETY_FAILED: 'safety_failed',
  REVIEWED: 'reviewed',
  SENT_MANUALLY: 'sent_manually',
  DELETED_IN_OUTLOOK: 'deleted_in_outlook',
})

export const SUPPRESSION_TYPE = Object.freeze({
  EMAIL: 'email',
  DOMAIN: 'domain',
  ORGANIZATION: 'organization',
  PHONE: 'phone',
})

export const ALL_SUPPRESSION_TYPES = Object.freeze(Object.values(SUPPRESSION_TYPE))

/**
 * Reasons John may BLOCK a draft. Stored in safety_report_json.reasons[]
 * and in audit rows. The names are stable so admin UIs can group/sort by them.
 */
export const BLOCK_REASONS = Object.freeze({
  SUPPRESSED_EMAIL: 'suppressed_email',
  SUPPRESSED_DOMAIN: 'suppressed_domain',
  SUPPRESSED_ORG: 'suppressed_organization',
  SUPPRESSED_PHONE: 'suppressed_phone',
  DO_NOT_CONTACT: 'do_not_contact',
  MISSING_RECIPIENT: 'missing_recipient',
  INVALID_RECIPIENT: 'invalid_recipient',
  MISSING_PUBLIC_EVIDENCE: 'missing_public_evidence',
  MISSING_CONTACT_SOURCE: 'missing_contact_source',
  LOW_LEAD_SCORE: 'low_lead_score',
  LEAD_NOT_QUALIFIED_BY_YANA: 'lead_not_qualified_by_yana',
  DAILY_LIMIT_REACHED: 'daily_limit_reached',
  HOURLY_LIMIT_REACHED: 'hourly_limit_reached',
  RUN_LIMIT_REACHED: 'run_limit_reached',
  DECEPTIVE_SUBJECT: 'deceptive_subject',
  GUARANTEES_FUNDING: 'guarantees_funding',
  CLAIMS_PRIOR_RELATIONSHIP: 'claims_prior_relationship',
  PREDATORY_TARGETING: 'predatory_targeting',
  MISSING_OPT_OUT: 'missing_opt_out',
  MISSING_PHYSICAL_ADDRESS: 'missing_physical_address',
  ALIAS_NOT_SUPPORTED: 'alias_not_supported',
  ALIAS_CHECK_NEVER_RAN: 'alias_check_never_ran',
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  ALREADY_DRAFTED: 'already_drafted',
})

/**
 * Build an empty Yana lead packet. Real packets come from the Yana queue;
 * this factory is used by tests and by the bridge when normalising partial
 * objects so consumers can rely on a predictable shape.
 */
export function makeYanaLeadPacket(input = {}) {
  return {
    lead_id: input.lead_id || null,
    organization_name: input.organization_name || null,
    organization_type: input.organization_type || null,
    website_url: input.website_url || null,
    location: input.location || null,
    contact_points: Array.isArray(input.contact_points) ? input.contact_points : [],
    public_evidence: Array.isArray(input.public_evidence) ? input.public_evidence : [],
    funding_need_summary: input.funding_need_summary || null,
    grantflow_fit_summary: input.grantflow_fit_summary || null,
    lead_score: typeof input.lead_score === 'number' ? input.lead_score : null,
    contact_confidence:
      typeof input.contact_confidence === 'number' ? input.contact_confidence : null,
    urgency_score: typeof input.urgency_score === 'number' ? input.urgency_score : null,
    recommended_outreach_angle: input.recommended_outreach_angle || null,
    recommended_channel: input.recommended_channel || 'email',
    suggested_persona: input.suggested_persona || null,
    do_not_contact_flags: Array.isArray(input.do_not_contact_flags)
      ? input.do_not_contact_flags
      : [],
    compliance_notes: input.compliance_notes || null,
    source_urls: Array.isArray(input.source_urls) ? input.source_urls : [],
    discovered_at: input.discovered_at || null,
    qualified: input.qualified === true,
    status: input.status || null,
  }
}

/**
 * Shape of the alias report John records on every draft.
 */
export function makeAliasReport(input = {}) {
  return {
    requested_from_alias: input.requested_from_alias || null,
    actual_from: input.actual_from || null,
    reply_to: input.reply_to || null,
    alias_verified: input.alias_verified === true,
    alias_send_supported: input.alias_send_supported === true,
    fallback_used: input.fallback_used === true,
    needs_sender_alias_review: input.needs_sender_alias_review === true,
    notes: input.notes || null,
  }
}

export function makeSafetyReport(input = {}) {
  return {
    status: input.status || SAFETY_STATUS.PASSED,
    reasons: Array.isArray(input.reasons) ? input.reasons : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    checked_at: input.checked_at || new Date().toISOString(),
  }
}
