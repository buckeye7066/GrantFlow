#!/usr/bin/env node
/**
 * Clean Anastasia Nicole White's live pipeline against her profile goals.
 *
 * This is intentionally rule-based, not score-based. Anastasia's current
 * profile is a Tennessee/Appalachian high-school/early-college student seeking
 * undergraduate funding for forensic science / STEM / criminal justice. The
 * pipeline should contain student aid, FAFSA/state/school portals, target-school
 * aid, student housing/cost-of-attendance paths, and scholarships she could
 * plausibly use. It should not contain business, veteran, health-benefit,
 * workforce-agency, professional-license, institutional/government grantee, or
 * unrelated-demographic items.
 *
 * Usage:
 *   node scripts/cleanup-anastasia-pipeline-goal-fit.mjs
 *   node scripts/cleanup-anastasia-pipeline-goal-fit.mjs --apply
 *
 * Env:
 *   Uses GF_API/GF_TOKEN when provided; otherwise loads .env.vercel.prod
 *   VITE_API_URL and ADMIN_TOKEN.
 */

import fs from 'node:fs/promises'
import fssync from 'node:fs'
import dotenv from 'dotenv'

const PROFILE_ID = 'c4a92724-9cee-416f-ba30-e91b9b5cd885'
const rawArgs = process.argv.slice(2)
const args = new Set(rawArgs)
const APPLY = args.has('--apply')
const inputFileArg = rawArgs.find((arg) => arg.startsWith('--input-file='))
const INPUT_FILE = inputFileArg ? inputFileArg.slice('--input-file='.length) : null
if (APPLY && INPUT_FILE) {
  console.error('--apply cannot be used with --input-file')
  process.exit(2)
}

function loadEnv() {
  const parsed = fssync.existsSync('.env.vercel.prod')
    ? dotenv.parse(fssync.readFileSync('.env.vercel.prod'))
    : {}
  const apiOrigin = process.env.GF_API || process.env.VITE_API_URL || parsed.VITE_API_URL
  const token = process.env.GF_TOKEN || process.env.ADMIN_TOKEN || parsed.ADMIN_TOKEN
  if (!apiOrigin || !token) {
    console.error('Missing API/token. Set GF_API + GF_TOKEN or keep .env.vercel.prod available.')
    process.exit(2)
  }
  const api = apiOrigin.endsWith('/api') ? apiOrigin : `${apiOrigin.replace(/\/+$/, '')}/api`
  return { api, token }
}

const { api: API, token: TOKEN } = loadEnv()
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJson(url, init = {}, tries = 3) {
  let lastError = null
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...HEADERS, ...(init.headers || {}) },
      })
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = { raw: text }
      }
      if ((response.status === 429 || response.status >= 500) && i < tries - 1) {
        const retryAfter = Number(response.headers.get('retry-after') || 0)
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 750 * (i + 1))
        continue
      }
      return { ok: response.ok, status: response.status, body }
    } catch (error) {
      lastError = error
      await sleep(400 * (i + 1))
    }
  }
  return { ok: false, status: 0, body: { error: String(lastError?.message || lastError) } }
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&ndash;|&mdash;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function combinedText(grant) {
  return normalize([
    grant.title,
    grant.funder,
    grant.description,
    grant.notes,
    grant.application_url,
    grant.source_url,
  ].filter(Boolean).join(' '))
}

function isGoogleSearch(grant) {
  return /google\.com\/search/i.test(String(grant.application_url || grant.url || ''))
}

function matchAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text))
}

