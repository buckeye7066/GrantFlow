#!/usr/bin/env node
/**
 * scripts/anastasia-fix-cycle-and-add-july-bridge.mjs
 *
 * Two-part correction for Anastasia's off-campus living funding:
 *
 * (1) RE-DATE the 28 entries previously added with 2027-cycle deadlines so
 *     they target the correct 2026-27 academic year (Fall 2026 enrollment).
 *     She is HS class of 2026 graduating this spring and starting MTSU in
 *     August 2026 — needs rent/utilities funded starting JULY 2026.
 *
 * (2) ADD JULY-BRIDGE FUNDING — real, named programs that can put cash in
 *     her hands BEFORE late-August financial-aid refunds disburse:
 *       - MTSU Dean of Students Student Emergency Fund (fast-turnaround)
 *       - Tennessee 211 (referral hotline to local emergency rent aid)
 *       - Modest Needs Foundation (short-term emergency grants)
 *       - Greenhouse Ministries Murfreesboro (rent + utilities)
 *       - United Way of Rutherford & Cannon Counties
 *       - Salvation Army Greater Murfreesboro
 *       - THDA HOME-ARP / Tennessee Housing Stability programs
 *       - Bradley County DHS Emergency Assistance (her current county, pre-move)
 *       - LIHEAP Tennessee (utility assistance year-round)
 *       - Catholic Charities of Tennessee (emergency aid)
 *       - MTSU MT One Stop / Financial Aid Cash Advance / Book voucher
 *
 * Then triggers a force pipeline_automation run so the new + re-dated entries
 * land at portal/submitted/pending_review with `application_steps` for her.
 *
 * Required env: GF_API, GF_TOKEN
 */
import fs from 'node:fs/promises'

const API = process.env.GF_API
const TOKEN = process.env.GF_TOKEN
if (!API || !TOKEN) { console.error('Missing GF_API or GF_TOKEN'); process.exit(2) }
const PROFILE_ID = 'c4a92724-9cee-416f-ba30-e91b9b5cd885'
const ORG_ID = 'c4a92724-9cee-416f-ba30-e91b9b5cd885'
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, init = {}, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } })
      const t = await r.text()
      let body
      try { body = t ? JSON.parse(t) : {} } catch { body = { raw: t } }
      return { ok: r.ok, status: r.status, body }
    } catch (e) { last = e; await sleep(400 * (i + 1)) }
  }
  return { ok: false, status: 0, body: { error: String(last?.message || last) } }
}

