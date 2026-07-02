/**
 * hamiltonHardStopTargets.js
 *
 * Single source of truth that turns a Hamilton hard stop (a row from
 * `hamilton_blockers`, surfaced by GET /api/hamilton/automation/admin/hard-stops
 * and by the clickable toasts from HamiltonToastBridge) into an actionable
 * checklist item:
 *
 *   { actionLabel, fixedWhere, instructions[], href(blocker) }
 *
 * `href` is an in-app route that drops the operator exactly where the stop is
 * cleared — using the same `?flash=` deep-link convention the toasts use, so
 * arriving on the page also scrolls to and pulses the relevant card/field.
 *
 * The keys here MUST stay aligned with `BLOCKER_PROFILE` in
 * backend/services/hamilton/hamiltonHardStopResolver.js — that file decides
 * which `blocker_type` Hamilton raises; this file decides where the human goes
 * to resolve it. Any type with no explicit entry falls back to UNKNOWN_TARGET.
 *
 * Consumed by:
 *   - components/hamilton/HamiltonHardStopChecklist.jsx
 */

import { createPageUrl } from "@/utils"
import { withFlashParam } from "@/lib/flashHighlight"
import {
  buildProfileSectionLink,
  resolveMissingInfoTarget,
  EDITABLE_SECTIONS,
} from "@/config/missingInfoTargets"

/** The field key a "missing info / ambiguous field" blocker points at, if any. */
function blockerFieldKey(blocker) {
  const m = blocker?.metadata || {}
  return m.field || m.key || m.missing_info_key || m.missing_field || null
}

/** blocker_types whose value can be supplied inline (typed in the banner). */
const INLINE_FIXABLE_TYPES = new Set(["missing_required_information", "ambiguous_required_field"])

/**
 * If this blocker is a missing/ambiguous scalar profile field, return what the
 * inline fixer needs to render an input and save it back to the profile:
 *   { fieldKey, sectionKey, field, label }
 * Otherwise null — the row falls back to the navigate-to-fix link. Only fields
 * that live in an editable profile section qualify (documents, saved logins,
 * university_applications, etc. are fixed on their own surfaces).
 */
export function resolveInlineField(blocker) {
  if (!blocker) return null
  // Server-authoritative: the API annotates each stop with `inline_field` (an
  // object when fixable, null when not) computed from the backend field map, so
  // the UI never offers an input the save endpoint would reject. Trust it when
  // present; fall back to client computation only for un-annotated payloads.
  if (Object.prototype.hasOwnProperty.call(blocker, "inline_field")) {
    return blocker.inline_field || null
  }
  if (!INLINE_FIXABLE_TYPES.has(blocker.blocker_type)) return null
  const fieldKey = blockerFieldKey(blocker)
  if (!fieldKey) return null
  const target = resolveMissingInfoTarget(fieldKey)
  if (!target || target.isDocument) return null
  if (!target.section || !target.field || !EDITABLE_SECTIONS.has(target.section)) return null
  return { fieldKey: target.key, sectionKey: target.section, field: target.field, label: target.label || fieldKey }
}

/** ProfileDetail "Pipeline" tab, flashing the Saved portal logins card. */
function savedLoginsHref(blocker) {
  return withFlashParam(
    createPageUrl("ProfileDetail", { id: blocker?.profile_id, tab: "pipeline" }),
    "saved-logins",
  )
}

/** The Master Pipeline scoped to the profile, flashing the cards that need a
 *  person (where the Hamilton task drawer is opened to review/approve/sign). */
function humanReviewHref(blocker) {
  return withFlashParam(
    createPageUrl("Pipeline", { profile_id: blocker?.profile_id }),
    "human-review",
  )
}

/** The exact profile section editor for a missing field, else the profile tab. */
function profileFieldHref(blocker) {
  const key = blockerFieldKey(blocker)
  const link = key ? buildProfileSectionLink(blocker?.profile_id, key) : null
  return link || createPageUrl("ProfileDetail", { id: blocker?.profile_id, tab: "profile" })
}

/** Fallback used for any blocker_type we have not explicitly mapped. */
export const UNKNOWN_TARGET = Object.freeze({
  actionLabel: "Review the blocker",
  fixedWhere: "Master Pipeline",
  instructions: [
    "Hamilton hit a stop she could not classify automatically.",
    "Open the flagged application and review the captured page.",
    "Resolve it manually, then mark this item done.",
  ],
  href: humanReviewHref,
})

/**
 * blocker_type → where-to-go + what-to-do. Ordered to mirror BLOCKER_PROFILE.
 */