const removeRules = [
  {
    code: 'deadline_passed',
    reason: 'deadline already passed; not an actionable source for this student pipeline',
    test: (grant) => normalize(grant.status) === 'deadline passed',
  },
  {
    code: 'conditional_income_not_verified',
    reason: 'requires FAFSA/IRS AGI of $36,000 or less; profile shows household income but no qualifying AGI proof',
    test: (grant) => /tennessee hope aspire award/.test(normalize(grant.title)),
  },
  {
    code: 'generic_search_portal_not_pipeline',
    reason: 'broad scholarship search engine or aggregator; useful for catalog/search, but not a profile-specific pipeline funding source',
    test: (grant, text) => matchAny(text, [
      /\bcollege greenlight\b/,
      /\bscholarship experts\b/,
      /\bunigo\b/,
      /\bfastweb\b/,
      /\bcappex\b/,
      /\bniche scholarships\b/,
      /\bscholarshipowl\b/,
      /\bgoing merry\b/,
      /\bbigfuture scholarship search\b/,
      /\bscholarships com free scholarship search\b/,
      /\bbold org no essay\b/,
    ]),
  },
  {
    code: 'duplicate_umbrella_aid_record',
    reason: 'umbrella aid record duplicates a more specific FAFSA/Pell/FSEOG/MTSU work item already in this pipeline',
    test: (grant) => matchAny(normalize(grant.title), [
      /^federal work study fws$/,
      /^federal student aid programs$/,
    ]),
  },
  {
    code: 'fake_or_search_url',
    reason: 'not a real application/source page for a funding source; it is a search URL or non-source placeholder',
    test: (grant) => isGoogleSearch(grant),
  },
  {
    code: 'business_veteran_military',
    reason: 'business, veteran, or military program; Anastasia is not a veteran, active-duty service member, or business owner',
    test: (_grant, text) => matchAny(text, [
      /\bsba\b/,
      /\bveteran/,
      /\bmilitary/,
      /\bboots to business\b/,
      /\bbusiness outreach center\b/,
      /\bentrepreneur/,
      /\bbusiness scholarship finder\b/,
      /\bminority business\b/,
    ]),
  },
  {
    code: 'health_medical_benefit',
    reason: 'health, prescription, disability, Medicaid, mental-health, or patient-assistance program; her profile has no matching medical/disability need',
    test: (_grant, text) => matchAny(text, [
      /\bmedicaid\b/,
      /\bchip\b/,
      /\bhrsa\b/,
      /\bhealth center\b/,
      /\bsamhsa\b/,
      /\brxassist\b/,
      /\bprescription\b/,
      /\bpatient advocate\b/,
      /\bhealthwell\b/,
      /\bpan foundation\b/,
      /\bneedymeds\b/,
      /\bkidney\b/,
      /\bcancer\b/,
      /\binfertility\b/,
      /\bmental health\b/,
      /\babilityone\b/,
      /\bdisability benefits\b/,
      /\bnational federation of the blind\b/,
      /\bscholarships for students with disabilities\b/,
    ]),
  },
  {
    code: 'nursing_healthcare_professional',
    reason: 'nursing/healthcare/professional CE or license program; she is a student pursuing forensic science, not a licensed clinician',
    test: (_grant, text) => matchAny(text, [
      /\bnurs/,
      /\bphysician\b/,
      /\bama foundation\b/,
      /\bamerican psychological association\b/,
      /\baamft\b/,
      /\bnasw\b/,
      /\bce scholarship/,
      /\bcontinuing education\b/,
      /\blicense reinstatement\b/,
      /\breturn to practice\b/,
      /\bpractitioner\b/,
      /\bprobe\b/,
      /\bncsbn\b/,
      /\bems scholarship/,
      /\bnaemt\b/,
      /\bparamedic\b/,
      /\bcpr\b/,
      /\baha community training\b/,
      /\bbehavioral health workforce\b/,
      /\bhealth profession opportunity\b/,
    ]),
  },
  {
    code: 'workforce_trade_or_job_training',
    reason: 'workforce, job-training, vocational, trade, or professional certification program; not undergraduate forensic-science aid',
    test: (_grant, text) => matchAny(text, [
      /\bworkforce\b/,
      /\bwioa\b/,
      /\bjob center\b/,
      /\bcareer recovery\b/,
      /\bcertification training\b/,
      /\bvocational rehabilitation\b/,
      /\btrade school\b/,
      /\bskilled trades\b/,
      /\bstate workforce\b/,
      /\bdepartment of labor grants\b/,
      /\bfarmworker jobs\b/,
      /\bhazardous materials instructor\b/,
      /\bforeign labor certification\b/,
      /\bagriculture and food research initiative\b/,
      /\bjob driven grants\b/,
      /\bprofessional development\b/,
    ]),
  },
  {
    code: 'institutional_or_agency_grant',
    reason: 'grant to agencies, institutions, or organizations rather than an individual student applicant',
    test: (_grant, text) => matchAny(text, [
      /\bcommunity facilities\b/,
      /\bcomprehensive centers\b/,
      /\bosers\b/,
      /\bosep\b/,
      /\boese\b/,
      /\bope\b/,
      /\bcaann\b/,
      /\bpersonnel preparation\b/,
      /\bready to learn programming\b/,
      /\bteen pregnancy prevention\b/,
      /\bpediatric mental health care access\b/,
      /\bfacilities for atmospheric research\b/,
      /\bprofessional formation of engineers\b/,
      /\bgrowing research access\b/,
      /\bcybertraining\b/,
      /\bnational space grant college and fellowship program\b/,
      /\bnrsa\b/,
      /\bsupplemental funding opportunity\b/,
      /\bu s embassy\b/,
      /\bu s mission\b/,
      /\bannual program statement\b/,
      /\bindependent sector\b/,
      /\bcandid\b/,
      /\bnonprofit resources\b/,
      /\barc power\b/,
      /\bappalachian regional commission community programs\b/,
    ]),
  },
  {
    code: 'basic_needs_not_student_aid',
    reason: 'generic basic-needs/social-service directory rather than student financial aid or a profile-specific funding source',
    test: (_grant, text) => matchAny(text, [
      /\bsnap\b/,
      /\bfood bank\b/,
      /\bfeeding america\b/,
      /\bliheap\b/,
      /\bbenefits gov\b/,
      /\bcommunity action agency\b/,
      /\bcommunity action partnership\b/,
      /\bunited way 211\b/,
      /\blocal assistance finder\b/,
      /\bst vincent de paul\b/,
      /\bcatholic charities emergency assistance\b/,
      /\bmodest needs\b/,
      /\bdhs pre move emergency assistance\b/,
      /\bsocial security survivors\b/,
    ]),
  },
  {
    code: 'unmatched_demographic_or_identity',
    reason: 'eligibility depends on a demographic or life circumstance not present in her profile',
    test: (_grant, text) => matchAny(text, [
      /\bhispanic scholarship fund\b/,
      /\bhsf\b/,
      /\buncf\b/,
      /\bthurgood marshall\b/,
      /\btmcf\b/,
      /\bgates scholarship\b/,
      /\bapia scholars\b/,
      /\basian pacific islander\b/,
      /\blgbtq\b/,
      /\bpoint foundation\b/,
      /\bfosterclub\b/,
      /\bchafee\b/,
      /\bfoster youth\b/,
      /\bfirst responder children/,
      /\bfirst generation college student scholarships\b/,
      /\bteen pregnancy\b/,
    ]),
  },
  {
    code: 'wrong_state_or_location',
    reason: 'wrong state, country, or jurisdiction for Anastasia’s Tennessee-based profile',
    test: (_grant, text) => matchAny(text, [
      /\bwv promise\b/,
      /\bflorida nurses\b/,
      /\btexas nurses\b/,
      /\bcalifornia clerk\b/,
      /\bazerbaijan\b/,
      /\bcairo\b/,
      /\begypt\b/,
    ]),
  },
  {
    code: 'unmatched_major_or_activity',
    reason: 'not tied to her stated forensic science/STEM/criminal justice college path',
    test: (_grant, text) => matchAny(text, [
      /\bteacher education\b/,
      /\bteach grant\b/,
      /\bmusic performing arts\b/,
      /\btrack field\b/,
      /\bcross country\b/,
      /\bcheerleading\b/,
      /\bdance scholarship\b/,
      /\bfootball\b/,
      /\bbasketball\b/,
      /\bvolleyball\b/,
      /\bnaia athletic\b/,
      /\bncaa eligibility\b/,
      /\bsafety training scholarships\b/,
    ]),
  },
  {
    code: 'adult_or_special_program_not_eligible',
    reason: 'program appears limited to adults, special education/intellectual-disability paths, or graduate/professional-level applicants not shown in profile',
    test: (_grant, text) => matchAny(text, [
      /\btennessee reconnect\b/,
      /\bfree college for adults\b/,
      /\btennessee step up scholarship\b/,
      /\bgraduate fellowship\b/,
      /\bgraduate research fellowship\b/,
      /\bspecial education teachers\b/,
      /\bearly intervention personnel\b/,
    ]),
  },
  {
    code: 'planning_resource_not_funding',
    reason: 'college planning/statistics/resource page, not a funding source to pursue',
    test: (_grant, text) => matchAny(text, [
      /\bcollege scorecard\b/,
      /\bstate higher ed agencies\b/,
      /\bcollege planning\b/,
    ]),
  },
]

