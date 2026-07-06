// crawler-os/crawlerVocabulary.js
//
// Crawler-side vocabulary helpers. The planner decides WHICH sources should run;
// these helpers decide HOW each source should be queried and how raw source rows
// should be translated into more profile-aware candidate fields before the
// reality gate and match engine see them.
//
// This is intentionally dependency-free and conservative. It does not invent a
// grant's eligibility; it only extracts obvious signals from the source row so
// broad feeds like Grants.gov do not become shallow "*" matches.

const NEED_RULES = Object.freeze([
  ['housing', /\b(housing|rent|mortgage|homeless|shelter|utility|utilities)\b/i],
  ['food', /\b(food|nutrition|meal|meals|pantry|snap|hunger)\b/i],
  ['medical', /\b(health|medical|clinic|hospital|mental health|disability|treatment|prescription)\b/i],
  ['education', /\b(education|student|tuition|scholarship|college|university|school|training|workforce)\b/i],
  ['emergency', /\b(emergency|disaster|firefighter|firefighters|fire department|rescue|hazard|flood|storm|crisis|relief)\b/i],
  ['equipment', /\b(equipment|apparatus|gear|vehicle|vehicles|truck|trucks|ppe|tools|radios?|technology)\b/i],
  ['operations', /\b(operating|operations|capacity|payroll|staffing|general support|technical assistance)\b/i],
  ['capital', /\b(capital|construction|renovation|facility|facilities|infrastructure|building|improvement)\b/i],
  ['programs', /\b(program|programs|services|outreach|project|initiative)\b/i],
  ['technology', /\b(technology|broadband|internet|computer|software|digital|cybersecurity)\b/i],
  ['veterans', /\b(veteran|veterans|military|service member|servicemember)\b/i],
  ['energy', /\b(energy|weatherization|heating|solar|efficiency|electric|utility)\b/i],
]);

const APPLICANT_RULES = Object.freeze([
  ['vfd', /\b(volunteer fire|fire department|firefighter|firefighters|first responder|ems|rescue squad)\b/i],
  ['student', /\b(student|undergraduate|graduate student|pell|fafsa|college|university|tuition|scholarship)\b/i],
  ['school', /\b(k-12|school district|school|university|college|education agency)\b/i],
  ['nonprofit', /\b(nonprofit|non-profit|501\(c\)\(3\)|charity|community organization|ngo)\b/i],
  ['church', /\b(church|congregation|parish|faith-based|religious organization)\b/i],
  ['ministry', /\b(ministry|faith-based|religious organization|outreach ministry)\b/i],
  ['business', /\b(business|small business|company|employer|startup|entrepreneur)\b/i],
  ['farm', /\b(farm|farmer|ranch|agricultural producer|agricultural producers|rural business)\b/i],
  ['government', /\b(city|county|municipal|state agency|local government|tribal|public agency)\b/i],
  ['individual', /\b(individual|resident|household|family|parent|caregiver)\b/i],
]);

const SOURCE_QUERY_SEEDS = Object.freeze({
  grants_gov: ['grant funding'],
  sam_gov: ['federal assistance program'],
  usda_rd: ['USDA Rural Development', 'rural community facilities grant', 'rural utilities grant'],
  fema_afg: ['Assistance to Firefighters Grant', 'firefighter equipment grant', 'SAFER grant'],
  studentaid_gov: ['federal student aid grants'],
});

/** Build a deterministic, deduped query set for source adapters. */
export function buildCrawlerQueries(thesis = {}, source = {}, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 4;
  const needs = cleanList(thesis.needs);
  const applicants = cleanList(thesis.applicant_types).filter((x) => x !== '*');
  const keywords = cleanList(thesis.keywords);
  const primaryNeed = needs[0] ?? keywords[0] ?? null;
  const primaryApplicant = applicants[0] ?? null;
  const seeds = [];

  // Source anchors first. This keeps a FEMA crawler a FEMA crawler and a USDA
  // crawler a USDA crawler even when the profile contains generic words.
  seeds.push(...(SOURCE_QUERY_SEEDS[source.source_id] ?? []));

  // Research orgs: SBIR/STTR omnibus NOFOs (NIH/DOD/NSF) ARE posted on
  // grants.gov, but no generic need/applicant seed ever says "SBIR" — a
  // biotech's federal query set looked identical to a food pantry's. High
  // priority (right after the source anchor) so the query cap can't drop it.
  if (thesis.is_research_org) {
    seeds.push(`SBIR ${thesis.research_topic ?? ''}`.trim());
    seeds.push('small business innovation research');
  }

  if (primaryNeed && primaryApplicant) seeds.push(`${primaryNeed} ${primaryApplicant} grant`);
  if (needs.length && primaryApplicant) seeds.push(`${needs.join(' ')} ${primaryApplicant} funding`);
  for (const need of needs.slice(0, 3)) seeds.push(`${need} grant`);
  for (const applicant of applicants.slice(0, 2)) seeds.push(`${applicant} funding`);
  if (keywords.length) seeds.push(keywords.slice(0, 4).join(' '));
  seeds.push('grant');

  return unique(seeds.map(normalizeQuery).filter(Boolean)).slice(0, limit);
}

