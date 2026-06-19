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

const OPT_OUT_LINE = `If this is not relevant, you can reply "no thanks" and I will not follow up.`

const DEFAULT_BODY_TEMPLATE = [
  '{{SALUTATION}}',
  '',
  'I came across {{ORGANIZATION_NAME}} while looking at organizations doing meaningful work around {{EVIDENCE_TOPIC}}.',
  '',
  'I\u2019m Dr. John White, founder of GrantFlow. I didn\u2019t set out to build a product \u2014 I first built GrantFlow to fund my own research lab, Axiom BioLabs. It worked well enough that I began using the same engine for the mission and nonprofit work I\u2019m part of, and later to find scholarships and college-endowment opportunities for my own kids. Each time the pattern was the same: the work itself was never the hard part \u2014 finding the funding to sustain it was. That\u2019s the gap GrantFlow was built to close.',
  '',
  'What caught my attention about you was {{EVIDENCE_DETAIL}}. In practice, GrantFlow builds a profile of an organization \u2014 mission, location, focus areas, eligibility \u2014 and matches it to grants, foundation programs, scholarships, and other funding sources that genuinely fit, then keeps deadlines, documents, and progress organized in one place.',
  '',
  'Rather than describe it, I\u2019d rather you see it on your own terms. The link below opens a short conversation with Anya, our assistant; she\u2019ll learn about {{ORGANIZATION_NAME}} and run a live funding scan so you can see the kinds of matches it surfaces \u2014 no account needed to take a look. If what comes back looks worth it, you can decide from there whether to go further:',
  '',
  '{{PROSPECT_LINK}}',
  '',
  'Respectfully,',
  '',
  'Dr. John White',
  'GrantFlow / Axiom BioLabs',
  'GrantFlow@axiombiolabs.org',
  '',
  OPT_OUT_LINE,
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