const duplicateGroups = [
  {
    keep: /tennessee hope aspire award 2026 27/,
    remove: /tennessee hope aspire award$/,
    reason: 'duplicate; keeping the 2026-27 TSAC record with deadline context',
  },
  {
    keep: /federal work study at middle tennessee state university 2026 27/,
    remove: /federal work study at mtsu$/,
    reason: 'duplicate; keeping the 2026-27 MTSU work-study portal record',
  },
  {
    keep: /questbridge national college match/,
    remove: /^questbridge$/,
    reason: 'duplicate; keeping the named National College Match record',
  },
  {
    keep: /coca cola scholars program/,
    remove: /^coca cola scholars$/,
    reason: 'duplicate; keeping the full Coca-Cola Scholars Program record',
  },
  {
    keep: /jack kent cooke foundation college scholarship program/,
    remove: /^jack kent cooke foundation$/,
    reason: 'duplicate; keeping the named College Scholarship Program record',
  },
  {
    keep: /middle tennessee state university off campus housing portal/,
    remove: /middle tennessee state university housing off campus resources/,
    reason: 'duplicate; keeping the specific MTSU off-campus housing portal/action record',
  },
]

function duplicateDecision(grant, grants) {
  const title = normalize(grant.title)
  for (const group of duplicateGroups) {
    if (!group.remove.test(title)) continue
    const hasKeeper = grants.some((other) => other.id !== grant.id && group.keep.test(normalize(other.title)))
    if (hasKeeper) {
      return { action: 'remove', code: 'duplicate_pipeline_item', reason: group.reason }
    }
  }
  return null
}