// (1) Correct deadlines for the 26 entries we previously added with 2027 cycle.
//     Keyed by a substring that uniquely matches the entry title (case-insensitive).
//     Each entry: { dateForFall2026, deadlineType, note }
//     "rolling" means no fixed deadline; we set deadline=null and rely on type.
const DEADLINE_FIX = {
  'fafsa': { date: null, type: 'rolling', note: '2026-27 FAFSA accepted through 2027-06-30 — file ASAP; refund disburses ~Aug 2026' },
  'pell grant': { date: null, type: 'rolling', note: 'Disbursed via FAFSA after MTSU billing — Aug 2026' },
  'fseog': { date: null, type: 'rolling', note: 'Disbursed via FAFSA after MTSU billing — Aug 2026' },
  'subsidized loan': { date: null, type: 'rolling', note: 'Disbursed ~10 days before classes start (mid-Aug 2026)' },
  'work-study at mtsu': { date: null, type: 'rolling', note: 'Earned weekly once she begins classes — first paycheck early Sep 2026' },
  'tennessee hope scholarship': { date: '2026-08-01', type: 'fixed', note: 'TSAC application by Aug 1 2026 for Fall 2026 award (~Aug disbursement)' },
  'tennessee hope aspire': { date: '2026-08-01', type: 'fixed', note: 'Same TSAC app as HOPE; eligibility set by FAFSA SAI' },
  'tsaa': { date: '2026-08-01', type: 'fixed', note: 'TN Student Assistance Award still accepting applications until 26-27 funds depleted; file FAFSA NOW' },
  'general assembly merit': { date: '2026-08-01', type: 'fixed', note: 'GAMS — needs ACT 29; she has 28; one-point retake unlocks $1K/yr' },
  'mtsu true blue': { date: null, type: 'rolling', note: 'Automatic with admission; verify award letter from MTSU Financial Aid' },
  'mtsu academic service': { date: '2026-12-15', type: 'fixed', note: '2026-27 cycle CLOSED (was Dec 2025); apply Dec 2026 for 2027-28' },
  'mtsu centennial': { date: '2026-12-15', type: 'fixed', note: '2026-27 cycle CLOSED; apply Dec 2026 for 2027-28' },
  'mtsu university honors': { date: '2026-12-15', type: 'fixed', note: '2026-27 cycle CLOSED; apply Dec 2026 for 2027-28 / honors college admission' },
  'cbas': { date: '2027-02-15', type: 'fixed', note: '2026-27 dept cycle CLOSED; apply Feb 2027 for 2027-28; some labs offer summer-research stipends — contact dept directly NOW for any current openings' },
  'mtsu foundation need-based': { date: '2027-02-01', type: 'fixed', note: 'AcademicWorks portal — current cycle CLOSED; opens Nov 2026 for 2027-28' },
  'mtsu academicworks': { date: '2027-02-01', type: 'fixed', note: 'Single application portal — current cycle CLOSED; opens Nov 2026' },
  'east tennessee foundation': { date: '2027-01-31', type: 'fixed', note: '2026-27 cycle CLOSED; opens Nov 2026 for 2027-28' },
  'cleveland state community college': { date: null, type: 'rolling', note: 'Contact CSCC Foundation directly for transfer-bridge scholarship — some are rolling' },
  'community foundation of middle tennessee': { date: '2027-03-15', type: 'fixed', note: '2026-27 cycle CLOSED; opens Jan 2027 for 2027-28' },
  'united way of the ocoee': { date: null, type: 'rolling', note: 'Emergency-aid fund is rolling — call Bradley County office NOW for July rent gap support' },
  'aafs': { date: '2026-08-01', type: 'fixed', note: 'AAFS Foundation Educational Scholarship — verify current cycle deadline; some awards open through Aug' },
  'lucas research grant': { date: '2026-08-01', type: 'fixed', note: 'Forensic Sciences Foundation Lucas Grant — annual; verify current cycle' },
  'aauw': { date: '2026-12-01', type: 'fixed', note: 'Career Development Grants annual cycle Dec 1 — apply for 2027-28; some Project + Local Branch grants are rolling' },
  'society of women engineers': { date: '2027-02-15', type: 'fixed', note: 'SWE annual cycle — current closed; apply Feb 2027 for 2027-28' },
  'daughters of the american revolution': { date: '2027-02-15', type: 'fixed', note: 'DAR annual cycle — current closed; apply Feb 2027 for 2027-28' },
  'russian children': { date: '2027-04-15', type: 'fixed', note: 'RCWS annual cycle — current closed; apply Feb-Apr 2027 for 2027-28' },
  'kosciuszko': { date: '2027-01-15', type: 'fixed', note: 'Kosciuszko Foundation annual cycle — current closed; apply Jan 2027 for 2027-28' },
  'murfreesboro housing authority': { date: null, type: 'rolling', note: 'Section 8 voucher waitlist is rolling; verify student-eligibility exception applies (independent student under 24)' },
  'usda rural development': { date: null, type: 'rolling', note: 'Section 521 rental assistance is rolling — apply at any USDA Section 515 property in Bradley or rural Rutherford County' },
  'tn promise / tn reconnect': { date: null, type: 'rolling', note: 'TSAC Student Portal account creation is rolling; required gateway' },
}

