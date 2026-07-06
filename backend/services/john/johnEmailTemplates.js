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
 *   - Annie / GrantFlow signature (Annie@axiombiolabs.org)
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
  // Funding-lane subjects: the lead-in names the CATEGORY of funding GrantFlow
  // would actually surface for this kind of org ("Fire and EMS grant options
  // for Riverbend VFD"). Specific, honest, never clickbait.
  '{{FUNDING_LANE_SUBJECT}} for {{ORGANIZATION_NAME}}',
]

export const OPT_OUT_LINE = `If this is not relevant, just reply "no thanks" and I won't follow up.`

/**
 * The "no conflict with your grant writer" paragraph (owner directive,
 * 2026-07-06). Many recipients already have a grant writer or consultant
 * under contract; the email must acknowledge that professionally and make
 * the risk-free mechanics explicit: the 7-day free trial means LOOKING
 * involves no money changing hands (so it cannot breach an existing
 * agreement), and if they like GrantFlow there is never a contract — just
 * weekly, biweekly, or monthly billing. Present in BOTH composer paths
 * (deterministic template + AI footer) so every draft carries it verbatim.
 */
export function buildNoConflictParagraph(orgName) {
  const org = String(orgName || '').trim() || 'your organization'
  return (
    `And if ${org} already works with a grant writer or has a consultant under contract, that is a good position to be in, and nothing here asks you to change it. ` +
    `GrantFlow starts with a 7-day free trial, so you can see everything it finds with no money changing hands, and simply looking will not step on any agreement you have in place. ` +
    `If you like what you see, consider us: we never require a contract, and billing is weekly, biweekly, or monthly, whichever suits you.`
  )
}

/**
 * Body template.
 *
 * The writer (johnEmailWriter) composes {{OPENING_LINE}}, {{VALUE_PARAGRAPH}},
 * and {{CTA_PARAGRAPH}} grammatically from whatever specific facts Yana
 * supplied, plus the funding lane matched in johnFundingLanes — so a fire
 * department reads about equipment and AFG-style programs while a food pantry
 * reads about food-security funders, and neither ever gets filler like
 * "…work around community-focused funding work".
 *
 * Structure (MBA-level, one idea per paragraph):
 *   1. Hook grounded in the org's OWN evidence (their words, not ours).
 *   2. Value: the funding categories GrantFlow would surface for THEM, and
 *      what the platform actually does.
 *   3. Honest origin story, brief, told in the third person about Dr. White.
 *   4. One crisp call-to-action (talk to Anya, live scan, no commitment).
 *
 * The compliant footer (signature, opt-out line, postal address) is always
 * present verbatim.
 */
const DEFAULT_BODY_TEMPLATE = [
  '{{SALUTATION}}',
  '',
  '{{OPENING_LINE}}',
  '',
  '{{VALUE_PARAGRAPH}}',
  '',
  'I should be straight about where GrantFlow comes from. Our founder, Dr. John White, never set out to build software. He built it to fund his own research lab, Axiom BioLabs. When it worked, he pointed the same engine at the nonprofit and ministry work he cares about, and later at scholarships and college funding for his own kids. The lesson never changed: the work was never the hard part. Paying for it was.',
  '',
  '{{NO_CONFLICT_PARAGRAPH}}',
  '',
  '{{CTA_PARAGRAPH}}',
  '',
  '{{PROSPECT_LINK}}',
  '',
  'Warmly,',
  '',
  'Annie',
  'GrantFlow (founded by Dr. John White at Axiom BioLabs)',
  'Annie@axiombiolabs.org',
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

export function pickSubjectTemplate({ organization_name, evidence_topic, funding_lane_subject } = {}) {
  // Best: a lane-specific subject that names both the funding category and the
  // org ("Fire and EMS grant options for Riverbend VFD") — personal, specific,
  // and honest about why we are writing.
  if (funding_lane_subject && organization_name) {
    return '{{FUNDING_LANE_SUBJECT}} for {{ORGANIZATION_NAME}}'
  }
  // Next: a specific project/need topic short enough to be a subject.
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