function keepReason(grant, text) {
  if (matchAny(text, [
    /\bfafsa\b/,
    /\bpell grant\b/,
    /\bfseog\b/,
    /\bfederal student aid\b/,
    /\bfederal work study\b/,
    /\btsac\b/,
    /\btennessee hope aspire\b/,
    /\btsaa\b/,
    /\btennessee student assistance award\b/,
    /\btn promise\b/,
    /\btennessee promise\b/,
  ])) {
    return 'student federal/Tennessee financial-aid path tied to college costs'
  }

  if (matchAny(text, [
    /\bmtsu\b/,
    /\bmiddle tennessee state university\b/,
    /\bcollege of basic and applied sciences\b/,
    /\btrue blue scholarship\b/,
    /\bcentennial scholarship\b/,
    /\bacademic service scholarship\b/,
    /\buniversity honors college scholarship\b/,
    /\bdean of students student emergency fund\b/,
    /\bmt one stop\b/,
  ])) {
    return 'target-school portal or MTSU aid/housing path tied to Anastasia’s college plan'
  }

  if (matchAny(text, [
    /\bforensic\b/,
    /\bcriminal justice\b/,
    /\bstem\b/,
    /\bwomen in stem\b/,
    /\bsociety of women engineers\b/,
    /\baafs\b/,
    /\bamerican academy of forensic sciences\b/,
    /\bforensic sciences foundation\b/,
    /\blucas research grant\b/,
  ])) {
    return 'forensic science/STEM/criminal-justice scholarship path matching intended major'
  }

  if (matchAny(text, [
    /\bkosciuszko\b/,
    /\bpolish american\b/,
  ])) {
    return 'Polish-heritage scholarship path matching profile heritage'
  }

  if (matchAny(text, [
    /\bjack kent cooke\b/,
    /\bgates scholarship\b/,
    /\bcoca cola scholars\b/,
    /\bquestbridge\b/,
    /\belks national foundation\b/,
    /\bcollege board opportunity\b/,
    /\bbigfuture\b/,
    /\bgoing merry\b/,
    /\bscholarships com\b/,
    /\bbold org\b/,
    /\bniche scholarships\b/,
    /\bcappex scholarships\b/,
    /\bcollege greenlight\b/,
    /\bfastweb\b/,
    /\bstudent scholarships org\b/,
    /\bunigo\b/,
    /\bscholarshipowl\b/,
    /\bcollege scholarships org\b/,
  ])) {
    return 'general student scholarship portal/program suitable for a high-school senior seeking college funding'
  }

  if (matchAny(text, [
    /\bhousing living expense scholarship\b/,
    /\bhousing scholarships\b/,
    /\bcost of attendance\b/,
    /\bcoa adjustment appeal\b/,
    /\boff campus housing portal\b/,
    /\boff campus housing rent assistance\b/,
  ])) {
    return 'student housing/cost-of-attendance path tied to college affordability'
  }

  return null
}

function classify(grant, grants) {
  const duplicate = duplicateDecision(grant, grants)
  if (duplicate) return duplicate

  const text = combinedText(grant)
  for (const rule of removeRules) {
    if (rule.test(grant, text)) {
      return { action: 'remove', code: rule.code, reason: rule.reason }
    }
  }

  const keep = keepReason(grant, text)
  if (keep) return { action: 'keep', code: 'profile_goal_fit', reason: keep }

  return {
    action: 'remove',
    code: 'no_profile_goal_fit',
    reason: 'no evidence this is an undergraduate student-aid, forensic/STEM/criminal-justice, Tennessee, MTSU, housing/COA, or profile-heritage funding path',
  }
}

