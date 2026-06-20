/**
 * John — email templates.
 *
 * The agent does not free-form generate; every email is a deterministic
 * fill-in of one of these named templates. That keeps the safety surface
 * small (we know exactly which placeholders exist), makes review predictable,
 * and lets the unit tests assert against expected substrings.
 *
 * All templates explicitly include:
 *   - opt-out language ("If this is not relevant, you can reply 'no thanks'…")
 *   - Dr. John White / GrantFlow signature
 *   - {{PHYSICAL_ADDRESS}} placeholder for the configured postal address
 *
 * Subject templates are also enumerated so we can map each lead to an
 * accurate, non-deceptive subject.
 */

export const APPROVED_SUBJECT_TEMPLATES = [
  'Possible funding help for {{ORGANIZATION_NAME}}',
  'Funding discovery idea for {{ORGANIZATION_NAME}}',
  'A possible GrantFlow fit for {{ORGANIZATION_NAME}}',
  'Grant and funding search help for {{ORGANIZATION_NAME}}',
  'Quick note about {{PROJECT_OR_NEED}}',
]

export const OPT_OUT_LINE = `If this is not relevant, just reply "no thanks" and I won't follow up.`

/**
 * Body template.
 *
 * {{OPENING_LINE}} and {{ATTENTION_LINE}} are composed grammatically by the
 * writer (johnEmailWriter) from whatever specific facts Yana supplied, so the
 * email never renders the old "\u2026work around community-focused funding work"
 * redundancy or the clumsy "what caught my attention about you was \u2026". When the
 * facts are thin, ATTENTION_LINE is empty and the paragraph still reads cleanly
 * (it flows straight into "Here is the short version:").
 *
 * Voice: an experienced, plain-spoken founder with an MBA \u2014 warm, specific,
 * and free of hype. The compliant footer (opt-out + postal address) is always
 * present verbatim.
 */
const DEFAULT_BODY_TEMPLATE = [
  '{{SALUTATION}}',
  '',
  '{{OPENING_LINE}}',
  '',
  'I\u2019m Dr. John White, the founder of GrantFlow, and I\u2019ll be honest about where it came from. I didn\u2019t set out to build software. I built it to fund my own research lab, Axiom BioLabs. When it actually worked, I started pointing the same engine at the nonprofit and ministry work I care about, and later at scholarships and college funding for my own kids. Every time, the lesson was the same: the work was never the hard part. Paying for it was. That\u2019s the gap GrantFlow was built to close.',
  '',
  '{{ATTENTION_LINE}}Here is the short version: GrantFlow builds a funding profile of an organization (its mission, location, focus areas, and eligibility) and matches that against grants, foundation programs, scholarships, and other funding that genuinely fits. Then it keeps every deadline, document, and application moving in one place, so nothing slips through the cracks.',
  '',
  'I\u2019d rather you judge it for yourself than take my word for it. The link below opens a short conversation with Anya, our assistant. She\u2019ll learn about {{ORGANIZATION_NAME}} and run a live funding scan so you can see the kind of matches it surfaces, no account needed just to look. If what comes back looks worth your time, you can take the next step from there:',
  '',
  '{{PROSPECT_LINK}}',
  '',
  'Respectfully,',
  '',
  'Dr. John White',
  'Founder, GrantFlow / Axiom BioLabs',
  'GrantFlow@axiombiolabs.org',
  '',
  '{{OPT_OUT_LINE}}',
  '',
  '{{PHYSICAL_ADDRESS}}',
].join('\n')

/**
 * Per-organisation-type variants. The body shape stays the same — only the
 * "kind of mission GrantFlow is being built to support" framing tightens up
 * so the email feels written for that type of org.
 *
 * The keys map to lowered snippets that may appear in lead.organization_type.
 */
const TYPE_FRAMINGS = {
  church:
    'churches, ministries, and faith-based outreach groups',
  ministry:
    'churches, ministries, and faith-based outreach groups',
  nonprofit:
    'nonprofits doing direct community work',
  fire:
    'volunteer fire departments and small public-safety teams',
  vfd:
    'volunteer fire departments and small public-safety teams',
  school:
    'schools, classrooms, and PTOs/booster clubs',
  booster:
    'schools, classrooms, and PTOs/booster clubs',
  pantry:
    'food pantries, free clinics, and direct-service nonprofits',
  food_pantry:
    'food pantries, free clinics, and direct-service nonprofits',
  business:
    'small businesses, sole proprietors, and community-rooted ventures',
  family:
    'families and individuals navigating real-life funding needs',
  student:
    'students and families pursuing scholarships, grants, and education benefits',
  community_org:
    'community organizations doing on-the-ground work',
}

function frameForType(orgType) {
  if (!orgType) return null
  const lower = String(orgType).toLowerCase()
  for (const [needle, framing] of Object.entries(TYPE_FRAMINGS)) {
    if (lower.includes(needle)) return framing
  }
  return null
}

export const TEMPLATES = Object.freeze({
  default: {
    name: 'default',
    subjects: APPROVED_SUBJECT_TEMPLATES,
    body: DEFAULT_BODY_TEMPLATE,
  },
})

export function pickSubjectTemplate({ organization_name, evidence_topic } = {}) {
  // If we have a specific project/need topic short enough to be a subject,
  // prefer the "Quick note about" form.
  if (evidence_topic && String(evidence_topic).length <= 50) {
    return 'Quick note about {{PROJECT_OR_NEED}}'
  }
  if (organization_name) {
    return 'Possible funding help for {{ORGANIZATION_NAME}}'
  }
  return APPROVED_SUBJECT_TEMPLATES[0]
}

export function fillTemplate(template, vars = {}) {
  return String(template || '').replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    const v = vars[key]
    if (v === null || v === undefined) return ''
    return String(v)
  })
}

export { frameForType }