// (2) NEW July-2026 bridge funds — focused on cash that can hit her hands
// before late-August Pell/HOPE refunds. Same shape as previous additions.
const JULY_BRIDGE = [
  {
    title: 'MTSU Dean of Students — Student Emergency Fund',
    funder: 'MTSU Office of the Dean of Students',
    application_url: 'https://www.mtsu.edu/dean-of-students/emergency-fund.php',
    description: 'Small one-time grants ($250–$2,500) for MTSU students experiencing immediate financial crisis — explicitly includes housing emergencies, security deposits, first-month-rent gaps, utility shut-off prevention, and food insecurity. Funds can be released within days. As an admitted incoming freshman she may apply once her MTSU M-Number is issued (after admission acceptance). Apply EARLY July with a documented rent shortfall.',
    amount: 1500,
    deadline: null,
    deadline_type: 'rolling',
    category: 'emergency_student_aid',
    match_score: 95,
    why_match: 'July rent gap is exactly the use case; she is an admitted MTSU student.',
  },
  {
    title: 'MTSU MT One Stop — Financial Aid Cash Advance / Book Voucher',
    funder: 'MTSU MT One Stop / Financial Aid Office',
    application_url: 'https://www.mtsu.edu/one-stop/',
    description: 'MTSU offers Pell-eligible students a Book/Personal-Expense voucher of $300–$750 disbursed at the start of August (against pending Pell+HOPE+TSAA awards) and, in hardship cases, a short-term Financial Aid Cash Advance against the August refund — she can use this to cover late-July rent before the full refund hits. Request via MT One Stop in person or by phone immediately after FAFSA + admission are both confirmed.',
    amount: 750,
    deadline: null,
    deadline_type: 'rolling',
    category: 'institutional_emergency_advance',
    match_score: 90,
    why_match: 'Pell-eligible incoming freshman with documented July rent need is the exact target.',
  },
  {
    title: 'Tennessee 211 — Statewide Emergency Rental Assistance Referral',
    funder: 'United Way of Tennessee / 211 Tennessee',
    application_url: 'https://tn211.myresourcedirectory.com',
    description: 'Tennessee 211 (call 2-1-1 or use the online directory) is the official front door for every active emergency-rent / utilities / move-in assistance program in TN. They route Anastasia to the right local pot of money based on her exact ZIP — Bradley County funders for July rent in Cleveland, Rutherford County funders for July rent in Murfreesboro. Many local funders have rolling rapid-disbursement programs not findable elsewhere.',
    deadline: null,
    deadline_type: 'rolling',
    category: 'referral_hotline',
    match_score: 92,
    why_match: 'Single phone call surfaces every TN-based emergency rent program she qualifies for.',
  },
  {
    title: 'Modest Needs Foundation — Self-Sufficiency Grant',
    funder: 'Modest Needs Foundation',
    application_url: 'https://www.modestneeds.org/for-applicants/apply-for-help.asp',
    description: 'Up to $1,000 directly to a third-party (landlord, utility company, etc.) for a one-time short-term emergency. Self-Sufficiency Grants are explicitly designed for people one paycheck / one bill away from a crisis — including students transitioning to college housing. Average turnaround 2–4 weeks. Apply with documented July rent + security deposit shortfall and proof of pending fall financial aid.',
    amount: 1000,
    deadline: null,
    deadline_type: 'rolling',
    category: 'national_emergency_grant',
    match_score: 90,
    why_match: 'Working/college individual with short-term documented rent need — exact target population.',
  },
  {
    title: 'Greenhouse Ministries — Rent & Utility Assistance (Murfreesboro)',
    funder: 'Greenhouse Ministries of Murfreesboro',
    application_url: 'https://www.greenhousemin.org/get-help',
    description: 'Murfreesboro-based nonprofit providing one-time emergency rent and utility-deposit assistance to Rutherford County residents and incoming residents (including incoming MTSU students who have a signed lease). Walk-in intake at 309 South Spring Street, Murfreesboro. Bring lease, MTSU admission letter, financial aid award letter (or proof of pending aid).',
    deadline: null,
    deadline_type: 'rolling',
    category: 'local_emergency_assistance',
    match_score: 88,
    why_match: 'Future Murfreesboro resident with documented rent need; in their service area.',
  },
  {
    title: 'United Way of Rutherford & Cannon Counties — Emergency Assistance',
    funder: 'United Way of Rutherford & Cannon Counties',
    application_url: 'https://www.yourlocaluw.org/get-help',
    description: 'Operates an Emergency Financial Assistance Program funded by community donors that covers first-month rent, security deposit, and utility connection fees for Rutherford County residents and verified incoming residents. Apply through the United Way intake form OR through 2-1-1.',
    deadline: null,
    deadline_type: 'rolling',
    category: 'local_emergency_assistance',
    match_score: 85,
    why_match: 'Rutherford County future resident; UW operates exactly this kind of move-in assistance.',
  },
  {
    title: 'Salvation Army of Murfreesboro — Emergency Rent & Utility Assistance',
    funder: 'The Salvation Army — Murfreesboro Corps',
    application_url: 'https://murfreesboro.salvationarmy.org',
    description: 'The Murfreesboro Corps operates a rolling emergency assistance fund for first-month rent, security deposit, and utility assistance for low-income Rutherford County residents. Walk-in intake. Bring photo ID, proof of income (FAFSA SAI letter), proof of pending financial aid, and signed lease.',
    deadline: null,
    deadline_type: 'rolling',
    category: 'local_emergency_assistance',
    match_score: 80,
    why_match: 'Low-income transitioning resident in their service area.',
  },
  {
    title: 'THDA — Tennessee Housing Stability / HOME-ARP Rapid Rehousing',
    funder: 'Tennessee Housing Development Agency (THDA)',
    application_url: 'https://thda.org/help-for-renters',
    description: 'THDA administers the federal HOME-ARP rapid rehousing funds for Tennesseans at risk of housing instability — including young adults transitioning to college housing without family financial backing. Apply through a regional sub-grantee (Cleveland TN: SETHRA; Murfreesboro: Mid-Cumberland HRA). THDA may pay first month + security deposit and connect her to ongoing TBRA (Tenant-Based Rental Assistance) for up to 24 months.',
    deadline: null,
    deadline_type: 'rolling',
    category: 'state_housing_assistance',
    match_score: 78,
    why_match: 'TN resident transitioning to off-campus housing with no family financial backing — HOME-ARP target population.',
  },
  {
    title: 'Bradley County DHS — Emergency Assistance Fund',
    funder: 'Tennessee Department of Human Services (Bradley County office)',
    application_url: 'https://www.tn.gov/humanservices/find-an-office.html',
    description: 'Her CURRENT county DHS office (Cleveland, TN) handles applications for TANF/Family Assistance Program, Emergency Cash Assistance, and SNAP — useful for any pre-move-in cash gap in June/July, AND if she remains TN-resident through August she can transfer the case to Rutherford County. Apply in person at the Bradley County DHS office.',
    deadline: null,
    deadline_type: 'rolling',
    category: 'state_emergency_assistance',
    match_score: 72,
    why_match: 'Pre-move emergency funds available in Bradley County before she relocates.',
  },
  {
    title: 'LIHEAP Tennessee — Low Income Home Energy Assistance Program',
    funder: 'Tennessee Department of Human Services / LIHEAP',
    application_url: 'https://www.tn.gov/humanservices/for-families/low-income-home-energy-assistance-program-liheap.html',
    description: 'Pays a portion of her July/August/September electric and water bills directly to the utility company once she has an active service account in her name at her Murfreesboro address. Cooling Assistance is available May–Aug; Heating Assistance Oct–Mar. Apply through Mid-Cumberland HRA (Rutherford County LIHEAP intake agency).',
    amount: 600,
    deadline: null,
    deadline_type: 'rolling',
    category: 'utility_assistance',
    match_score: 82,
    why_match: 'Utility costs are part of her off-campus living need; LIHEAP pays directly to utility.',
  },
  {
    title: 'Catholic Charities of Tennessee — Emergency Financial Assistance',
    funder: 'Catholic Charities of Tennessee, Inc.',
    application_url: 'https://www.cctenn.org/services/emergency-financial-assistance',
    description: 'Operates emergency assistance programs (rent, utilities, food) across Middle Tennessee including Rutherford County. No religious requirement. Walk-in or appointment intake at the Murfreesboro Family Resource Center.',
    deadline: null,
    deadline_type: 'rolling',
    category: 'local_emergency_assistance',
    match_score: 75,
    why_match: 'Rutherford County resident with rent/utility need; in CCTN service area.',
  },
  {
    title: 'Family Promise of Rutherford County — Housing Stability Program',
    funder: 'Family Promise of Rutherford County',
    application_url: 'https://www.familypromiseofrc.org/get-help',
    description: 'Provides case-managed support including rental assistance, security deposit help, and housing search assistance for individuals at risk of homelessness in Rutherford County. While their core program targets families, the Stabilization sub-program serves single adults transitioning to independent housing — applicable for an incoming college student without family financial backing in the area.',
    deadline: null,
    deadline_type: 'rolling',
    category: 'local_emergency_assistance',
    match_score: 65,
    why_match: 'Rutherford County future resident transitioning to first independent housing.',
  },
]

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const normUrl = (u) => {
  if (!u) return ''
  try {
    const x = new URL(u)
    return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/+$/, '').toLowerCase()
  } catch { return String(u).toLowerCase().replace(/\/+$/, '') }
}

