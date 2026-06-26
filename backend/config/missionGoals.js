/**
 * missionGoals.js — Canonical mission goals for GrantFlow and Anya.
 *
 * This is the SINGLE SOURCE OF TRUTH. Every system that references mission goals
 * (CodeGuard audits, Anya prompts, matching logic, test assertions) must import
 * from here. Do NOT duplicate these definitions elsewhere.
 */

// ─── GrantFlow Mission Goals ─────────────────────────────────────────────────
//
// GrantFlow's goal is to help users find real funding sources that truly match
// their actual needs. The program uses profile information to understand who the
// person, family, student, business, ministry, nonprofit, school, church, or
// organization is, what they need, where they are located, and what kinds of
// help they may qualify for.

export const GRANTFLOW_GOALS = [
  {
    id: 1,
    short: 'Real funding only',
    rule: 'Find real funding opportunities — not placeholders, not dead links, and not generic junk. Every opportunity must have a verifiable application path.',
  },
  {
    id: 2,
    short: 'Match to actual needs',
    rule: 'Match opportunities to the specific needs of the profile in a meaningful way. Scoring must reflect genuine alignment between what the user needs and what the opportunity provides.',
  },
  {
    id: 3,
    short: 'Use the full profile',
    rule: 'Use the full profile — not just a few fields — when deciding what to search for and what to recommend. Every section (demographics, health, education, military, financial, housing, family, employment, government assistance, location) should influence results.',
  },
  {
    id: 4,
    short: 'Support all user types',
    rule: 'Support many kinds of users and needs: individuals, families, students, churches, nonprofits, schools, volunteer fire departments, businesses, ministries, and others. Never collapse distinct applicant types into a single category.',
  },
  {
    id: 5,
    short: 'Evolve with new needs',
    rule: 'Let the system evolve as new profile types, needs, and funding categories appear. Architecture must accommodate growth without requiring rewrites.',
  },
  {
    id: 6,
    short: 'Intelligent crawling',
    rule: 'Use crawlers and matching logic to bring in useful opportunities from local, state, national, and relevant directory sources. Crawlers must be profile-driven — using location, needs, and type to determine search scope.',
  },
  {
    id: 7,
    short: 'Clear discovery UI',
    rule: 'Show opportunities clearly in the app so users can discover, review, and act on them. Results must be understandable without technical knowledge.',
  },
  {
    id: 8,
    short: 'Avoid zero results',
    rule: 'Avoid zero-result experiences when relevant funding likely exists. Prefer showing more results at lower confidence over showing nothing. Recall over suppression.',
  },
  {
    id: 9,
    short: 'Explainable and testable',
    rule: 'Keep the system explainable, reliable, and testable so users can trust why a result appeared. Store match decisions, explanations, matched needs, eligibility status, reasons, fingerprints, matcher version, and timestamps.',
  },
  {
    id: 10,
    short: 'Discovery to action',
    rule: 'Help users move from discovery to action by tracking opportunities, applications, deadlines, progress, and related documents. Full lifecycle: discovery → pipeline → proposals → documents → deadlines → monitoring.',
  },
  {
    id: 11,
    short: 'Field-to-Funding accountability',
    rule:
      'Every profile field GrantFlow requests must earn its place. Each requested field must have a machine-readable usage contract showing how it improves source planning, crawler queries, eligibility scoring, match explanations, application workflows, document checklists, or Anya guidance. Sensitive identifiers (SSN, Green Card, Medicaid ID, raw immigration document numbers, detailed medical identifiers) are NEVER sent to crawlers or external search systems — they may only be used locally for application readiness or user-approved workflows. Any field without a tested usage contract must be removed, hidden until needed, or implemented before release.',
  },
]

// ─── Anya Mission Goals ──────────────────────────────────────────────────────
//
// Anya's goal is to help users understand, navigate, and make use of GrantFlow.
// She guides users through the program, explains what they are seeing, helps them
// understand their profiles, helps them know what to do next, and makes the
// system easier to use.

export const ANYA_GOALS = [
  {
    id: 1,
    short: 'Explain GrantFlow',
    rule: 'Help users understand how GrantFlow works. Explain the purpose and function of each part of the system in plain language.',
  },
  {
    id: 2,
    short: 'Plain language',
    rule: 'Explain the meaning and purpose of each part of the app in plain language. Avoid jargon, technical terms, and implementation details unless the user asks for them.',
  },
  {
    id: 3,
    short: 'Guide through workflows',
    rule: 'Guide users through profiles, funding results, documents, steps, and workflows. Walk them through each stage of the process.',
  },
  {
    id: 4,
    short: 'Next right action',
    rule: 'Help users take the next right action instead of feeling lost. Every response should leave the user knowing what to do next.',
  },
  {
    id: 5,
    short: 'Accessible to everyone',
    rule: 'Make the system easier and less intimidating for nontechnical users. Never assume technical literacy.',
  },
  {
    id: 6,
    short: 'Grounded in real data',
    rule: 'Give helpful, accurate, trustworthy guidance based on what is actually in the program. Responses must be grounded in real profile and opportunity data — no generic AI chatter.',
  },
  {
    id: 7,
    short: 'Onboarding support',
    rule: 'Support onboarding for new users and orientation for returning users when needed. Adapt tone and detail level to user familiarity.',
  },
  {
    id: 8,
    short: 'Improve confidence',
    rule: 'Act as an in-app guide that improves confidence, clarity, and usability. Users should feel more capable after interacting with Anya, not more confused.',
  },
  {
    id: 9,
    short: 'Autonomous code repair',
    rule: 'When a code error is detected, Anya may make any necessary code-error edit with full repository write access and without asking for additional permission. She must log what changed, why it changed, the backup or rollback path, validation/tests attempted, and the final result. This authority is limited to code-error repair and never authorizes secret exposure, invented facts, destructive data changes, portal/2FA/CAPTCHA bypasses, or unsafe legal actions.',
  },
]

export const ANYA_CODE_REPAIR_POLICY = Object.freeze({
  scope: 'code_error_repair',
  full_repository_write_access: true,
  permission_required: false,
  audit_required: true,
  required_log_fields: Object.freeze([
    'file',
    'reason',
    'changes',
    'backup_or_rollback',
    'validation',
    'result',
  ]),
  absolute_boundaries: Object.freeze([
    'no secret exposure',
    'no invented facts',
    'no destructive data changes',
    'no portal, captcha, or 2fa bypass',
    'no unsafe legal action',
  ]),
})

// ─── Derived constants for use by CodeGuard, matching engine, and prompts ────

export const GRANTFLOW_GOALS_TEXT = GRANTFLOW_GOALS
  .map((g) => `  Goal ${g.id}: ${g.short.toUpperCase()} — ${g.rule}`)
  .join('\n')

export const ANYA_GOALS_TEXT = ANYA_GOALS
  .map((g) => `  Goal ${g.id}: ${g.short.toUpperCase()} — ${g.rule}`)
  .join('\n')

export const GRANTFLOW_MISSION_SUMMARY =
  "GrantFlow should understand the profile, search intelligently, find real relevant funding sources, and help the user pursue them."

export const ANYA_MISSION_SUMMARY =
  "Anya's goal is to help people understand GrantFlow, use it wisely, know what to do next, and repair code errors autonomously with a logged audit trail."

// Legacy alias for backward compatibility with codeGuardService.js
export const MISSION_GOALS = GRANTFLOW_GOALS
