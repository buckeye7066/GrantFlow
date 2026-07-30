#!/usr/bin/env node
import fs from 'node:fs'

const files = Object.freeze({
  webLane: 'backend/crawler-os/webLane.js',
  report: 'backend/services/amy/amyReport.js',
  resultEnricher: 'backend/services/matching/resultEnricher.js',
  profileHelpers: 'backend/services/profileHelpers.js',
  profileDataPoints: 'backend/services/profileDataPoints.js',
  webQueries: 'backend/crawler-os/webQueries.js',
})

const original = new Map()
const staged = new Map()

function read(file) {
  if (staged.has(file)) return staged.get(file)
  if (!original.has(file)) original.set(file, fs.readFileSync(file, 'utf8'))
  return original.get(file)
}

function stage(file, content) {
  staged.set(file, content)
}

function replaceExact(file, before, after, label) {
  const source = read(file)
  const first = source.indexOf(before)
  if (first < 0 || first !== source.lastIndexOf(before)) {
    throw new Error(`[amy-exact-sha-cleanup] ${label} missing or ambiguous`)
  }
  stage(file, source.slice(0, first) + after + source.slice(first + before.length))
}

const signatures = [
  [files.webLane, 'match_decision: decision.decision'],
  [files.report, 'recommendation?.decision ?? recommendation?.match_decision'],
  [files.report, 'function schoolPublicationAliases'],
  [files.resultEnricher, 'trust.downgrade && !hasStoredDecision'],
  [files.profileHelpers, 'orgType: organizationType'],
  [files.profileDataPoints, 'ORGANIZATION_IDENTITY_ALIASES'],
  [files.profileDataPoints, "'organization',"],
  [files.webQueries, 'function schoolPublicationAliases'],
]

