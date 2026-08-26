/**
 * Yana — Lead Discovery & Outreach Agent: shared types, constants, factories.
 *
 * (Internal filenames and exports use the `yanaOutreach`/`YANA_OUTREACH_`
 *  spelling; the user-facing identity is Yana. See
 *  docs/YANA_LEAD_PIPELINE_AGENT.md.)
 *
 * Yana's mission:
 *   Find likely GrantFlow CLIENTS (prospective customers/users), verify public
 *   organization & contact info, score fit + urgency, build a structured lead
 *   packet, and DRAFT outreach. Yana hands those drafts off for review (in the
 *   canonical pipeline, John saves them to the Outlook DRAFT folder). **Yana
 *   herself never sends email.** Sending is a SEPARATE, person-triggered
 *   action — a person reviews a draft and sends it, or doesn't. It is not part
 *   of Yana's automated cycle.
 *
 * Yana is NOT:
 *   - A funding-discovery agent (that is Robert).
 *   - A user-facing assistant (that is Anya).
 *   - A code-health agent (that is Sam).
 *   - A grant-writing agent.
 *   - An emailer of any kind. Yana produces drafts only; the actual send is a
 *     separate person-triggered step, never something Yana triggers on her own.
 */

export const YANA_OUTREACH_AGENT_NAME = 'Yana'

export const YANA_OUTREACH_MODES = Object.freeze({
  OBSERVE: 'observe',
  DISCOVER_PROSPECTS: 'discover-prospects',
  VERIFY_CONTACTS: 'verify-contacts',
  SCORE_FIT: 'score-fit',
  BUILD_PACKETS: 'build-packets',
  QUALIFY: 'qualify',
  DRAFT_OUTREACH: 'draft-outreach',
  SEND_OUTREACH: 'send-outreach',
  TRACK_RELATIONSHIPS: 'track-relationships',
  FULL_CYCLE: 'full-cycle',
})

export const YANA_OUTREACH_TRIGGERS = Object.freeze({
  MANUAL: 'manual',
  SCHEDULER: 'scheduler',
  STARTUP: 'startup',
  ADMIN_API: 'admin_api',
})

export const YANA_OUTREACH_RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PARTIAL: 'partial',
  CANCELLED: 'cancelled',
})

export const PROSPECT_STATUS = Object.freeze({
  DISCOVERED: 'discovered',
  CONTACT_UNVERIFIED: 'contact_unverified',
  CONTACT_VERIFIED: 'contact_verified',
  REJECTED: 'rejected',
  QUALIFIED: 'qualified',
  ARCHIVED: 'archived',
})

export const CONTACT_VERIFICATION_STATUS = Object.freeze({
  UNVERIFIED: 'unverified',
  VERIFIED: 'verified',
  PARTIAL: 'partial',
  UNREACHABLE: 'unreachable',
  REJECTED: 'rejected',
})

export const LEAD_STATUS = Object.freeze({
  NEW: 'new',
  REVIEWING: 'reviewing',
  QUALIFIED: 'qualified',
  APPROVED_FOR_OUTREACH: 'approved_for_outreach',
  CONTACTED: 'contacted',
  RESPONDED: 'responded',
  CONVERTED: 'converted',
  ARCHIVED: 'archived',
  REJECTED: 'rejected',
})

export const RELATIONSHIP_STATE = Object.freeze({
  NONE: 'none',
  CONTACTED: 'contacted',
  OPENED: 'opened',
  REPLIED: 'replied',
  MEETING_SCHEDULED: 'meeting_scheduled',
  CONVERTED: 'converted',
  DECLINED: 'declined',
  COOLED_OFF: 'cooled_off',
  DO_NOT_CONTACT: 'do_not_contact',
})

export const OUTREACH_CHANNEL = Object.freeze({
  EMAIL: 'email',
  POSTAL: 'postal',
  PHONE: 'phone',
  CONTACT_FORM: 'contact_form',
  SOCIAL: 'social',
})

