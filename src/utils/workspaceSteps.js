import { calculateProfileCompletion } from "@/utils/profileCompletion"

// ---------------------------------------------------------------------------
// Single source of truth for the Workspace "work the profile in order" steps.
//
// BOTH the pulsing/green step cards in ProfileDetail AND Anya's next-step
// guidance consume this module, so they can never disagree about which step is
// done (green) or which one the user should do next (pulse + Anya's nudge).
//
// A step is ONLY complete when the underlying data truly says so — green is a
// FACT read off the profile, never a stamp. The completion signals live on the
// profile detail payload:
//   - profile.sections            → Profile facts   (calculateProfileCompletion)
//   - profile.document_count       → Documents
//   - profile.action_plan_count    → Anya plan (a generated project action plan)
//   - profile.pipeline_count       → Portals & pipeline (active pipeline grants)
// ---------------------------------------------------------------------------

// Ordered funnel: facts → documents → plan → pipeline. `tab` matches the
// Workspace `<Tabs>` value so a consumer can deep-link the step.
export const WORKSPACE_STEPS = [
  {
    key: "profile",
    tab: "profile",
    title: "Profile facts",
    detail: "Identity, needs, eligibility, and location.",
    // Anya's voice — plainspoken, low-pressure (PRODUCT.md brand personality).
    anyaHint:
      "Start with the profile facts — the more GrantFlow knows about identity, needs, eligibility, and location, the more real funding it can match.",
    actionLabel: "Fill in profile facts",
  },
  {
    key: "documents",
    tab: "documents",
    title: "Documents",
    detail: "Uploads, parsed evidence, forms, and printouts.",
    anyaHint:
      "Add a document or two next — uploads like letters, bills, or transcripts give me real evidence to sharpen matches and let Hamilton fill out forms.",
    actionLabel: "Add documents",
  },
  {
    key: "action-plan",
    tab: "action-plan",
    title: "Anya plan",
    detail: "Interview, checklist, and next practical steps.",
    anyaHint:
      "Let's build the Anya plan — I'll turn everything on the profile into an exact, workable checklist of next steps.",
    actionLabel: "Open the Anya plan",
  },
  {
    key: "pipeline",
    tab: "pipeline",
    title: "Portals & pipeline",
    detail: "Logins, funding sources, and applications.",
    anyaHint:
      "Now let's work the pipeline — set up portal logins and move your matched funding sources toward submitted applications.",
    actionLabel: "Open portals & pipeline",
  },
]

export const WORKSPACE_STEP_KEYS = WORKSPACE_STEPS.map((step) => step.key)

function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// True only when the profile's own data proves the step is done. Any missing
// signal reads as NOT complete (never optimistically green).
export function isStepComplete(stepKey, profile) {
  if (!profile) return false
  switch (stepKey) {
    case "profile": {
      const completion = calculateProfileCompletion(profile)
      // All applicable sections carry a meaningful value (there is nothing left
      // to fill). A profile with zero applicable sections is not "complete".
      return completion.totalSections > 0 && completion.nextIncompleteSectionKey === null
    }
    case "documents":
      return toCount(profile.document_count) > 0
    case "action-plan":
      return toCount(profile.action_plan_count) > 0
    case "pipeline":
      return toCount(profile.pipeline_count) > 0
    default:
      return false
  }
}

// The single NEXT logical step: the first incomplete step in funnel order.
// Returns the step object (or null when every step is complete).
export function getNextIncompleteStep(profile) {
  return WORKSPACE_STEPS.find((step) => !isStepComplete(step.key, profile)) ?? null
}

// Full status for the step cards: each step tagged complete/next, plus a
// rollup. `nextStepKey` is the ONE step that should pulse; everything past it
// stays neutral so only a single step draws the eye at a time.
export function getWorkspaceStepStatus(profile) {
  const nextStep = getNextIncompleteStep(profile)
  const steps = WORKSPACE_STEPS.map((step) => ({
    ...step,
    complete: isStepComplete(step.key, profile),
    isNext: nextStep ? step.key === nextStep.key : false,
  }))
  return {
    steps,
    nextStepKey: nextStep ? nextStep.key : null,
    nextStep,
    completedCount: steps.filter((step) => step.complete).length,
    totalCount: steps.length,
    allComplete: nextStep === null,
  }
}