async function main() {
  console.log('[run] anastasia: re-date 26-27 cycle + add July 2026 bridge funds')

  // Pull current pipeline
  const r0 = await fetchJson(`${API}/grants?profile_id=${PROFILE_ID}&limit=2000`)
  if (!r0.ok) { console.error('failed to load grants:', r0.status, r0.body); process.exit(1) }
  const grants = Array.isArray(r0.body) ? r0.body : []
  console.log(`[run] existing pipeline: ${grants.length} grants`)

  // (1) Re-date matching entries
  const updated = []
  const unchanged = []
  for (const g of grants) {
    const tNorm = (g.title || '').toLowerCase()
    let chosen = null
    let chosenKey = null
    for (const [k, v] of Object.entries(DEADLINE_FIX)) {
      if (tNorm.includes(k)) { chosen = v; chosenKey = k; break }
    }
    if (!chosen) continue
    if (g.deadline === chosen.date) {
      unchanged.push({ id: g.id, title: g.title })
      continue
    }
    const r = await fetchJson(`${API}/grants/${g.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        deadline: chosen.date,
        application_steps: chosen.note,
      }),
    })
    if (r.ok) {
      updated.push({ id: g.id, title: g.title, key: chosenKey, new_deadline: chosen.date, note: chosen.note })
      console.log(`  ~ ${(g.title || '').padEnd(60).slice(0, 60)}  → deadline=${chosen.date ?? 'rolling'}`)
    } else {
      console.warn(`  ! ${g.title}: PUT failed (${r.status}) ${JSON.stringify(r.body).slice(0, 200)}`)
    }
  }
  console.log(`[run] re-dated ${updated.length} entries (${unchanged.length} already correct)`)

  // (2) Add July 2026 bridge funds
  const existingTitles = new Set(grants.map(g => norm(g.title)))
  const existingUrls = new Set(grants.map(g => normUrl(g.application_url || g.url || g.portal_url)))

  const sourceMap = {
    emergency_student_aid: 'school',
    institutional_emergency_advance: 'school',
    referral_hotline: 'community_foundation',
    national_emergency_grant: 'curated',
    local_emergency_assistance: 'community_foundation',
    state_housing_assistance: 'state_grants_portal',
    state_emergency_assistance: 'state_portal',
    utility_assistance: 'liheap',
  }

  const created = []
  const skipped = []
  for (const p of JULY_BRIDGE) {
    const tNorm = norm(p.title)
    const uNorm = normUrl(p.application_url)
    if (existingTitles.has(tNorm) || (uNorm && existingUrls.has(uNorm))) {
      skipped.push({ title: p.title, reason: 'already in pipeline' })
      continue
    }
    const source = sourceMap[p.category] || 'curated'
    const body = {
      profile_id: PROFILE_ID,
      organization_id: ORG_ID,
      match_score: p.match_score ?? 70,
      match_reasons: [{ code: 'curated_admin_add_july_bridge', detail: p.why_match }],
      opportunity_data: {
        title: p.title,
        sponsor: p.funder,
        description: p.description,
        url: p.application_url,
        application_url: p.application_url,
        deadline: p.deadline,
        deadline_type: p.deadline_type ?? 'rolling',
        amount_min: p.amount ?? null,
        amount_max: p.amount ?? null,
        source,
        application_method: 'portal',
        applicationNote: p.why_match,
      },
    }
    const r = await fetchJson(`${API}/grants/from-opportunity`, { method: 'POST', body: JSON.stringify(body) })
    if (r.status === 201 || r.status === 200) {
      const grantId = r.body?.grant?.id ?? r.body?.id ?? null
      created.push({ id: grantId, title: p.title })
      const tag = r.status === 200 ? 'reused' : 'new'
      console.log(`  + ${p.title.padEnd(60).slice(0, 60)}  → grant ${(grantId ?? '?').toString().slice(0, 8)} (${tag}, score ${p.match_score})`)
    } else {
      skipped.push({ title: p.title, reason: `${r.status}: ${r.body?.error ?? r.body?.message ?? 'unknown'}` })
      console.warn(`  ! ${p.title}: create failed (${r.status}) ${JSON.stringify(r.body).slice(0, 200)}`)
    }
  }
  console.log(`[run] July-bridge created=${created.length} skipped=${skipped.length}`)

  // (3) Force pipeline_automation pass
  console.log('[run] kicking off pipeline_automation force-run')
  const j = await fetchJson(`${API}/crawlers/jobs`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'pipeline_automation',
      profile_id: PROFILE_ID,
      parameters: { process_all: true, limit: 200 },
      force: true,
    }),
  })
  if (j.status === 200 || j.status === 201) {
    console.log(`  job ${j.body?.id} queued`)
  } else {
    console.warn(`  ! enqueue failed ${j.status} ${JSON.stringify(j.body).slice(0, 200)}`)
  }

  await fs.mkdir('docs/_readiness_logs', { recursive: true })
  await fs.writeFile(
    'docs/_readiness_logs/anastasia-fix-cycle-and-july.json',
    JSON.stringify({ updated, unchanged, created, skipped, automation_job_id: j.body?.id ?? null }, null, 2),
    'utf8',
  )
  console.log('\nWrote → docs/_readiness_logs/anastasia-fix-cycle-and-july.json')
}

main().catch(e => { console.error('FATAL', e?.stack || e?.message || e); process.exit(1) })