const present = signatures.filter(([file, signature]) => read(file).includes(signature))
if (present.length === signatures.length) {
  console.log('[source-materialization] Amy exact-SHA cleanup already present')
} else {
  if (present.length > 0) {
    throw new Error(
      `[amy-exact-sha-cleanup] partial materialization detected: ${present
        .map(([, signature]) => signature)
        .join(', ')}`,
    )
  }

  replaceExact(
    files.webLane,
    `          result.recommendations.push({ opportunity_id: matchOpp.id, title: matchOpp.title, sponsor: matchOpp.sponsor, kind: matchOpp.kind ?? null, amount_min: matchOpp.funding?.amount_min ?? null, amount_max: matchOpp.funding?.amount_max ?? null, amount_status: matchOpp.funding?.amount_status ?? null, match_score: decision.match_score, source: 'web_search', topical_evidence: decision.match_explain?.score_breakdown?.topical_evidence ?? null });`,
    `          result.recommendations.push({
            opportunity_id: matchOpp.id,
            title: matchOpp.title,
            sponsor: matchOpp.sponsor,
            kind: matchOpp.kind ?? null,
            amount_min: matchOpp.funding?.amount_min ?? null,
            amount_max: matchOpp.funding?.amount_max ?? null,
            amount_status: matchOpp.funding?.amount_status ?? null,
            match_score: decision.match_score,
            // The canonical decision must travel with the recommendation. The
            // registry lane already does this; dropping it here made Amy infer
            // ACCEPT from a capped REVIEW score and report phantom defects.
            decision: decision.decision,
            match_decision: decision.decision,
            match_explanation: decision.match_explain?.why ?? null,
            source: 'web_search',
            topical_evidence: decision.match_explain?.score_breakdown?.topical_evidence ?? null,
          });`,
    'open-web recommendation decision contract',
  )

  replaceExact(
    files.report,
    `const CANONICAL_RECOMMENDATION_DECISIONS = new Set(['ACCEPT', 'REVIEW', 'REJECT'])
function canonicalRecommendationDecision(recommendation) {
  const explicit = decisionUpper(recommendation?.decision)
  if (CANONICAL_RECOMMENDATION_DECISIONS.has(explicit)) return explicit
  const score = num(recommendation?.match_score)
  if (score >= ACCEPT_SCORE) return 'ACCEPT'
  if (score >= REVIEW_SCORE) return 'REVIEW'
  return 'REJECT'
}`,
    `const CANONICAL_RECOMMENDATION_DECISIONS = new Set(['ACCEPT', 'REVIEW', 'REJECT'])
function canonicalRecommendationDecision(recommendation) {
  const explicit = decisionUpper(
    recommendation?.decision ?? recommendation?.match_decision,
  )
  if (CANONICAL_RECOMMENDATION_DECISIONS.has(explicit)) return explicit

  // Fail closed for legacy/incomplete producer rows. A score is fit evidence,
  // not permission to bypass eligibility, generic-title, locator, source, or
  // actionability caps. Missing canonical truth may remain human-reviewable,
  // but Amy must never promote it to ACCEPT on score alone.
  return num(recommendation?.match_score) >= REVIEW_SCORE ? 'REVIEW' : 'REJECT'
}`,
    'fail-closed canonical recommendation decision',
  )

  replaceExact(
    files.report,
    `function schoolCampusAlias(name) {
  const words = normLower(name).split(' ').filter((x) => x && !RECALL_STOP.has(x))
  if (words.length < 3 || words[0] === 'university') return ''
  const campus = words.at(-1)
  if (!campus || GENERIC_INSTITUTION_TAILS.has(campus)) return ''
  const baseAcronym = words.slice(0, -1).map((x) => x[0]).join('')
  return baseAcronym.length >= 2 ? `${baseAcronym} ${campus}` : ''
}

/** True if any normalized title/sponsor references the school (full name, acronym, or precise campus alias). */`,
    `function schoolCampusAlias(name) {
  const words = normLower(name).split(' ').filter((x) => x && !RECALL_STOP.has(x))
  if (words.length < 3 || words[0] === 'university') return ''
  const campus = words.at(-1)
  if (!campus || GENERIC_INSTITUTION_TAILS.has(campus)) return ''
  const baseAcronym = words.slice(0, -1).map((x) => x[0]).join('')
  return baseAcronym.length >= 2 ? `${baseAcronym} ${campus}` : ''
}

// A very small, evidence-backed publication-name registry. Institutions often
// publish awards under a protected short name that is neither the legal name nor
// a safe acronym. Keep this explicit rather than accepting loose token overlap.
const SCHOOL_PUBLICATION_ALIASES = new Map([
  ['the ohio state university', ['ohio state']],
])
function schoolPublicationAliases(name) {
  return SCHOOL_PUBLICATION_ALIASES.get(normLower(name)) || []
}

/** True if any normalized title/sponsor references the school (full name, acronym, campus alias, or protected publication name). */`,
    'institution publication alias helper',
  )

  replaceExact(
    files.report,
    `  const acr = schoolAcronym(school)
  const campusAlias = schoolCampusAlias(school)`,
    `  const acr = schoolAcronym(school)
  const campusAlias = schoolCampusAlias(school)
  const publicationAliases = schoolPublicationAliases(school)`,
    'institution publication alias binding',
  )

  replaceExact(
    files.report,
    `  return normalizedTitles.some((t) =>
    t.includes(n) ||
    (campusAlias && t.includes(campusAlias)) ||
    (acrRx && acrRx.test(t)),
  )`,
    `  return normalizedTitles.some((t) =>
    t.includes(n) ||
    publicationAliases.some((alias) => t.includes(alias)) ||
    (campusAlias && t.includes(campusAlias)) ||
    (acrRx && acrRx.test(t)),
  )`,
    'institution publication alias comparison',
  )

  replaceExact(
    files.resultEnricher,
    `  if (trust.downgrade) {
    score = clampScore(score - trustDowngradePenalty)
  }`,
    `  // A persisted score/decision pair is the audited canonical artifact. Trust
  // metadata may explain or sort a live recomputation, but query-time display
  // enrichment must not silently rewrite a stored score and create parity drift.
  if (trust.downgrade && !hasStoredDecision) {
    score = clampScore(score - trustDowngradePenalty)
  }`,
    'stored score parity under trust downgrade',
  )

  replaceExact(
    files.profileHelpers,
    `  const orgDetailsSection = sections?.organization_details ?? {}
  const npCompliance = sections?.nonprofit_compliance ?? {}
  const organizationSignals = {
    is501c3: !!npCompliance.has_501c3 || !!npCompliance.is_501c3 || !!orgDetailsSection.is_501c3,`,
    `  const orgDetailsSection = sections?.organization_details ?? {}
  const npCompliance = sections?.nonprofit_compliance ?? {}
  const organizationType = String(
    orgDetailsSection.organization_type ?? orgDetailsSection.org_type ?? '',
  ).trim() || null
  if (organizationType) registerKeyword(organizationType)
  const organizationSignals = {
    // Specific organization identity is substantive matching evidence, not a
    // replacement for the broad applicant-type eligibility gate.
    orgType: organizationType,
    is501c3: !!npCompliance.has_501c3 || !!npCompliance.is_501c3 || !!orgDetailsSection.is_501c3,`,
    'specific organization type signal',
  )

  replaceExact(
    files.profileDataPoints,
    `  'applicant_type',
  'demographic',`,
    `  'applicant_type',
  'organization',
  'demographic',`,
    'organization data-point kind',
  )

  replaceExact(
    files.profileDataPoints,
    `  if (primaryType) push('applicant_type', primaryType)
  for (const t of cleanTerms(toValueList(signals?.applicantTypes))) push('applicant_type', t)

  // ── trait sets, in fixed kind order ──`,
    `  if (primaryType) push('applicant_type', primaryType)
  for (const t of cleanTerms(toValueList(signals?.applicantTypes))) push('applicant_type', t)

  // ── specific organization identity: one fact, many precise textual aliases ──
  const organizationType =
    signals?.organization?.orgType ??
    profileNorm?.organization?.orgType ??
    profile?.organization_type ??
    null
  if (organizationType) push('organization', organizationType)

  // ── trait sets, in fixed kind order ──`,
    'organization inventory point',
  )

  replaceExact(
    files.profileDataPoints,
    `export function declaredProgramMatchesSource(declaredValue, normSourceId) {
  if (!normSourceId) return false
  const sourceIds = PROGRAM_SOURCE_AFFINITY.get(norm(declaredValue))
  return Boolean(sourceIds && sourceIds.has(normSourceId))
}

function toValueList(setOrArray) {`,
    `export function declaredProgramMatchesSource(declaredValue, normSourceId) {
  if (!normSourceId) return false
  const sourceIds = PROGRAM_SOURCE_AFFINITY.get(norm(declaredValue))
  return Boolean(sourceIds && sourceIds.has(normSourceId))
}

// One declared organization identity contributes one denominator point. These
// aliases only teach that point how real program pages name the same entity
// class; they never mint extra points or bypass eligibility/geography gates.
const ORGANIZATION_IDENTITY_ALIASES = new Map(
  Object.entries({
    'tribal government': [
      'tribal government',
      'tribal organization',
      'tribal nation',
      'native american',
      'american indian',
      'indigenous',
      'indian country',
    ],
    'tribal organization': [
      'tribal government',
      'tribal organization',
      'tribal nation',
      'native american',
      'american indian',
      'indigenous',
      'indian country',
    ],
    'community development corporation': [
      'community development corporation',
      'community development block grant',
      'community development',
      'cdbg',
      'chdo',
      'cdfi',
    ],
    'public housing authority': [
      'public housing authority',
      'housing authority',
      'public housing',
      'public housing capital fund',
      'choice neighborhoods',
      'resident opportunities and self sufficiency',
      'ross',
    ],
    'housing authority': [
      'public housing authority',
      'housing authority',
      'public housing',
      'public housing capital fund',
      'choice neighborhoods',
      'resident opportunities and self sufficiency',
      'ross',
    ],
    'workforce development board': [
      'workforce development board',
      'workforce development',
      'workforce innovation and opportunity act',
      'wioa',
      'employment and training administration',
      'apprenticeship',
    ],
  }).map(([key, values]) => [norm(key), values.map(norm)]),
)

function organizationIdentityAliases(value) {
  const normalized = norm(value)
  return ORGANIZATION_IDENTITY_ALIASES.get(normalized) || [normalized]
}

function toValueList(setOrArray) {`,
    'organization identity alias registry',
  )

  replaceExact(
    files.profileDataPoints,
    `      case 'financial': {
        if (dp.value === 'funding amount stated') {`,
    `      case 'organization': {
        const alias = organizationIdentityAliases(dp.value).find((term) => scanValue(term))
        if (alias) {
          record(dp, 1, norm(alias) === norm(dp.value) ? 'text' : 'organization_identity_alias')
        }
        break
      }
      case 'financial': {
        if (dp.value === 'funding amount stated') {`,
    'organization identity matching',
  )

  replaceExact(
    files.webQueries,
    `function cleanInstitution(v) {
  const s = String(v || '').replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
  return s.length >= 3 && s.length <= 90 ? s : '';
}

// Turn an internal need/interest token`,
    `function cleanInstitution(v) {
  const s = String(v || '').replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
  return s.length >= 3 && s.length <= 90 ? s : '';
}

const SCHOOL_PUBLICATION_ALIASES = Object.freeze({
  'the ohio state university': ['Ohio State'],
});
function schoolPublicationAliases(name) {
  return SCHOOL_PUBLICATION_ALIASES[String(name || '').toLowerCase().trim()] || [];
}

// Turn an internal need/interest token`,
    'publication-name query registry',
  )

  replaceExact(
    files.webQueries,
    `      add(core, \`"${school}" scholarships\`);
      add(core, \`${school} scholarships\`);
      if (i === 0) add(extra, \`"${school}" financial aid scholarships\`);`,
    `      add(core, \`"${school}" scholarships\`);
      for (const alias of schoolPublicationAliases(school)) {
        add(core, \`"${alias}" scholarships\`);
        if (i === 0) add(extra, \`"${alias}" financial aid scholarships\`);
      }
      add(core, \`${school} scholarships\`);
      if (i === 0) add(extra, \`"${school}" financial aid scholarships\`);`,
    'publication-name institution queries',
  )

  replaceExact(
    files.webQueries,
    `        add(forced, \`${s} scholarships\`);
        add(forced, \`"${s}" scholarships\`);
        add(forced, \`${s} foundation scholarships\`);
        add(extra, \`"${s}" financial aid scholarships\`);`,
    `        add(forced, \`${s} scholarships\`);
        add(forced, \`"${s}" scholarships\`);
        for (const alias of schoolPublicationAliases(s)) {
          add(forced, \`"${alias}" scholarships\`);
          add(extra, \`"${alias}" financial aid scholarships\`);
        }
        add(forced, \`${s} foundation scholarships\`);
        add(extra, \`"${s}" financial aid scholarships\`);`,
    'learned publication-name institution queries',
  )

  for (const [file, content] of staged) fs.writeFileSync(file, content)
  console.log('[source-materialization] Amy exact-SHA cleanup materialized')
}

const missing = signatures.filter(([file, signature]) => !read(file).includes(signature))
if (missing.length > 0) {
  throw new Error(
    `[amy-exact-sha-cleanup] final signatures missing: ${missing
      .map(([, signature]) => signature)
      .join(', ')}`,
  )
}
