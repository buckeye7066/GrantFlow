#!/usr/bin/env node
import fs from 'node:fs'

const reportFile = 'backend/services/amy/amyReport.js'
const queryFile = 'backend/crawler-os/webQueries.js'

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
    throw new Error(`[amy-flywheel-precision] ${label} missing or ambiguous`)
  }
  stage(file, source.slice(0, first) + after + source.slice(first + before.length))
}

const signatures = [
  [reportFile, 'function canonicalRecommendationDecision'],
  [reportFile, "canonicalRecommendationDecision(r) === 'ACCEPT'"],
  [reportFile, 'function schoolCampusAlias'],
  [queryFile, 'Amy flywheel precision lane'],
  [queryFile, '`"${school}" scholarships`'],
  [queryFile, 'HUD Public Housing Capital Fund'],
  [queryFile, 'Department of Labor apprenticeship grants'],
]

const present = signatures.filter(([file, signature]) => read(file).includes(signature))
if (present.length === signatures.length) {
  console.log('[source-materialization] Amy flywheel precision already present')
} else {
  if (present.length > 0) {
    throw new Error(`[amy-flywheel-precision] partial materialization detected: ${present.map(([, signature]) => signature).join(', ')}`)
  }

  replaceExact(
    reportFile,
`function decisionUpper(d) {
  return String(d ?? '').trim().toUpperCase()
}`,
`function decisionUpper(d) {
  return String(d ?? '').trim().toUpperCase()
}

// The engine's canonical decision is authoritative. A high raw score can still
// be REVIEW after eligibility, generic-title, locator, or safety caps. Amy used
// to count such rows as ACCEPT via an OR-score fallback, manufacturing false
// ineligible/false-positive findings after the engine had already contained the
// row. Only fall back to score bands for legacy rows that carry no recognized
// decision at all.
const CANONICAL_RECOMMENDATION_DECISIONS = new Set(['ACCEPT', 'REVIEW', 'REJECT'])
function canonicalRecommendationDecision(recommendation) {
  const explicit = decisionUpper(recommendation?.decision)
  if (CANONICAL_RECOMMENDATION_DECISIONS.has(explicit)) return explicit
  const score = num(recommendation?.match_score)
  if (score >= ACCEPT_SCORE) return 'ACCEPT'
  if (score >= REVIEW_SCORE) return 'REVIEW'
  return 'REJECT'
}`,
    'canonical recommendation decision helper',
  )

  replaceExact(
    reportFile,
`  const accepted = recommendations.filter(
    (r) => decisionUpper(r.decision) === 'ACCEPT' || num(r.match_score) >= ACCEPT_SCORE,
  )
  const review = recommendations.filter(
    (r) => decisionUpper(r.decision) === 'REVIEW' || (num(r.match_score) >= REVIEW_SCORE && num(r.match_score) < ACCEPT_SCORE),
  )`,
`  const accepted = recommendations.filter(
    (r) => canonicalRecommendationDecision(r) === 'ACCEPT',
  )
  const review = recommendations.filter(
    (r) => canonicalRecommendationDecision(r) === 'REVIEW',
  )`,
    'accepted/review classification',
  )

  replaceExact(
    reportFile,
    '    decision: decisionUpper(r.decision),',
    '    decision: canonicalRecommendationDecision(r),',
    'candidate decision classification',
  )

  replaceExact(
    reportFile,
`/** True if any normalized title/sponsor references the school (full name or acronym). */`,
`const GENERIC_INSTITUTION_TAILS = new Set(['university', 'college', 'school', 'institute', 'academy'])

// Branch campuses are often published as "MSU Billings" or "IU Bloomington"
// rather than the full legal institution name. Build only the high-precision
// acronym+campus alias; never fall back to loose token overlap.
function schoolCampusAlias(name) {
  const words = normLower(name).split(' ').filter((x) => x && !RECALL_STOP.has(x))
  if (words.length < 3 || words[0] === 'university') return ''
  const campus = words.at(-1)
  if (!campus || GENERIC_INSTITUTION_TAILS.has(campus)) return ''
  const baseAcronym = words.slice(0, -1).map((x) => x[0]).join('')
  return baseAcronym.length >= 2 ? \`${'${baseAcronym}'} ${'${campus}'}\` : ''
}

/** True if any normalized title/sponsor references the school (full name, acronym, or precise campus alias). */`,
    'institution campus alias helper',
  )

  replaceExact(
    reportFile,
    `  const acr = schoolAcronym(school)`,
    `  const acr = schoolAcronym(school)\n  const campusAlias = schoolCampusAlias(school)`,
    'institution campus alias binding',
  )

  replaceExact(
    reportFile,
    `  return normalizedTitles.some((t) => t.includes(n) || (acrRx && acrRx.test(t)))`,
    `  return normalizedTitles.some((t) =>\n    t.includes(n) ||\n    (campusAlias && t.includes(campusAlias)) ||\n    (acrRx && acrRx.test(t)),\n  )`,
    'institution campus alias comparison',
  )

  replaceExact(
    queryFile,
`  const core = [];
  const extra = [];

  // ── CORE (always emitted, highest signal) ──`,
`  const core = [];
  const extra = [];

  // Amy flywheel precision lane: pin the defining program families for the
  // organization classes that repeatedly came back REVIEW-only. These must be
  // inserted BEFORE generic type/geo queries because the final query cap slices
  // from the end. The rows still face the normal reality, eligibility, and match
  // gates; this changes discovery priority, not scoring permissiveness.
  {
    const hasType = (t) => types.includes(t);
    const needSet = needs.map((n) => n.toLowerCase());
    const needSignal = (re) => needSet.some((n) => re.test(n));

    const communityDevelopment =
      hasType('nonprofit') && needSignal(/housing development|community facilit/);
    if (communityDevelopment) {
      if (state) add(core, \`community development block grant \${state}\`);
      if (state) add(core, \`HOME CHDO affordable housing funding \${state}\`);
      add(core, \`CDFI Fund community development grants \${year}\`);
    }

    const publicHousing = hasType('government') && needSignal(/housing|housing development/);
    if (publicHousing) {
      add(core, \`HUD Public Housing Capital Fund \${year}\`);
      add(core, \`HUD Choice Neighborhoods grants \${year}\`);
      add(core, \`HUD ROSS resident services funding \${year}\`);
    }

    const workforceOrganization =
      (hasType('nonprofit') || hasType('government')) && needSignal(/workforce|employment/);
    if (workforceOrganization) {
      if (state) add(core, \`WIOA workforce development funding \${state}\`);
      add(core, \`Department of Labor apprenticeship grants \${year}\`);
      add(core, \`Employment and Training Administration funding opportunities \${year}\`);
    }
  }

  // ── CORE (always emitted, highest signal) ──`,
    'sector-defining query priority',
  )

  replaceExact(
    queryFile,
`    schools.forEach((school, i) => {
      add(core, \`\${school} scholarships\`);`,
`    schools.forEach((school, i) => {
      // Exact-name query defeats generic scholarship SERP drift while the
      // existing unquoted form preserves broad recall.
      add(core, \`"\${school}" scholarships\`);
      add(core, \`\${school} scholarships\`);
      if (i === 0) add(extra, \`"\${school}" financial aid scholarships\`);`,
    'exact institution query',
  )

  replaceExact(
    queryFile,
`        add(forced, \`\${s} scholarships\`);
        add(forced, \`\${s} foundation scholarships\`);`,
`        add(forced, \`\${s} scholarships\`);
        add(forced, \`"\${s}" scholarships\`);
        add(forced, \`\${s} foundation scholarships\`);
        add(extra, \`"\${s}" financial aid scholarships\`);`,
    'learned institution gap exact query',
  )

  for (const [file, content] of staged) fs.writeFileSync(file, content)
  console.log('[source-materialization] Amy flywheel precision materialized')
}

const missing = signatures.filter(([file, signature]) => !read(file).includes(signature))
if (missing.length > 0) {
  throw new Error(`[amy-flywheel-precision] final signatures missing: ${missing.map(([, signature]) => signature).join(', ')}`)
}
