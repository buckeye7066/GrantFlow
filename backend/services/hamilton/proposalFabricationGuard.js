/**
 * proposalFabricationGuard.js — deterministic identity-claim gate for
 * Hamilton's drafted proposals.
 *
 * The proposal prompt orders the LLM to ground every claim in the evidence
 * pack, but prompt-level rules are advisory: in production Hamilton drafted
 * "As a member of the LGBTQ+ community, I face unique challenges..." for an
 * applicant whose profile says nothing of the kind — a fabricated
 * protected-identity claim shaped to fit the funder's priorities. Submitting
 * that is application fraud. Same defect class as the portal-sync extractor's
 * fabricated awards (PR #825): an LLM asked to align with a rubric will invent
 * the alignment, so the honesty rule must be enforced by deterministic code at
 * a choke point, not by the prompt.
 *
 * The guard scans each drafted section for FIRST-PERSON claims of a protected
 * or eligibility-bearing identity (LGBTQ+, veteran/military, ethnicity
 * buckets, disability, gender, first-generation). A claim with no supporting
 * token anywhere in the applicant's evidence pack has its sentence replaced by
 * the standard "[ EVIDENCE NEEDED: ... ]" placeholder and a required
 * evidence-gap entry. That plugs into the existing contract: placeholder-
 * bearing sections are already barred from live portal fields
 * (buildPortalNarrativeAnswers) and print as missing-info markers in
 * reviewable packets — so an unevidenced identity claim can no longer reach a
 * funder in Hamilton's voice.
 *
 * Precision over recall by design: patterns match only affirmative
 * first-person identity claims ("as a veteran", "I identify as..."), never
 * topical mentions ("this scholarship serves LGBTQ+ students").
 */

/**
 * Identity classes: `claims` match first-person assertions in drafted prose;
 * `evidence` matches any supporting signal in the profile evidence pack.
 */
const IDENTITY_CLASSES = [
  {
    key: 'lgbtq',
    label: 'LGBTQ+ identity',
    claims: [
      /\b(?:as|being)\s+(?:a|an)\s+(?:proud\s+)?(?:member\s+of\s+the\s+)?lgbtq?\+?(?:ia\+?)?\s*(?:community|individual|student|person|applicant)?\b/i,
      /\bI\s+(?:am|identify\s+as)\s+(?:a\s+|an\s+)?(?:proud\s+)?(?:gay|lesbian|bisexual|transgender|queer|non-?binary|lgbtq?\+?)\b/i,
      /\bmy\s+(?:lgbtq?\+?|queer|transgender)\s+(?:identity|community|experience)\b/i,
      /\bcontributing\s+to\s+the\s+lgbtq?\+?\s+community\b/i,
    ],
    evidence: /lgbt|gay|lesbian|bisexual|transgender|queer|non-?binary|same[- ]sex/i,
  },
  {
    key: 'veteran',
    label: 'veteran / military service',
    claims: [
      /\bas\s+(?:a|an)\s+(?:u\.?s\.?\s+)?(?:military\s+)?veteran\b/i,
      /\bI\s+(?:am\s+a\s+veteran|served\s+in\s+the\s+(?:military|armed\s+forces|army|navy|air\s+force|marines|coast\s+guard|national\s+guard))\b/i,
      /\bmy\s+(?:military\s+service|time\s+in\s+the\s+(?:army|navy|air\s+force|marines|service))\b/i,
    ],
    evidence: /veteran|military|armed forces|\barmy\b|\bnavy\b|air force|marine|coast guard|national guard|discharge/i,
  },
  {
    key: 'ethnicity_black',
    label: 'African-American/Black identity',
    claims: [
      /\b(?:as|being)\s+(?:a|an)\s+(?:proud\s+)?(?:african[- ]american|black)\s+(?:student|individual|person|applicant|man|woman)\b/i,
      /\bI\s+identify\s+as\s+(?:african[- ]american|black)\b/i,
    ],
    evidence: /african[- ]?american|\bblack\b/i,
  },
  {
    key: 'ethnicity_hispanic',
    label: 'Hispanic/Latino identity',
    claims: [
      /\b(?:as|being)\s+(?:a|an)\s+(?:proud\s+)?(?:hispanic|latino|latina|latinx)\s+(?:student|individual|person|applicant|man|woman)?\b/i,
      /\bI\s+identify\s+as\s+(?:hispanic|latino|latina|latinx)\b/i,
      /\bmy\s+(?:hispanic|latino|latina)\s+heritage\b/i,
    ],
    evidence: /hispanic|latin[oax]/i,
  },
  {
    key: 'ethnicity_native',
    label: 'Native American / tribal identity',
    claims: [
      /\b(?:as|being)\s+(?:a|an)\s+(?:enrolled\s+)?(?:member\s+of\s+(?:a|the)\s+)?(?:native\s+american|american\s+indian|tribal?)\s*(?:tribe|nation|student|individual|person|applicant|member)?\b/i,
      /\bI\s+identify\s+as\s+(?:native\s+american|american\s+indian|indigenous)\b/i,
    ],
    evidence: /native american|american indian|indigenous|tribal|tribe|alaska native/i,
  },
  {
    key: 'disability',
    label: 'disability status',
    claims: [
      /\bas\s+(?:a|an)\s+(?:disabled\s+(?:student|person|individual|applicant|veteran)|person\s+with\s+a\s+disability)\b/i,
      /\bI\s+(?:have|live\s+with)\s+a\s+(?:disability|chronic\s+illness)\b/i,
      /\bmy\s+disability\b/i,
    ],
    evidence: /disab|chronic illness|chronic condition|wheelchair|\bblind\b|\bdeaf\b|adaptive|assistive|iep\b|504 plan/i,
  },
  {
    key: 'gender_female',
    label: 'female/woman identity',
    claims: [
      /\bas\s+a\s+(?:young\s+)?woman\b/i,
      /\bas\s+a\s+female\s+(?:student|applicant|engineer|scientist)\b/i,
    ],
    evidence: /\bfemale\b|\bwoman\b|\bshe\/her\b|gender[^a-z0-9]{0,10}f\b/i,
  },
  {
    key: 'first_generation',
    label: 'first-generation college student status',
    claims: [
      /\bas\s+a\s+first[- ]generation\s+college\s+student\b/i,
      /\bI\s+am\s+(?:a\s+)?first[- ]generation\b/i,
    ],
    evidence: /first[- ]?gen/i,
  },
]