export const OUTREACH_SEND_STATUS = Object.freeze({
  DRAFTED: 'drafted',
  AWAITING_SEND_CONSENT: 'awaiting_send_consent',
  APPROVED: 'approved',
  SENT: 'sent',
  BOUNCED: 'bounced',
  UNSUBSCRIBED: 'unsubscribed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const SUPPRESSION_TYPES = Object.freeze({
  EMAIL: 'email',
  DOMAIN: 'domain',
  EIN: 'ein',
  ORGANIZATION: 'organization',
  PHONE: 'phone',
})

/**
 * Reasons Yana rejects a prospect candidate or contact verification attempt.
 * Stored explicitly so an admin can audit *why* an organization was filtered
 * out — Yana must never silently drop prospects.
 */
export const PROSPECT_REJECTION_REASONS = Object.freeze({
  NO_NAME: 'no_name',
  NO_LOCATION: 'no_location',
  NOT_PROBABLE_GRANTSEEKER: 'not_probable_grantseeker',
  PLACEHOLDER_DATA: 'placeholder_data',
  DUPLICATE: 'duplicate',
  ON_SUPPRESSION_LIST: 'on_suppression_list',
  GENERIC_DOMAIN: 'generic_domain',
  WEBSITE_DEAD: 'website_dead',
  EMAIL_INVALID_FORMAT: 'email_invalid_format',
  EMAIL_DISPOSABLE: 'email_disposable',
  EMAIL_ROLE_GENERIC: 'email_role_generic',
  ORGANIZATION_DISSOLVED: 'organization_dissolved',
  GOVERNMENT_AGENCY: 'government_agency',
  EXISTING_GRANTFLOW_USER: 'existing_grantflow_user',
  LOW_FIT_SCORE: 'low_fit_score',
  DNC: 'do_not_contact',
})

/**
 * Reasons Yana blocks a *send* attempt even after a draft is created.
 * This mirrors the canonical opportunity-rejection list in Robert and lets the
 * admin console show exactly why an outreach didn't go out.
 */
export const SEND_BLOCK_REASONS = Object.freeze({
  AGENT_DISABLED: 'agent_disabled',
  SEND_NOT_APPROVED: 'send_not_approved',
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  RECIPIENT_MISSING: 'recipient_missing',
  RECIPIENT_INVALID: 'recipient_invalid',
  ON_SUPPRESSION_LIST: 'on_suppression_list',
  RELATIONSHIP_DNC: 'relationship_do_not_contact',
  COOLDOWN_ACTIVE: 'cooldown_active',
  DAILY_LIMIT: 'daily_send_limit_reached',
  DRY_RUN: 'dry_run',
  DRAFT_TOO_SHORT: 'draft_too_short',
  DRAFT_LOOKS_TEMPLATIC: 'draft_looks_templatic',
})

/**
 * Yana's internal categorization of fit for GrantFlow's product. These are
 * just labels for explainability — the score is the source of truth. Anything
 * that ships to a human is annotated with the reasons that produced the score.
 */
export const FIT_REASON_CODES = Object.freeze({
  KNOWN_GRANT_SEEKER_TYPE: 'known_grant_seeker_type',
  HAS_PUBLIC_PROGRAMS: 'has_public_programs',
  RECENT_GRANT_ACTIVITY: 'recent_grant_activity',
  HAS_VERIFIED_CONTACT: 'has_verified_contact',
  STATE_AND_LOCAL_CLEAR: 'state_and_local_clear',
  EIN_PRESENT: 'ein_present',
  WEBSITE_LIVE: 'website_live',
  MISSION_ALIGNS_WITH_NEED_CATEGORIES: 'mission_aligns_with_need_categories',
  SMALL_BUDGET_GRANT_SEEKER: 'small_budget_grant_seeker',
  RURAL_OR_UNDERSERVED: 'rural_or_underserved',
  VOLUNTEER_LED_ORG: 'volunteer_led_org',
})

export const URGENCY_REASON_CODES = Object.freeze({
  ACTIVE_CAPITAL_CAMPAIGN: 'active_capital_campaign',
  RECENT_DISASTER_IN_REGION: 'recent_disaster_in_region',
  PUBLIC_FUNDING_DEADLINE_PRESSURE: 'public_funding_deadline_pressure',
  STAFF_TRANSITION_SIGNAL: 'staff_transition_signal',
  RECENT_GRANT_DENIAL: 'recent_grant_denial',
  NEW_PROGRAM_LAUNCH: 'new_program_launch',
  RECENT_NEWS_COVERAGE: 'recent_news_coverage',
})