async function listPipeline() {
  if (INPUT_FILE) {
    const snapshot = JSON.parse(await fs.readFile(INPUT_FILE, 'utf8'))
    return Array.isArray(snapshot) ? snapshot : snapshot.grants || []
  }
  const response = await fetchJson(`${API}/grants?profile_id=${encodeURIComponent(PROFILE_ID)}&limit=2000`)
  if (!response.ok) {
    throw new Error(`failed to list pipeline: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`)
  }
  return Array.isArray(response.body) ? response.body : response.body?.items || []
}

async function main() {
  const before = await listPipeline()
  const decisions = before.map((grant) => ({
    grant,
    decision: classify(grant, before),
  }))
  const keep = decisions.filter((row) => row.decision.action === 'keep')
  const remove = decisions.filter((row) => row.decision.action === 'remove')

  const modeLabel = INPUT_FILE ? 'CLASSIFY_FILE' : APPLY ? 'APPLY' : 'DRY_RUN'
  console.log(`[anastasia-cleanup] mode=${modeLabel} before=${before.length} keep=${keep.length} remove=${remove.length}`)
  const byReason = remove.reduce((acc, row) => {
    acc[row.decision.code] = (acc[row.decision.code] || 0) + 1
    return acc
  }, {})
  console.log('[anastasia-cleanup] remove reasons:', JSON.stringify(byReason))
  for (const row of remove) {
    console.log(`  - ${row.grant.id} :: ${row.grant.title} :: ${row.decision.code}`)
  }

  const deleted = []
  const deleteFailures = []
  if (APPLY) {
    for (const row of remove) {
      const response = await fetchJson(`${API}/grants/${encodeURIComponent(row.grant.id)}`, { method: 'DELETE' })
      if (response.ok) {
        deleted.push({
          id: row.grant.id,
          title: row.grant.title,
          funder: row.grant.funder,
          status: row.grant.status,
          code: row.decision.code,
          reason: row.decision.reason,
        })
      } else {
        deleteFailures.push({
          id: row.grant.id,
          title: row.grant.title,
          status: response.status,
          body: response.body,
          code: row.decision.code,
          reason: row.decision.reason,
        })
      }
      await sleep(125)
    }
  }

  const after = APPLY ? await listPipeline() : before
  const audit = {
    profile_id: PROFILE_ID,
    profile_name: 'Anastasia Nicole White',
    mode: INPUT_FILE ? 'classify_file' : APPLY ? 'apply' : 'dry_run',
    generated_at: new Date().toISOString(),
    rule_basis: {
      kept_when:
        'student financial aid, FAFSA/Tennessee aid, target-school/MTSU portals, forensic/STEM/criminal-justice scholarships, Polish-heritage scholarships, student housing/cost-of-attendance paths, or credible student scholarship portals',
      removed_when:
        'business/veteran/military, health/medical/disability benefits, nursing/CE/license, workforce/trade/job training, institutional/government grantee programs, generic basic-needs directories, unmatched demographics, wrong state/location, expired, duplicate, search URL, or no profile-goal evidence',
      score_used: false,
    },
    before_count: before.length,
    keep_count: keep.length,
    remove_count: remove.length,
    deleted_count: deleted.length,
    delete_failure_count: deleteFailures.length,
    after_count: after.length,
    kept: keep.map((row) => ({
      id: row.grant.id,
      title: row.grant.title,
      funder: row.grant.funder,
      status: row.grant.status,
      reason: row.decision.reason,
    })),
    removed_or_flagged: remove.map((row) => ({
      id: row.grant.id,
      title: row.grant.title,
      funder: row.grant.funder,
      status: row.grant.status,
      code: row.decision.code,
      reason: row.decision.reason,
    })),
    deleted,
    delete_failures: deleteFailures,
  }

  await fs.mkdir('docs/_readiness_logs', { recursive: true })
  const path = INPUT_FILE
    ? 'docs/_readiness_logs/anastasia-pipeline-goal-fit-cleanup-combined-classification.json'
    : APPLY
    ? 'docs/_readiness_logs/anastasia-pipeline-goal-fit-cleanup-apply.json'
    : 'docs/_readiness_logs/anastasia-pipeline-goal-fit-cleanup-dry-run.json'
  await fs.writeFile(path, JSON.stringify(audit, null, 2), 'utf8')
  console.log(`[anastasia-cleanup] after=${after.length} deleted=${deleted.length} failures=${deleteFailures.length}`)
  console.log(`[anastasia-cleanup] wrote ${path}`)

  if (deleteFailures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('FATAL', error?.stack || error?.message || error)
  process.exit(1)
})