/** Split prose into sentences conservatively (keeps delimiters). */
function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/)
}

/**
 * Scan drafted proposal sections for first-person identity claims that have no
 * support in the evidence pack; replace each offending SENTENCE with the
 * standard evidence placeholder and record a required evidence gap.
 *
 * @param {{sections: Array<{key,title,content,evidence_gaps}>, evidence_gaps: Array}} proposal
 *        normalizeProposal output (mutated copy is returned, input untouched)
 * @param {object|string} evidencePack buildEvidencePack output (or any blob of
 *        profile-derived text) — the ONLY ground truth for identity claims
 * @returns {{ proposal: object, flags: Array<{class:string,label:string,section:string,claim:string}> }}
 */
export function applyFabricationGuard(proposal, evidencePack) {
  const evidenceText = typeof evidencePack === 'string'
    ? evidencePack
    : JSON.stringify(evidencePack || {})
  const flags = []

  const unevidenced = IDENTITY_CLASSES.filter((c) => !c.evidence.test(evidenceText))
  if (unevidenced.length === 0) return { proposal, flags }

  const sections = (proposal?.sections || []).map((section) => {
    const sentences = splitSentences(section.content)
    let changed = false
    const gaps = [...(section.evidence_gaps || [])]
    const out = sentences.map((sentence) => {
      for (const cls of unevidenced) {
        if (cls.claims.some((rx) => rx.test(sentence))) {
          changed = true
          flags.push({
            class: cls.key,
            label: cls.label,
            section: section.key,
            claim: sentence.trim().slice(0, 200),
          })
          gaps.push({
            kind: 'field',
            key: `identity_${cls.key}`,
            label: `Unverified ${cls.label} claim removed`,
            description: `The draft asserted ${cls.label}, but the profile contains no supporting evidence. Confirm with the applicant before any such claim is made — never assert it to fit a funder's priorities.`,
            required: true,
          })
          return `[ EVIDENCE NEEDED: profile does not document ${cls.label} — confirm with the applicant before claiming it ]`
        }
      }
      return sentence
    })
    if (!changed) return section
    return { ...section, content: out.join(' '), evidence_gaps: gaps }
  })

  if (flags.length === 0) return { proposal, flags }

  // Merge new gaps into the top-level de-duplicated set.
  const seen = new Set((proposal.evidence_gaps || []).map((g) => g.key))
  const evidenceGaps = [...(proposal.evidence_gaps || [])]
  for (const s of sections) {
    for (const g of s.evidence_gaps || []) {
      if (seen.has(g.key)) continue
      seen.add(g.key)
      evidenceGaps.push(g)
    }
  }

  return {
    proposal: { ...proposal, sections, evidence_gaps: evidenceGaps },
    flags,
  }
}

export default { applyFabricationGuard }