export const HARD_STOP_TARGETS = Object.freeze({
  missing_required_information: {
    actionLabel: "Add the missing info",
    fixedWhere: "Profile section editor",
    instructions: [
      "Open the highlighted profile section.",
      "Fill in the missing field and click Save.",
      "Hamilton re-uses the value on this and every future portal.",
    ],
    href: profileFieldHref,
  },
  ambiguous_required_field: {
    actionLabel: "Confirm the field value",
    fixedWhere: "Profile section editor",
    instructions: [
      "Open the highlighted profile section.",
      "Provide the value Hamilton could not confidently map, then Save.",
      "She reuses your answer for future portals automatically.",
    ],
    href: profileFieldHref,
  },
  missing_required_document: {
    actionLabel: "Upload the document",
    fixedWhere: "Profile → Documents tab",
    instructions: [
      "Open the Documents tab for this profile.",
      "Upload the requested document with a clear, descriptive name.",
      "Hamilton attaches it to the application on her next run.",
    ],
    href: (b) => createPageUrl("ProfileDetail", { id: b?.profile_id, tab: "documents" }),
  },
  login_required: {
    actionLabel: "Add the saved login",
    fixedWhere: "Profile → Saved portal logins",
    instructions: [
      "Open the Saved portal logins card on the profile's Pipeline tab.",
      "Add (or update) the username and password for this portal.",
      "Hamilton reuses the saved session — she never types your password live.",
    ],
    href: savedLoginsHref,
  },
  sso_required: {
    actionLabel: "Sign in & save the session",
    fixedWhere: "Profile → Saved portal logins",
    instructions: [
      "Sign in once with your university SSO account in the portal.",
      "Save the resulting session on the Saved portal logins card.",
      "Hamilton cannot complete SSO herself, but she reuses the saved session.",
    ],
    href: savedLoginsHref,
  },
  two_factor_required: {
    actionLabel: "Complete 2FA & save session",
    fixedWhere: "Portal + Saved portal logins",
    instructions: [
      "Open the portal and sign in, completing the 2FA prompt yourself.",
      'Choose "trust this device" if the portal offers it.',
      "Save the session on the Saved logins card — Hamilton never intercepts codes.",
    ],
    href: savedLoginsHref,
  },
  captcha_required: {
    actionLabel: "Solve CAPTCHA & save session",
    fixedWhere: "Portal + Saved portal logins",
    instructions: [
      "Open the portal and solve the CAPTCHA yourself.",
      "Save the resulting session on the Saved portal logins card.",
      "Hamilton resumes from the saved session — she never solves CAPTCHAs.",
    ],
    href: savedLoginsHref,
  },
  payment_required: {
    actionLabel: "Review & approve payment",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "Open the flagged application card and review the required fee.",
      "Approve the payment within the pre-authorized envelope.",
      "Hamilton only ever charges exactly what you explicitly approve.",
    ],
    href: humanReviewHref,
  },
  legal_attestation_required: {
    actionLabel: "Review attestation",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "Open the flagged application and read the attestation language.",
      "Confirm it is true and accurate for this profile.",
      "Approve it so Hamilton can continue.",
    ],
    href: humanReviewHref,
  },
  wet_signature_required: {
    actionLabel: "Print, sign & upload",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "Open the flagged application and download the prepared packet.",
      "Print it, sign by hand, then upload the signed copy back.",
      "Hamilton resumes once the signed packet is attached.",
    ],
    href: humanReviewHref,
  },
  digital_signature_required: {
    actionLabel: "E-sign in the portal",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "Open the portal where Hamilton paused at the signature step.",
      "Apply your electronic signature yourself — Hamilton never signs for you.",
      "Mark this item done so Hamilton can finish the rest.",
    ],
    href: humanReviewHref,
  },
  portal_terms_block: {
    actionLabel: "Review & submit manually",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "This portal's terms disallow automation, so Hamilton built a packet instead.",
      "Open the flagged application, download the packet, and submit it manually.",
      "Mark it submitted to clear the stop.",
    ],
    href: humanReviewHref,
  },
  portal_anti_bot_block: {
    actionLabel: "Submit manually or save a session",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "The portal blocked automated access — Hamilton never bypasses anti-bot controls.",
      "Either submit the prepared packet manually, or add a saved login session and retry.",
      "Mark this item done once it is handled.",
    ],
    href: humanReviewHref,
  },
  final_review_screen: {
    actionLabel: "Do the final review",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "Hamilton paused at the final review screen.",
      "Open the flagged application and confirm everything looks right.",
      "Approve so Hamilton can submit.",
    ],
    href: humanReviewHref,
  },
  deadline_expired: {
    actionLabel: "Find an alternate",
    fixedWhere: "Master Pipeline",
    instructions: [
      "This funding source's deadline has already passed.",
      "Delete it from the pipeline, or pursue a related still-open opportunity.",
      "Hamilton will not spend cycles on it unless you override.",
    ],
    href: (b) => createPageUrl("Pipeline", { profile_id: b?.profile_id }),
  },
  portal_unreachable: {
    actionLabel: "Verify portal link",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "Hamilton could not reach the funder's website — the site may be down or the saved link may be outdated.",
      "Check the application URL; update it if the funder moved, or remove the source if the site is gone.",
      "Retry Hamilton once the link loads in your browser.",
    ],
    href: (b) => createPageUrl("Pipeline", { profile_id: b?.profile_id }),
  },
  unknown_application_method: {
    actionLabel: "Review contact packet",
    fixedWhere: "Pipeline → flagged application",
    instructions: [
      "Hamilton could not determine how to apply, so she prepared a funder-contact packet.",
      "Open the flagged application and use it to confirm the application method with the funder.",
      "Mark it handled once submitted.",
    ],
    href: humanReviewHref,
  },
  unknown: UNKNOWN_TARGET,
})

/**
 * Resolve a blocker to its checklist target. Always returns a usable spec —
 * unmapped types fall back to UNKNOWN_TARGET so the list never renders a
 * dead-end item.
 *
 * @param {object} blocker a row shaped by hamiltonBlockerStore.rowToBlocker
 * @returns {{ actionLabel: string, fixedWhere: string, instructions: string[], href: string }}
 */
export function resolveHardStopTarget(blocker) {
  const spec = HARD_STOP_TARGETS[blocker?.blocker_type] || UNKNOWN_TARGET
  return {
    actionLabel: spec.actionLabel,
    fixedWhere: spec.fixedWhere,
    instructions: spec.instructions,
    href: typeof spec.href === "function" ? spec.href(blocker) : spec.href,
  }
}

export default { HARD_STOP_TARGETS, UNKNOWN_TARGET, resolveHardStopTarget, resolveInlineField }