export const QUALIFICATION_THRESHOLDS = Object.freeze({
  MIN_FIT: 60,
  MIN_COMPOSITE: 65,
  REQUIRE_VERIFIED_CONTACT: true,
})

/**
 * Build a freshly-shaped prospect-candidate record with safe defaults. Never
 * mutates the input. Used by both real discovery adapters and tests.
 */
export function makeProspectCandidate(input = {}) {
  return {
    run_id: input.run_id ?? null,
    source_name: input.source_name ?? null,
    source_url: input.source_url ?? null,
    source_type: input.source_type ?? null,
    organization_name: String(input.organization_name ?? '').trim(),
    organization_legal_name: input.organization_legal_name ?? null,
    organization_type: input.organization_type ?? null,
    organization_subtype: input.organization_subtype ?? null,
    ein: input.ein ?? null,
    website_url: input.website_url ?? null,
    primary_contact_name: input.primary_contact_name ?? null,
    primary_contact_role: input.primary_contact_role ?? null,
    primary_contact_email: input.primary_contact_email ?? null,
    primary_contact_phone: input.primary_contact_phone ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    zip: input.zip ?? null,
    county: input.county ?? null,
    geography_scope: input.geography_scope ?? null,
    applicant_type: input.applicant_type ?? null,
    need_categories_json: Array.isArray(input.need_categories) ? input.need_categories : [],
    programs_json: Array.isArray(input.programs) ? input.programs : [],
    signals_json: input.signals && typeof input.signals === 'object' ? input.signals : {},
    raw_payload_json: input.raw_payload ?? null,
    status: input.status ?? PROSPECT_STATUS.DISCOVERED,
    rejection_reason: input.rejection_reason ?? null,
    evidence_json: input.evidence ?? null,
    contact_verification_status: input.contact_verification_status ?? CONTACT_VERIFICATION_STATUS.UNVERIFIED,
  }
}

/**
 * Build a freshly-shaped lead packet record. Packets carry the structured
 * "why this prospect, why now" payload that gets handed to outreach.
 */
export function makeLeadPacket(input = {}) {
  return {
    prospect_candidate_id: String(input.prospect_candidate_id ?? '').trim(),
    run_id: input.run_id ?? null,
    packet_version: Number.isFinite(input.packet_version) ? input.packet_version : 1,
    packet_json: input.packet ?? null,
    packet_summary: input.packet_summary ?? null,
    fit_score: Number.isFinite(input.fit_score) ? input.fit_score : 0,
    urgency_score: Number.isFinite(input.urgency_score) ? input.urgency_score : 0,
    composite_score: Number.isFinite(input.composite_score) ? input.composite_score : 0,
    fit_reasons_json: Array.isArray(input.fit_reasons) ? input.fit_reasons : [],
    urgency_reasons_json: Array.isArray(input.urgency_reasons) ? input.urgency_reasons : [],
    recommended_pitch: input.recommended_pitch ?? null,
    recommended_outreach_method: input.recommended_outreach_method ?? OUTREACH_CHANNEL.EMAIL,
    status: input.status ?? LEAD_STATUS.NEW,
  }
}

export function makeOutreachAttempt(input = {}) {
  return {
    lead_id: String(input.lead_id ?? '').trim(),
    prospect_candidate_id: String(input.prospect_candidate_id ?? '').trim(),
    channel: input.channel ?? OUTREACH_CHANNEL.EMAIL,
    template_id: input.template_id ?? null,
    draft_subject: input.draft_subject ?? null,
    draft_body: input.draft_body ?? null,
    draft_text: input.draft_text ?? null,
    draft_metadata_json: input.draft_metadata ?? null,
    drafted_by: input.drafted_by ?? 'larry',
    send_status: input.send_status ?? OUTREACH_SEND_STATUS.DRAFTED,
  }
}