/** Infer concrete candidate applicant/need categories from obvious row text. */
export function inferCandidateProfile(raw = {}, source = {}) {
  const blob = rowText(raw);
  const inferredNeeds = NEED_RULES.filter(([, re]) => re.test(blob)).map(([name]) => name);
  const inferredApplicants = APPLICANT_RULES.filter(([, re]) => re.test(blob)).map(([name]) => name);

  return {
    need_categories: withFallback(inferredNeeds, source.need_categories),
    applicant_types: withFallback(inferredApplicants, source.applicant_types),
  };
}

/** Extract conservative funding flags so loans/cost-share are gated honestly. */
export function inferFundingFlags(raw = {}, defaults = {}) {
  // HIGH-PRECISION on purpose. Both flags trigger a HARD REJECT in the reality
  // gate for any profile that has not opted into loans / cost-share (the default
  // for everyone). A false positive therefore silently hides a real grant the
  // user qualifies for -- the worst possible outcome for a funding-discovery
  // product. So we bias hard toward NOT flagging: a passing mention of "loan" or
  // "matching funds" must never suppress a grant. We only flag when the
  // instrument itself is loan-primary, or a match is *explicitly required*.
  const title = String(raw.title ?? '');
  const blob = rowText(raw);

  // --- loans -------------------------------------------------------------
  // A grant whose name advertises a grant is never treated as a loan, even in a
  // combined "Loan and Grant" program -- the applicant can still pursue the
  // grant. We only flag loan-primary instruments (named in the title, or an
  // unambiguous loan instrument) when the title does NOT also offer a grant.
  const titleGrant = /\bgrants?\b/i.test(title);
  const titleLoan = /\bloans?\b/i.test(title);
  const loanInstrument = /\b(direct loans?|guaranteed loans?|loan guarantees?|loan program|micro-?loans?|revolving loan fund)\b/i.test(blob);
  const loanPrimary = !titleGrant && (titleLoan || loanInstrument);

  // --- cost-share / match ------------------------------------------------
  // We do NOT infer cost-share from free-text prose. The Grants.gov Search2
  // summary does not expose the structured "Cost Sharing or Matching
  // Requirement" field, and prose mentions are unreliable ("match encouraged",
  // "no match required", "leverage matching funds where possible"). Inferring a
  // requirement from such prose wrongly excluded real grants, so cost-share is
  // honored only from an explicit/structured flag passed in `defaults`. A
  // production adapter that reads the structured field should set it there.
  return {
    is_loan: Boolean(defaults?.is_loan) || loanPrimary,
    requires_cost_share: Boolean(defaults?.requires_cost_share),
  };
}

/** True when a raw source row appears to belong to the intended agency/program. */
export function agencyLooksLike(raw = {}, patterns = []) {
  const blob = rowText(raw);
  return patterns.some((p) => (p instanceof RegExp ? p.test(blob) : blob.toLowerCase().includes(String(p).toLowerCase())));
}

function rowText(raw = {}) {
  return [
    raw.title, raw.summary, raw.sponsor, raw.agency, raw.agency_code, raw.number,
    raw.external_id, raw.opp_status, raw.description,
  ].filter(Boolean).join(' ');
}

function cleanList(values = []) {
  return [...new Set((values ?? []).map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
}

function withFallback(inferred, fallback = []) {
  const concreteInferred = cleanList(inferred).filter((x) => x !== '*');
  if (concreteInferred.length) return unique(concreteInferred);
  const concreteFallback = cleanList(fallback).filter(Boolean);
  return concreteFallback.length ? unique(concreteFallback) : ['*'];
}

function normalizeQuery(q) {
  return String(q ?? '').replace(/\s+/g, ' ').trim();
}

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const key = String(v).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export default { buildCrawlerQueries, inferCandidateProfile, inferFundingFlags, agencyLooksLike };
