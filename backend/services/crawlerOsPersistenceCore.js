// backend/services/crawlerOsPersistence.js
//
// Bridges the Crawler OS (which runs against an in-memory store, synchronously)
// to the live GrantFlow database (which is async under Postgres). The OS spine
// stays untouched and dialect-free; this adapter does the async flush:
//
//   1. profileContextToThesisInput  — GrantFlow loadProfileContext() -> the
//      tolerant profile shape buildThesis() consumes.
//   2. persistRun                   — flush the OS memory store's catalog,
//      provenance, and per-profile matches into the live tables:
//        funding_opportunities         (GLOBAL catalog; mapped to legacy columns)
//        opportunity_sources           (which crawler(s) found each canonical opp)
//        profile_opportunity_matches   (per-profile score — the ONLY place score lives)
//
// Idempotent: re-running upserts by id / (profile_id, opportunity_id).

import { storage } from '../crawler-os/index.js';
import { recordDismissal, reconcileDismissedGrants } from './pipelineDismissals.js';
import { PROTECTED_PIPELINE_STATUSES } from '../startup/enforceInvariants.js';
import { likelySameGrantOpportunity } from '../utils/grantFingerprint.js';
import { resolveOpportunityAmounts } from './awardAmountExtractor.js';
import { cleanupDisallowedHamiltonTraces } from './hamilton/hamiltonFundingSourcePolicy.js';
import { buildLivePageFactColumns } from '../crawler-os/pageFacts.js';
import { classifyLocatorKindFromRow, GENERIC_OVERRIDABLE_KINDS } from './sources/locatorUrlKind.js';
import { correctedGeoScopeFromTitle } from '../config/opportunityJurisdiction.js';
import {
  cleanInstitutionName,
  resolveSeedInstitutions,
  MAX_ATTENDED_INSTITUTIONS,
} from '../config/profileInstitutions.js';
import { deriveProfileFacts, searchTermsFromFacts } from '../config/profileDerivedFacts.js';
import { stampMatchConfidenceProvenance } from './matching/matchConfidenceProvenance.js';
import { syncOpportunityContractProjection } from './opportunityRepository.js';
import { grantsGovDetailIdFromUrl } from '../../shared/grantsGovProtocol.js';
import { withIdentityTxn } from './opportunityIdentityStore.js';
import { buildCrawlerProfileRoute } from './profileTypeRegistry.js';

const nowIso = () => new Date().toISOString();
const PROTECTED = new Set(PROTECTED_PIPELINE_STATUSES);

/**
 * prunePipelineRejects — remove BAD MATCHES from the profile's pipelines. After
 * the OS scores a profile, any opportunity it decided REJECT (ineligible, unsafe,
 * below floor, loan/cost-share disallowed, off-topic) that is sitting in that
 * profile's pipeline at a NON-protected (discovery) stage is dismissed via the
 * canonical sticky-delete (recordDismissal + reconcileDismissedGrants), so it
 * cannot resurface. User-progressed/awarded work (PROTECTED_PIPELINE_STATUSES)
 * is never auto-purged — that invariant is preserved.
 *
 * @returns {number} count of pipeline entries dismissed
 */
async function prunePipelineRejects(db, memStore, idRemap) {
  const catalogById = new Map(memStore.all('funding_opportunities').map((o) => [o.id, o]));
  const rejects = memStore
    .all('profile_opportunity_matches')
    .filter((m) => m.decision === 'reject');
  let dismissed = 0;
  for (const m of rejects) {
    const oppId = idRemap.get(m.opportunity_id) ?? m.opportunity_id;
    const osOpp = catalogById.get(m.opportunity_id) ?? null;
    const liveOpp = osOpp ? { ...osOppToLiveRow(osOpp), id: oppId } : { id: oppId };
    // Fixture/minimal DBs may lack optional grant columns (fingerprint, funder…)
    // — degrade to skipping the prune rather than failing the whole persist,
    // mirroring cleanupHamiltonRejects below.
    let grants = [];
    try {
      grants = await db
        .prepare('SELECT id, status, funding_opportunity_id, fingerprint, title, funder, deadline, url, application_url FROM grants WHERE profile_id = ?')
        .all(m.profile_id);
    } catch {
      continue;
    }
    const matchingGrants = (grants || []).filter((g) => {
      if (g.funding_opportunity_id === oppId) return true;
      return likelySameGrantOpportunity(liveOpp, g);
    });
    if (matchingGrants.length === 0) continue;
    if (matchingGrants.some((g) => g.status && PROTECTED.has(g.status))) continue;
    for (const grantRow of matchingGrants) {
      await recordDismissal(db, {
        profileId: m.profile_id,
        grantRow,
        opportunity: liveOpp,
        reason: 'crawler_os_reject',
      });
      dismissed += 1;
    }
  }
  if (dismissed > 0) await reconcileDismissedGrants(db);
  return dismissed;
}

async function cleanupHamiltonRejects(db, memStore, idRemap) {
  const rejects = memStore
    .all('profile_opportunity_matches')
    .filter((m) => m.decision === 'reject');
  let cleaned = 0;

  for (const m of rejects) {
    const oppId = idRemap.get(m.opportunity_id) ?? m.opportunity_id;
    let grants = [];
    try {
      grants = await db
        .prepare('SELECT id FROM grants WHERE profile_id = ? AND funding_opportunity_id = ?')
        .all(m.profile_id, oppId);
    } catch {
      grants = [];
    }

    const targets = [{ opportunityId: oppId, grantId: null }];
    for (const grant of grants || []) targets.push({ opportunityId: oppId, grantId: grant.id });

    for (const target of targets) {
      try {
        const result = await cleanupDisallowedHamiltonTraces(db, {
          profileId: m.profile_id,
          opportunityId: target.opportunityId,
          grantId: target.grantId,
          reason: 'crawler_os_reject',
        });
        cleaned += Object.values(result || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      } catch {
        // Hamilton cleanup is protective but never allowed to break crawler persistence.
      }
    }
  }

  return cleaned;
}

function jparse(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function asList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).filter(Boolean);
  if (v instanceof Set) return [...v].map((x) => String(x ?? '')).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map((x) => String(x ?? '')).filter(Boolean);
      } catch {
        // Fall through to scalar string.
      }
    }
    return [s];
  }
  return [String(v)];
}

/**
 * Parse an OS structured-list column without turning malformed objects into
 * applicant/need facts. Blank, malformed, or unknown input stays unknown.
 */
function structuredList(v) {
  let value = v;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try { value = JSON.parse(text); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function structuredGeography(v) {
  const raw = jparse(v, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const states = structuredList(raw.states);
  const counties = structuredList(raw.counties);
  const zips = structuredList(raw.zips);
  const cities = structuredList(raw.cities);
  const regions = structuredList(raw.regions);
  // `national:false` with no scoped values is the OS contract's default, not a
  // source statement. Treat it as UNKNOWN so a blank recrawl cannot erase a
  // previously learned geography.
  const national = raw.national === true;
  if (!national && states.length === 0 && counties.length === 0 && zips.length === 0 && cities.length === 0 && regions.length === 0) {
    return null;
  }
  return { national, states, counties, zips, cities, regions };
}

async function fundingOpportunityColumns(db) {
  try {
    if (db?.dialect === 'postgres') {
      const rows = await db.prepare(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'funding_opportunities'`,
      ).all();
      return new Set((rows || []).map((row) => row.column_name).filter(Boolean));
    }
    const rows = await db.prepare('PRAGMA table_info(funding_opportunities)').all();
    return new Set((rows || []).map((row) => row.name).filter(Boolean));
  } catch {
    // Narrow legacy/fake DB adapters may not expose schema introspection. Core
    // columns still follow the existing path; optional columns are omitted.
    return new Set();
  }
}

/** Coerce a section's data to a plain object (it may be an object or JSON string). */
function sectionObj(v) {
  if (!v) return {};
  if (typeof v === 'string') return jparse(v, {}) || {};
  if (typeof v === 'object') return v;
  return {};
}

/**
 * Clean a free-text institution / employer name for use as a search seed.
 * The canonical rule lives in `config/profileInstitutions.js` so the discovery
 * seed path and the institution-aid boot sweep cannot drift apart.
 */
const cleanName = cleanInstitutionName;

/**
 * extractEducationEmployment — pull the concrete SCHOOL name(s), field of study,
 * and employer from a profile's sections. These are the highest-signal seeds for
 * institution-specific and employer-specific funding (endowed/departmental
 * scholarships, employer tuition programs) which are findable ONLY by name — the
 * generic geo/type/need queries structurally cannot reach them.
 *
 * Priority for schools: the CURRENT / COMMITTED institution first (that's where a
 * student's real institutional aid lives), then declared/target colleges. Bounded
 * to keep the query set small.
 */
function extractEducationEmployment(sections = {}) {
  const edu = sectionObj(sections.education);
  const spp = sectionObj(sections.student_portal_plan);
  const occ = sectionObj(sections.occupation);
  const emp = sectionObj(sections.employment);
  const orgd = sectionObj(sections.organization_details);

  // Schools — attendance (current / committed / declared) first, then
  // aspiration (other applications, target colleges). The FIELD REGISTRY is
  // canonical (`config/profileInstitutions.js`): the institution-aid boot sweep
  // reads the SAME registry, so a new school field cannot reach one consumer
  // and silently miss the other. Seeding may use aspiration — only the MATCH
  // gate is restricted to attendance.
  const schools = resolveSeedInstitutions(sections, { limit: MAX_ATTENDED_INSTITUTIONS });

  // Field of study / major (breadth seed only — never used for scoring).
  const field_of_study = cleanName(edu.intended_major || spp.major || edu.major || '');

  // Employer — for a worker profile, employer-specific tuition/education programs
  // are a real funding class. Only use a concrete declared employer; never mine
  // narrative free-text (fabrication/junk risk).
  const employer = cleanName(
    emp.employer || occ.employer || emp.current_employer || occ.employer_name || orgd.name || '',
  );

  return { schools, field_of_study: field_of_study || null, employer };
}

/**
 * Section data → signal TEXT for the thesis blob. Raw JSON.stringify leaked
 * every FIELD NAME into the free-text scan — a section shaped
 * `{ firefighter: false, veteran: false }` injected the words "firefighter"
 * and "veteran" into the blob and fired applicant/need keyword rules for
 * profiles that explicitly declared those facts FALSE (the Axiom 13-bucket
 * class, 2026-07-06). The honest signal text is:
 *   - string/number values, kept as-is;
 *   - a TRUE boolean's field name, humanized ("ssi_recipient_household" →
 *     "ssi recipient household") — for booleans the key IS the meaning;
 *   - false / null / empty values contribute NOTHING (declaring a fact false
 *     must never inject the fact's words).
 */
export function sectionSignalText(data, depth = 0) {
  if (data === null || data === undefined || data === false || data === true || depth > 4) return '';
  if (typeof data === 'string' || typeof data === 'number') return String(data).trim();
  if (Array.isArray(data)) return data.map((v) => sectionSignalText(v, depth + 1)).filter(Boolean).join(' ');
  if (typeof data === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === true) parts.push(String(k).replace(/_/g, ' '));
      else {
        const text = sectionSignalText(v, depth + 1);
        if (text) parts.push(text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

/**
 * profileContextToThesisInput — map a loadProfileContext() result into the shape
 * buildThesis() understands. buildThesis is tolerant (it gathers free text and
 * matches keyword/synonym tables), so the goal is to surface every signal the
 * profile carries: type, location, needs, org, documents, sections.
 */
export function profileContextToThesisInput(ctx = {}) {
  const profile = ctx.profile ?? {};
  const sections = ctx.sections ?? {};
  const signals = ctx.signals ?? {};
  const org = ctx.organization ?? null;
  const rawProfileType = profile.primary_type ?? profile.applicant_type ?? profile.profile_type ?? null;
  const profileRoute = buildCrawlerProfileRoute(rawProfileType);

  const sectionList = Object.entries(sections).map(([key, data]) => ({
    title: key,
    body: typeof data === 'string' ? data : sectionSignalText(data),
  }));

  const signalNeedsDefaulted = signals.needsDefaulted === true;
  const explicitNeedCategories = [
    // loadProfileContext can retain the registry/type fallback in both
    // signals.needs and signals.needCategories. Once provenance says those
    // signals were defaulted, neither collection is a user declaration.
    ...(signalNeedsDefaulted ? [] : asList(signals.needCategories)),
    ...asList(profile.needs),
    ...asList(profile.need_categories),
    ...asList(ctx.facets?.intent?.primary_need_category),
  ].filter(Boolean);
  const inferredNeedCategories = signalNeedsDefaulted
    ? []
    : [
        ...asList(signals.needs),
        ...asList(ctx.profileNorm?.needCategories),
        ...asList(ctx.profileNorm?.needs),
        // Rolling compatibility for snapshots created before loadProfileContext
        // standardized on profileNorm. Never prefer this legacy key.
        ...asList(ctx.normalized?.needCategories),
      ].filter(Boolean);
  const needsSource = explicitNeedCategories.length > 0
    ? 'profile_declared_or_faceted'
    : inferredNeedCategories.length > 0
      ? 'whole_profile_inference'
      : profileRoute.default_needs.length > 0
        ? 'profile_type_default'
        : 'unknown';
  const needCategories = [
    ...explicitNeedCategories,
    ...inferredNeedCategories,
    ...(needsSource === 'profile_type_default' ? profileRoute.default_needs : []),
  ];
  const keywordTerms = [
    ...asList(profile.interests),
    ...asList(profile.keywords),
    ...asList(signals.keywords),
    ...asList(signals.keywordSet),
    ...asList(ctx.facets?.intent?.keywords),
  ];

  const location = signals.location ?? {};

  // Concrete school / field-of-study / employer seeds for institution- and
  // employer-specific funding (endowments, departmental & employer scholarships).
  const { schools, field_of_study, employer } = extractEducationEmployment(sections);

  // DERIVED TOPICAL FACTS — the profile's OWN statements about what it studies
  // and does, ordered by evidence strength and carrying provenance.
  //
  // WHY THIS IS EXPLICIT AND NOT LEFT TO `tags`. `buildThesis` used to build its
  // `interest_terms` (the ONLY topical seed the open-web query builder consumes)
  // by taking `.slice(0, 12)` of `tags` — which is `signals.keywords`, an
  // UNRANKED bag. Measured on Demo Tennessee STEM Student's live prod profile 2026-08-02
  // that bag holds 453 entries: display-name tokens, gender synonyms, prose
  // fragments and bare stopwords first, her actual field vocabulary at index
  // 127+. The twelve slots resolved to
  //   ['demo_stem_student','nicole','white','female','woman','women','girl','girls',
  //    'female-led','led','female identifying','identifying']
  // for a student whose `education.intended_major` is "Forensic Science". The
  // system held the fact and did not reason from it.
  //
  // `tags` is left EXACTLY as it was — ~14 consumers test canonical tokens on it
  // (the `signals.health` precedent). This adds a ranked, provenanced channel
  // beside it; it does not narrow the old one.
  const derivedFacts = deriveProfileFacts(profile, sections);

  return {
    id: profile.id ?? ctx.profileId ?? null,
    profile_type: profileRoute.canonical_profile_type ?? rawProfileType,
    profile_route: {
      ...profileRoute,
      needs_source: needsSource,
      sections_considered: Object.keys(sections).sort(),
      document_count: Array.isArray(ctx.documents) ? ctx.documents.length : 0,
      organization_considered: Boolean(org),
      profile_norm_considered: Boolean(ctx.profileNorm ?? ctx.normalized),
    },
    // Structured age for the engine's hard eligibility gates (age-restricted
    // and age-contradicted programs) — the thesis is the OS match path's only
    // profile representation, so the fact must ride on it.
    age: (() => {
      const raw = sections?.basic_information?.age ?? profile.age ?? null
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 && n < 120 ? n : null
    })(),
    schools,
    field_of_study,
    employer,
    // Structured SERVICE STATUS for the applicant-type derivation. The section
    // is carried as its raw object, not as rendered text: `sectionSignalText`
    // renders a section's prose too, and a `military_service.notes` reading "No
    // military affiliation ... indicating veteran status" contains the word
    // "veteran" inside its own denial (deriveApplicantTypes' NEGATION TRAP note).
    // Only an explicit `true` flag declares service.
    military_service: sections?.military_service ?? null,
    // Ranked, provenanced topical seeds. `buildThesis` prefers these over the
    // unranked `tags` slice; see the note above.
    derived_interest_terms: searchTermsFromFacts(derivedFacts),
    // The full fact set, carried onto the thesis so LANE SELECTION (planner.js)
    // and the query builder read the SAME derivation — the owner's rule that the
    // crawlers always pull from the profile BEFORE crawling and decide which
    // crawlers are appropriate from what they read.
    derived_facts: derivedFacts,
    // The profile's DECLARED health vocabulary, carried so LANE SELECTION can
    // ask a condition lane for a condition. `health_conditions` and
    // `health_support` are the provenance-split sets `profileHelpers` already
    // records (a diagnosis vs a support need); the union is used because a
    // support need can legitimately name the very thing a lane serves —
    // Demo Health Education Persona carries `arthritis` in SUPPORT, not conditions,
    // and dropping arthritis_foundation_help for him would be a real loss.
    // `signals.health` (the UNION with free text and flags) is deliberately
    // NOT used: ~14 consumers test canonical tokens on it and it is exactly
    // the conflated bag the provenance split was created to stop reading.
    declared_health_terms: [...new Set([
      ...asList(signals.health_conditions),
      ...asList(signals.health_support),
    ].map((t) => String(t ?? '').trim()).filter(Boolean))],
    applicant_types: [...new Set([
      ...profileRoute.applicant_types,
      ...(Array.isArray(signals.applicantTypes) ? signals.applicantTypes
        : (signals.applicantTypes ? [...signals.applicantTypes] : [])),
    ].map((value) => String(value ?? '').trim()).filter(Boolean))],
    name: profile.display_name ?? null,
    tags: [...new Set([...asList(profile.tags), ...keywordTerms].filter(Boolean))],
    need_categories: [...new Set(needCategories.filter(Boolean))],
    sections: sectionList,
    organizations: org ? [{ name: org.name, type: org.organization_type ?? org.nonprofit_type, mission: org.mission }] : [],
    documents: Array.isArray(ctx.documents)
      ? ctx.documents.map((d) => ({ name: d.title ?? d.name, extracted_text: d.extracted_text, summary: d.summary }))
      : [],
    location: {
      state: location.state ?? profile.state ?? null,
      states: [...new Set([
        location.state,
        ...asList(signals.states),
      ].map((value) => String(value ?? '').trim().toUpperCase()).filter(Boolean))],
      county: location.county ?? null,
      zip: location.zip ?? profile.postal_code ?? profile.zip_code ?? null,
      city: location.city ?? profile.city ?? null,
    },
    // honesty doctrine: loans/cost-share off unless the profile opted in.
    allow_loans: profile.allow_loans === true,
    allow_cost_share: profile.allow_cost_share === true,
    min_match_score: Number.isFinite(profile.min_match_score) ? profile.min_match_score : undefined,
  };
}

/** Map one OS catalog row (memory-store shape) to live funding_opportunities columns. */
function osOppToLiveRow(o, supportedColumns = new Set()) {
  const geo = structuredGeography(o.geography_json);
  const applicantTypes = structuredList(o.applicant_types_json);
  const needCats = structuredList(o.need_categories_json);
  const state = geo?.states?.[0] ?? null;
  const rollingText = String(o.is_rolling ?? '').toLowerCase();
  const isRolling = o.is_rolling === true || o.is_rolling === 1 || rollingText === 'true' || rollingText === '1';
  // Amount visibility: structured OS amounts win; otherwise conservatively
  // extract per-award dollars / status ("varies", "contact funder") from the
  // title+summary text so web-lane rows never land amount-blank when the page
  // said something. NULL status = nothing learned (never downgrades on upsert).
  const amounts = resolveOpportunityAmounts({
    amount_min: typeof o.amount_min === 'number' ? o.amount_min : null,
    amount_max: typeof o.amount_max === 'number' ? o.amount_max : null,
    title: o.title,
    description: o.summary,
  });
  // KIND: a verified structural URL-shape claim (sam.gov /fal/ assistance
  // listing, ssa.gov benefit page, studentaid.gov, ProPublica 990 profile…)
  // outranks the OS pipeline's machine-stamped kind. This is the WRITER-side
  // half of the tug-of-war fix: the locator_kind_classification boot sweep
  // repaired ~387 rows every night and never converged because this bridge
  // re-stamped 'PROGRAM'/'DIRECT_GRANT' over the sweep's classification on
  // every re-crawl. The classifier claims nothing about ordinary award pages,
  // so every other row keeps the OS kind unchanged.
  const structuralKind = classifyLocatorKindFromRow({
    source_url: o.info_url ?? null,
    application_url: o.apply_url ?? null,
    evidence_url: o.evidence_url ?? null,
  });
  const row = {
    id: o.id,
    title: o.title ?? '(untitled opportunity)', // only NOT NULL column
    sponsor: o.sponsor ?? null,
    description: o.summary ?? null,
    source: o.source_id ?? null,
    source_id: o.external_id ?? null,
    source_url: o.info_url ?? null,
    application_url: o.apply_url ?? null,
    apply_url: o.apply_url ?? null,
    deadline: o.deadline ?? null,
    amount_min: amounts.amount_min,
    amount_max: amounts.amount_max,
    amount_text: amounts.amount_text,
    amount_status:
      amounts.amount_status === 'not_listed' && !amounts.amount_text ? null : amounts.amount_status,
    amount_confidence: amounts.amount_confidence,
    is_loan: o.is_loan ? 1 : 0,
    requires_match: o.requires_cost_share ? 1 : 0,
    // Structured eligibility and geography are appended below only when this
    // crawl actually stated a fact. (Geo scope is corrected after the whole
    // row exists.)
    opportunity_kind: structuralKind?.kind ?? o.kind ?? null,
    source_trust_tier: o.trust_tier ?? null,
    reality_status: o.reality_status ?? null,
    record_origin: 'live_crawl', // CHECK: live_crawl|curated_verified|manual|synthetic
    canonical_opportunity_key: o.canonical_opportunity_key ?? null,
    fingerprint: o.canonical_opportunity_key ?? null,
    evidence_url: o.evidence_url ?? null,
    is_active: 1,
    is_hidden: 0,
    last_crawled: nowIso(),
    // HONESTY: source capture (fetching the LISTING/aggregator page) is NOT a
    // verification of THIS opportunity's own application target. `o.fetched_at`
    // is when we scraped the source page — stamping it into `last_verified_at`
    // lied ("verified" in the UI), and made linkVerificationService SKIP these
    // rows for ~30 days so their real target was never checked. Only genuine
    // TARGET verification (linkVerificationService probing the final URL) may set
    // `last_verified_at`; leaving it out here also means upsert never overwrites a
    // real prior verification. Source timestamps live on last_crawled/discovered_at.
    discovered_at: o.created_at ?? nowIso(),
    updated_at: nowIso(),
  };

  // LIVE structured eligibility. Empty arrays mean "unknown", so they are
  // omitted on recrawl and can never wipe a prior sourced answer.
  if (needCats.length > 0) row.categories = JSON.stringify(needCats);
  if (applicantTypes.length > 0 && supportedColumns.has('entity_types_allowed')) {
    row.entity_types_allowed = JSON.stringify(applicantTypes);
  }
  if (needCats.length > 0 && supportedColumns.has('need_types_supported')) {
    row.need_types_supported = JSON.stringify(needCats);
  }

  // A missing deadline and a rolling deadline are different facts. The live
  // DATE column has no `is_rolling`, so deadline_type is the lossless bridge.
  if (supportedColumns.has('deadline_type')) {
    row.deadline_type = isRolling ? 'rolling' : (o.deadline ? 'fixed' : 'unknown');
  }
  if (supportedColumns.has('deadline_status')) {
    row.deadline_status = isRolling ? 'rolling' : (o.deadline ? null : 'unknown');
  }
  if (supportedColumns.has('purpose') && o.purpose) row.purpose = o.purpose;
  if (supportedColumns.has('open_date') && o.open_date) row.open_date = o.open_date;
  if (supportedColumns.has('recurrence') && o.recurrence) row.recurrence = o.recurrence;
  if (supportedColumns.has('current_status') && o.source_status) row.current_status = o.source_status;
  if (supportedColumns.has('first_published_at') && o.first_published_at) {
    row.first_published_at = o.first_published_at;
  }
  if (supportedColumns.has('required_documents')) {
    const requiredDocuments = structuredList(o.required_documents_json);
    if (requiredDocuments.length > 0) row.required_documents = JSON.stringify(requiredDocuments);
  }
  if (supportedColumns.has('application_method') && o.application_method) {
    row.application_method = o.application_method;
  }

  if (geo) {
    const liveRegions = [...new Set([...geo.states, ...geo.regions])];
    row.is_national = geo.national ? 1 : 0;
    row.state = state;
    if (supportedColumns.has('regions')) row.regions = JSON.stringify(liveRegions);
    if (supportedColumns.has('geo_county') && (geo.national || geo.counties.length > 0)) {
      row.geo_county = geo.counties[0] ?? null;
    }
    if (supportedColumns.has('geo_zip') && (geo.national || geo.zips.length > 0)) {
      row.geo_zip = geo.zips[0] ?? null;
    }
    if (supportedColumns.has('geo_scope')) {
      row.geo_scope = geo.national ? 'national'
        : (geo.zips.length ? 'zip' : (geo.counties.length ? 'county' : 'state'));
    }
    // Preserve every stated geography member in the existing JSON field; the
    // scalar columns remain indexed compatibility projections.
    if (supportedColumns.has('geo_eligibility')) row.geo_eligibility = JSON.stringify(geo);
  }

  // Page-fact provenance (Phase 0.1) — additive, NULL-default plumbing so a
  // later profile-blind extractor can carry per-field evidence into the catalog.
  // The OS->live mapping + per-`kind` validation lives in the pageFacts registry
  // (buildLivePageFactColumns), which emits a live column ONLY when the OS row
  // carries a VALIDATED fact. That keeps THREE promises at once —
  //   (1) a run that learned nothing writes the exact same row as before this
  //       change (zero behavior change; minimal fixture tables without these
  //       columns keep working),
  //   (2) an upsert never DOWNGRADES stored provenance back to null on a later
  //       re-crawl that lacks it (a blank/empty/malformed fact is omitted, and
  //       the live INTEGER column never sees '' which Postgres rejects), and
  //   (3) when the extractor DOES provide facts, they round-trip faithfully.
  // NOTE: `field_provenance` here is the incoming whole-object; persistRun merges
  // it per-key with the LIVE row so a partial re-crawl never drops stored keys.
  Object.assign(row, buildLivePageFactColumns(o));

  // GEO SCOPE, writer side. County/city locator rows are minted per-place with
  // the place ONLY in the title ("Polk County, TN — Local assistance programs
  // near you (findhelp)") and no geography_json, so `state` lands NULL and
  // `is_national` lands 1 — which tells the geo gate this county resource is a
  // NATIONWIDE program. Every profile in the fleet then scores geographically
  // eligible for every other profile's county, and the cross-profile lane pushes
  // those out-of-state locators ABOVE the profile's own in-state row. Reading the
  // state the row already declares about itself is not new information. Only
  // NULL-state + national rows are touched, so this is idempotent and can never
  // override a scope the source actually supplied. Boot net for rows already
  // written this way: enforceDeclaredGeoScope() in startup/enforceInvariants.js.
  const correctedScope = correctedGeoScopeFromTitle(row);
  if (correctedScope) Object.assign(row, correctedScope);

  return row;
}

/**
 * upsertRow — INSERT ... ON CONFLICT DO UPDATE. `conflictExpr` optionally maps a
 * column to the SQL expression used on the UPDATE side (default `excluded.<col>`)
 * so a column can be MERGED with its current value ATOMICALLY inside the single
 * statement (no read-then-write race). The expression may reference `excluded.`
 * (the would-be-inserted value) and `<table>.<col>` (the current stored value).
 */
async function upsertRow(db, table, keyCols, row, { conflictExpr = {} } = {}) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter((c) => !keyCols.includes(c))
    .map((c) => `${c} = ${conflictExpr[c] ?? `excluded.${c}`}`)
    .join(', ');
  const sql =
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${updates}`;
  await db.prepare(sql).run(...cols.map((c) => row[c]));
}

/**
 * fundingOpportunityConflictExpr — the per-column UPDATE-side overrides for a
 * funding_opportunities upsert. `field_provenance` is MERGED with the
 * currently-stored value INSIDE the statement, so two concurrent persists can't
 * read-then-clobber each other (the round-3 race). The merge is SHALLOW /
 * top-level / incoming-wins-per-key: an incoming field's object FULLY REPLACES
 * the stored field's object (no stale nested keys), other fields are kept.
 *
 * Postgres: `jsonb ||` is already a shallow top-level merge.
 * SQLite: json_patch is a RECURSIVE (RFC 7396) merge that would keep stale
 * nested keys and DIVERGE from Postgres, so we rebuild the object explicitly
 * from json_each of both sides — existing keys NOT present in incoming, UNION
 * all incoming keys (incoming wins) — via json_group_object, with json(value) so
 * nested objects keep their type. Both are one atomic UPSERT expression.
 */
function fundingOpportunityConflictExpr(db, supportedColumns = new Set(), incomingRow = {}) {
  const provExpr = db?.dialect === 'postgres'
    ? "(COALESCE(funding_opportunities.field_provenance, '{}')::jsonb || excluded.field_provenance::jsonb)::text"
    : `(
        SELECT json_group_object(key, json(value)) FROM (
          SELECT key, value FROM json_each(COALESCE(funding_opportunities.field_provenance, '{}'))
            WHERE key NOT IN (SELECT key FROM json_each(COALESCE(excluded.field_provenance, '{}')))
          UNION ALL
          SELECT key, value FROM json_each(COALESCE(excluded.field_provenance, '{}'))
        )
      )`;
  // opportunity_kind: the stored value survives when it is a canonical
  // structural classification ('directory'/'benefit' — a verified judgment)
  // and the incoming value is one of the generic machine-stamped ingest kinds;
  // an incoming NULL never wipes a stored kind either. This is the UPDATE-side
  // net under the writer-side structural override in osOppToLiveRow: together
  // they end the sweep-vs-writer tug-of-war over locator/benefit rows.
  // audit:allow dynamic-sql — GENERIC_OVERRIDABLE_KINDS is a frozen code-constant list.
  const overridableList = GENERIC_OVERRIDABLE_KINDS.map((k) => `'${k}'`).join(', ');
  const kindExpr = `CASE
        WHEN LOWER(COALESCE(funding_opportunities.opportunity_kind, '')) IN ('directory', 'benefit')
         AND COALESCE(excluded.opportunity_kind, '') IN (${overridableList})
        THEN funding_opportunities.opportunity_kind
        ELSE COALESCE(excluded.opportunity_kind, funding_opportunities.opportunity_kind)
      END`;
  // AMOUNT COLUMNS: silence never clears a learned answer (invariant-133 /
  // the #950 wipe class — CAUGHT LIVE 2026-07-25: the deploy-boot sweep wrote
  // 7 real grants.gov award figures via the API adapter at 17:08Z and the
  // ordinary crawl cycle re-upserted those same rows at 17:09–17:22Z with the
  // default `amount_min = excluded.amount_min` — every figure wiped to NULL
  // within minutes, while the row stayed BURNED as enriched. This is why
  // amount coverage sat pinned for weeks no matter how much the sweeps
  // learned. The inserter path (opportunityInserter ON CONFLICT) has had these
  // exact COALESCE guards all along; this bridge — the highest-volume writer —
  // never got them. A crawl that DID extract a real amount still updates.
  const keep = (col) => `COALESCE(excluded.${col}, funding_opportunities.${col})`;
  const keepNonemptyArray = (col) => `CASE
        WHEN excluded.${col} IS NULL OR TRIM(excluded.${col}) IN ('', '[]')
        THEN funding_opportunities.${col}
        ELSE excluded.${col}
      END`;
  const falseSql = db?.dialect === 'postgres' ? 'FALSE' : '0';
  const trueSql = db?.dialect === 'postgres' ? 'TRUE' : '1';
  const terminalParts = [];
  if (supportedColumns.has('status')) {
    terminalParts.push(`LOWER(COALESCE(funding_opportunities.status, 'active')) IN
      ('expired', 'deadline_expired', 'deadline_passed', 'retired', 'permanently_retired', 'quarantined')`);
  }
  if (supportedColumns.has('link_status')) {
    terminalParts.push(`LOWER(COALESCE(funding_opportunities.link_status, 'unverified')) IN
      ('expired', 'deadline_expired', 'deadline_passed', 'retired', 'permanently_retired', 'quarantined')`);
  }
  if (supportedColumns.has('deadline_status')) {
    terminalParts.push(`LOWER(COALESCE(funding_opportunities.deadline_status, 'unknown')) IN
      ('expired', 'closed', 'retired')`);
  }
  if (supportedColumns.has('verification_error')) {
    terminalParts.push("COALESCE(funding_opportunities.verification_error, '') LIKE 'retired_after_definitive_recheck:%'");
  }
  const terminal = terminalParts.length ? terminalParts.join(' OR ') : '0 = 1';
  const clearFixedDeadlineForRolling = supportedColumns.has('deadline_type')
    ? "WHEN excluded.deadline_type IN ('rolling', 'ongoing') THEN NULL"
    : '';
  const out = {
    // Recrawl is never a lifecycle restoration mechanism. A verifier or an
    // explicit owner action owns restoration; the high-volume writer keeps
    // quarantined/retired/deadline-expired visibility state atomically.
    is_active: `CASE
        WHEN ${terminal} THEN ${falseSql}
        WHEN COALESCE(funding_opportunities.is_active, ${trueSql}) = ${falseSql}
        THEN funding_opportunities.is_active
        ELSE excluded.is_active
      END`,
    is_hidden: `CASE
        WHEN ${terminal} THEN ${trueSql}
        WHEN COALESCE(funding_opportunities.is_active, ${trueSql}) = ${falseSql}
        THEN ${trueSql}
        WHEN COALESCE(funding_opportunities.is_hidden, ${falseSql}) = ${trueSql}
        THEN funding_opportunities.is_hidden
        ELSE excluded.is_hidden
      END`,
    field_provenance: provExpr,
    opportunity_kind: kindExpr,
    deadline: `CASE
        WHEN ${terminal} THEN funding_opportunities.deadline
        ${clearFixedDeadlineForRolling}
        ELSE ${keep('deadline')}
      END`,
    amount_min: keep('amount_min'),
    amount_max: keep('amount_max'),
    amount_text: keep('amount_text'),
    amount_status: keep('amount_status'),
    amount_confidence: keep('amount_confidence'),
  };
  if (supportedColumns.has('entity_types_allowed')) out.entity_types_allowed = keepNonemptyArray('entity_types_allowed');
  if (supportedColumns.has('need_types_supported')) out.need_types_supported = keepNonemptyArray('need_types_supported');
  if (supportedColumns.has('categories')) out.categories = keepNonemptyArray('categories');
  if (supportedColumns.has('deadline_type')) {
    out.deadline_type = `CASE
        WHEN ${terminal} THEN funding_opportunities.deadline_type
        WHEN excluded.deadline_type IS NULL OR excluded.deadline_type = 'unknown'
        THEN COALESCE(funding_opportunities.deadline_type, excluded.deadline_type)
        ELSE excluded.deadline_type
      END`;
  }
  if (supportedColumns.has('deadline_status')) {
    const clearStaleRollingStatus = supportedColumns.has('deadline_type')
      ? "WHEN excluded.deadline_type = 'fixed' THEN NULL"
      : '';
    out.deadline_status = `CASE
        WHEN ${terminal} THEN funding_opportunities.deadline_status
        ${clearStaleRollingStatus}
        WHEN excluded.deadline_status IS NULL OR excluded.deadline_status = 'unknown'
        THEN COALESCE(funding_opportunities.deadline_status, excluded.deadline_status)
        ELSE excluded.deadline_status
      END`;
  }
  if (Object.prototype.hasOwnProperty.call(incomingRow, 'is_national')) {
    out.is_national = 'excluded.is_national';
    if (incomingRow.is_national) {
      if (supportedColumns.has('state')) out.state = 'excluded.state';
      if (supportedColumns.has('regions')) out.regions = 'excluded.regions';
      if (supportedColumns.has('geo_county')) out.geo_county = 'excluded.geo_county';
      if (supportedColumns.has('geo_zip')) out.geo_zip = 'excluded.geo_zip';
    } else {
      if (supportedColumns.has('state')) out.state = keep('state');
      if (supportedColumns.has('regions')) out.regions = keepNonemptyArray('regions');
      if (supportedColumns.has('geo_county')) out.geo_county = keep('geo_county');
      if (supportedColumns.has('geo_zip')) out.geo_zip = keep('geo_zip');
    }
    if (supportedColumns.has('geo_scope')) out.geo_scope = keep('geo_scope');
    if (supportedColumns.has('geo_eligibility')) out.geo_eligibility = keep('geo_eligibility');
  }
  return out;
}

/**
 * persistRun — flush an OS memory-store run into the live DB.
 * @param {object} db   live app DB (getDb()) — sync under SQLite, async under PG; awaited either way.
 * @param {object} memStore  the createMemoryStore() the run wrote to.
 * @param {object} run   the runDiscovery result (telemetry).
 * @returns {{opportunities:number, matches:number, sources:number}}
 */
/**
 * ensureOsTables — self-heal the Crawler OS persistence schema on any DB (fresh
 * test DBs, prod, local) regardless of migration state. Idempotent + tolerant:
 * mirrors migrations 121/122 so persistRun never hits "no such table/column".
 */
async function ensureOsTables(db) {
  const isPg = db.dialect === 'postgres';
  const ts = isPg ? 'TIMESTAMPTZ' : 'DATETIME';
  const stmts = [
    `CREATE TABLE IF NOT EXISTS opportunity_sources (
       opportunity_id TEXT NOT NULL, source_id TEXT NOT NULL,
       external_id TEXT, apply_url TEXT, first_seen_at ${ts}, last_seen_at ${ts},
       PRIMARY KEY (opportunity_id, source_id))`,
    `CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
       id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
       match_score REAL, match_confidence REAL, match_decision TEXT, match_explanation TEXT, match_reasons TEXT,
       match_explain_json TEXT, matcher_version TEXT, computed_at ${ts}, updated_at ${ts}, evaluated_at ${ts})`,
  ];
  for (const sql of stmts) { try { await db.prepare(sql).run(); } catch { /* exists */ } }
  // additive columns (tolerant — may already exist)
  const addCols = [
    ['funding_opportunities', 'canonical_opportunity_key', 'TEXT'],
    // Amount visibility (migration 132 / pg 0136).
    ['funding_opportunities', 'amount_text', 'TEXT'],
    ['funding_opportunities', 'amount_status', 'TEXT'],
    ['funding_opportunities', 'amount_confidence', 'REAL'],
    ['profile_opportunity_matches', 'match_explanation', 'TEXT'],
    ['profile_opportunity_matches', 'match_confidence', 'REAL'],
    ['profile_opportunity_matches', 'match_reasons', 'TEXT'],
    ['profile_opportunity_matches', 'match_explain_json', 'TEXT'],
    ['profile_opportunity_matches', 'matcher_version', 'TEXT'],
    ['profile_opportunity_matches', 'computed_at', ts],
    ['profile_opportunity_matches', 'updated_at', ts],
    // Crawler-doctor provenance (migration 133 / pg 0137).
    ['profile_opportunity_matches', 'source_query', 'TEXT'],
    ['profile_opportunity_matches', 'discovered_via', 'TEXT'],
  ];
  for (const [t, c, type] of addCols) {
    try { await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`).run(); } catch { /* exists */ }
  }
  try { await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_fo_canonical_key ON funding_opportunities(canonical_opportunity_key)').run(); } catch { /* ok */ }
  try { await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_pom_profile_opp ON profile_opportunity_matches(profile_id, opportunity_id)').run(); } catch { /* ok */ }
}

const GRANTS_GOV_DERIVED_SOURCES = new Set([
  'grants_gov',
  'grants.gov',
  'grants-gov',
  'fema_afg',
  'usda_rd',
]);

/**
 * Rolling identity migration for Search2 rows written before the public
 * opportunity number became the canonical source id.
 *
 * Old rows used Search2's internal detail id for source_id/key/id. New rows use
 * the public opportunity number while retaining that internal id in the
 * authoritative detail URL. Match only inside the Grants.gov-derived family and
 * require both the old detail id and old-key-or-detail-URL evidence, so this is
 * an alias upgrade rather than broad URL/title dedup.
 */
function grantsGovLegacyIdentityDescriptor(row) {
  const source = String(row?.source ?? '').trim().toLowerCase();
  if (!GRANTS_GOV_DERIVED_SOURCES.has(source)) return null;

  const publicSourceId = String(row?.source_id ?? '').trim();
  if (!publicSourceId) return null;

  const detailUrl = [row.application_url, row.apply_url, row.source_url]
    .find((value) => grantsGovDetailIdFromUrl(value));
  const detailId = grantsGovDetailIdFromUrl(detailUrl);
  if (!detailId || detailId.toLowerCase() === publicSourceId.toLowerCase()) return null;

  return {
    detailId,
    detailUrl,
    oldKey: `ext:${detailId.toLowerCase()}`,
  };
}

async function findGrantsGovIdentityRow(db, row) {
  const descriptor = grantsGovLegacyIdentityDescriptor(row);
  if (!descriptor) return null;

  const currentKey = String(row.canonical_opportunity_key ?? '').trim().toLowerCase();
  const currentFingerprint = String(row.fingerprint ?? '').trim().toLowerCase();
  const candidates = await db.prepare(
    `SELECT *
       FROM funding_opportunities
      WHERE (
          LOWER(COALESCE(canonical_opportunity_key, '')) = ?
          OR LOWER(COALESCE(fingerprint, '')) = ?
        )
         OR (
          LOWER(COALESCE(source, '')) IN ('grants_gov', 'grants.gov', 'grants-gov', 'fema_afg', 'usda_rd')
          AND CAST(source_id AS TEXT) = ?
          AND (
            LOWER(COALESCE(canonical_opportunity_key, '')) = ?
            OR LOWER(COALESCE(fingerprint, '')) = ?
            OR application_url = ?
            OR apply_url = ?
            OR source_url = ?
          )
        )`,
  ).all(
    currentKey,
    currentFingerprint,
    descriptor.detailId,
    descriptor.oldKey,
    descriptor.oldKey,
    descriptor.detailUrl,
    descriptor.detailUrl,
    descriptor.detailUrl,
  );

  const byId = new Map(
    (candidates || [])
      .filter((candidate) => candidate?.id)
      .map((candidate) => [String(candidate.id), candidate]),
  );
  if (byId.size > 1) {
    const error = new Error(
      `crawler-os Grants.gov identity conflict for detail id ${descriptor.detailId}: ${[...byId.keys()].sort().join(', ')}`,
    );
    error.code = 'CRAWLER_OS_GRANTS_GOV_IDENTITY_CONFLICT';
    throw error;
  }
  return byId.values().next().value ?? null;
}

export async function persistRun(db, memStore, run, opts = {}) {
  await ensureOsTables(db);
  const supportedOpportunityColumns = await fundingOpportunityColumns(db);
  // When a run matched against MULTIPLE profiles (Robert's cross-profile cycle),
  // primaryProfileId is the profile whose own discovery this was — its full
  // 'crawler-os' match set is authoritative (reconcile = delete+insert). EVERY
  // OTHER profile's matches are CROSS-matches (an opp this profile didn't search
  // for but is eligible to): they are written additively as 'crawler-os-xmatch'
  // with ON CONFLICT DO NOTHING, so a profile's own match always wins and the
  // primary reconcile never wipes them. Default (null) = legacy single-profile
  // behavior: reconcile every profile present in matchRows as 'crawler-os'.
  const primaryProfileId = opts.primaryProfileId ?? null;
  const catalog = storage.listCatalog(memStore);
  // Durable cross-RUN dedup at the live-DB boundary. funding_opportunities has a
  // UNIQUE(fingerprint) constraint; the OS id folds in source_id, so the same
  // real opportunity found by a different source/run carries a new id but the
  // SAME fingerprint (canonical key). Collapse to the existing canonical row and
  // remap this run's ids -> the stored id, so the global catalog never grows a
  // duplicate and the per-profile matches point at the one true row.
  const idRemap = new Map();
  let opportunities = 0;
  for (const o of catalog) {
    const row = osOppToLiveRow(o, supportedOpportunityColumns);
    const persistOpportunity = async (tx) => {
      let targetId = o.id;
      let beforeRow = await findGrantsGovIdentityRow(tx, row);
      if (beforeRow?.id) targetId = beforeRow.id;

      if (!beforeRow && row.canonical_opportunity_key) {
        const existing = await tx
          .prepare('SELECT * FROM funding_opportunities WHERE canonical_opportunity_key = ? LIMIT 1')
          .get(row.canonical_opportunity_key);
        if (existing?.id) {
          targetId = existing.id;
          beforeRow = existing;
        }
      }
      if (!beforeRow && row.fingerprint) {
        const existing = await tx
          .prepare('SELECT * FROM funding_opportunities WHERE fingerprint = ? LIMIT 1')
          .get(row.fingerprint);
        if (existing?.id) {
          targetId = existing.id;
          beforeRow = existing;
        }
      }
      if (!beforeRow) {
        beforeRow = await tx.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(targetId);
      }

      // LIVE-DB per-key provenance merge, done ATOMICALLY inside the single
      // UPSERT. For a legacy Grants.gov alias, this same write upgrades the
      // numeric key/source id onto the preserved catalog id.
      await upsertRow(tx, 'funding_opportunities', ['id'], { ...row, id: targetId }, {
        conflictExpr: fundingOpportunityConflictExpr(tx, supportedOpportunityColumns, row),
      });
      await syncOpportunityContractProjection(tx, targetId, row, {
        beforeRow: beforeRow ?? null,
        changedBy: 'crawler_os',
      });
      return targetId;
    };

    const identity = grantsGovLegacyIdentityDescriptor(row);
    const targetId = identity
      ? await withIdentityTxn(
        db,
        'grants_gov_search2_detail',
        identity.detailId.toLowerCase(),
        persistOpportunity,
      )
      : await persistOpportunity(db);
    idRemap.set(o.id, targetId);
    opportunities += 1;
  }

  // provenance (which sources found each canonical opportunity)
  const sourceRows = memStore.all('opportunity_sources');
  for (const s of sourceRows) {
    await upsertRow(db, 'opportunity_sources', ['opportunity_id', 'source_id'], {
      opportunity_id: idRemap.get(s.opportunity_id) ?? s.opportunity_id, source_id: s.source_id,
      external_id: s.external_id ?? null, apply_url: s.apply_url ?? null,
      first_seen_at: s.first_seen_at ?? nowIso(), last_seen_at: s.last_seen_at ?? nowIso(),
    }, {
      // An identity upgrade must not rewrite discovery history to "first seen
      // today". Keep the original timestamp while refreshing alias + last seen.
      conflictExpr: {
        first_seen_at: 'COALESCE(opportunity_sources.first_seen_at, excluded.first_seen_at)',
      },
    });
  }

  // per-profile matches (score lives ONLY here).
  // RECONCILE, don't accumulate: a fresh discovery run recomputes a profile's
  // full match set, so any prior crawler-os match for these profiles that is NOT
  // re-produced this run is stale (e.g. an opportunity the profile is no longer
  // eligible for after a thesis correction) and must be removed — otherwise the
  // profile silently keeps obsolete, ineligible matches.
  const matchRows = memStore.all('profile_opportunity_matches');
  const profileIds = [...new Set(matchRows.map((m) => m.profile_id).filter(Boolean))];
  // Reconcile own-discovery matches and stale cross-match spillover for the
  // active profile. The API reads this table directly, so rejects/xmatches must
  // not remain as visible results for a profile that just ran its own crawl.
  const reconcileProfiles = primaryProfileId ? [primaryProfileId] : profileIds;
  for (const pid of reconcileProfiles) {
    await db.prepare(
      `DELETE FROM profile_opportunity_matches
        WHERE profile_id = ? AND matcher_version IN ('crawler-os', 'crawler-os-xmatch')`,
    ).run(pid);
  }
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP';
  let matches = 0;
  let crossMatches = 0;
  for (const m of matchRows) {
    const explain = jparse(m.match_explain_json, {});
    const persistedExplainJson = JSON.stringify(stampMatchConfidenceProvenance(explain, {
      match_score: m.match_score,
      match_confidence: m.match_confidence,
      match_decision: m.decision,
    }));
    const oppId = idRemap.get(m.opportunity_id) ?? m.opportunity_id; // follow cross-run dedup remap
    const isPrimary = !primaryProfileId || m.profile_id === primaryProfileId;
    const decision = String(m.decision ?? '').toLowerCase();
    if (isPrimary) {
      if (decision === 'reject') continue;
      await upsertRow(db, 'profile_opportunity_matches', ['profile_id', 'opportunity_id'], {
        id: `${m.profile_id}:${oppId}`, // deterministic PK (table PK is id)
        profile_id: m.profile_id, opportunity_id: oppId,
        match_score: m.match_score,
        match_confidence: m.match_confidence ?? null,
        match_decision: m.decision ?? null,
        match_explanation: explain.why ?? null,
        match_reasons: JSON.stringify(explain.matched_needs ?? []),
        match_explain_json: persistedExplainJson,
        matcher_version: 'crawler-os',
        source_query: m.source_query ?? null,
        discovered_via: m.discovered_via ?? null,
        computed_at: nowIso(), updated_at: nowIso(), evaluated_at: nowIso(),
      });
      matches += 1;
    } else if (decision !== 'accept') {
      // CROSS-MATCH PRECISION (2026-08-03, the Demo College Student Persona report): a
      // cross-profile row is stored ONLY on ACCEPT. "An opp this profile didn't
      // search for but is ELIGIBLE to" means the engine endorsed the pair; a
      // cross-profile REVIEW is scored against a thesis STUB (no sections, no
      // signals — see matchCanonicalOpportunity) and is uncertainty, not
      // eligibility. Measured in prod 2026-08-03: 4,577 of 4,792 xmatch rows
      // were REVIEW — another state's housing finance agency, disease
      // directories for profiles with no declared condition, "Goldwater
      // Scholarship" at score 2 on churches and biolabs. A DIRECTORY can never
      // reach ACCEPT (the engine downgrades it to REVIEW by design), so no
      // cross-profile locator is ever stored — a locator lane is the OWN
      // planner's per-profile decision (servesDeclaredCondition/servesGeo),
      // and the profile's own crawl still stores its own REVIEW locators.
      // REJECT was already dropped; REVIEW now is too. Boot net:
      // enforceCrossProfileMatchPrecision (enforceInvariants.js).
      continue;
    } else {
      // Cross-match: a profile that did NOT search for this opp but is eligible
      // (engine ACCEPT). Additive (DO NOTHING) so the profile's own 'crawler-os'
      // match — if it has one for this opp — always wins. Robert clears
      // 'crawler-os-xmatch' once at cycle start, so these are rebuilt fresh each
      // cycle (no staleness).
      try {
        await db.prepare(
          `INSERT INTO profile_opportunity_matches
             (id, profile_id, opportunity_id, match_score, match_confidence, match_decision, match_explanation, match_reasons, match_explain_json, source_query, discovered_via, matcher_version, computed_at, updated_at, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'crawler-os-xmatch', ${nowFn}, ${nowFn}, ${nowFn})
           ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
        ).run(
          `xm:${m.profile_id}:${oppId}`, m.profile_id, oppId,
          m.match_score, m.match_confidence ?? null, m.decision ?? null, explain.why ?? null,
          JSON.stringify(explain.matched_needs ?? []), persistedExplainJson,
          m.source_query ?? null, m.discovered_via ?? null,
        );
        crossMatches += 1;
      } catch { /* opp may not be persisted (rejected at catalog) — skip */ }
    }
  }
  run.cross_matches = crossMatches;

  // Stamp profiles.last_discovery_at so the discovery routes treat these
  // profiles as discovered (OS-served) rather than discovery_pending. This is
  // the OS-native replacement for the legacy autoDiscoveryCrawlers stamp.
  // Tolerant: older DBs may lack the column (a boot invariant adds it).
  const stampIds = [...new Set(matchRows.map((m) => m.profile_id).filter(Boolean))];
  const stampExpr = db.dialect === 'postgres' ? 'now()' : "datetime('now')";
  for (const pid of stampIds) {
    try {
      await db.prepare(`UPDATE profiles SET last_discovery_at = ${stampExpr} WHERE id = ?`).run(pid);
    } catch {
      /* column may not exist on older local DBs — non-fatal */
    }
  }

  // Remove bad matches (OS REJECTs) from the profile's pipelines and Hamilton's
  // active traces. Hamilton audit events remain; active tasks/docs/links/auths do not.
  const pipelinePruned = await prunePipelineRejects(db, memStore, idRemap);
  const hamiltonCleaned = await cleanupHamiltonRejects(db, memStore, idRemap);

  // idRemap (os run id -> live canonical id) rides along so the service layer
  // can read the LIVE rows this run's recommendations landed on — the live row
  // is where nightly amount enrichment / kind classification recorded answers
  // this crawl's own extraction cannot see (a memory-store run starts blank).
  return { opportunities, matches, sources: sourceRows.length, rejected: run?.rejected ?? 0, pipelinePruned, hamiltonCleaned, idRemap };
}

export default { profileContextToThesisInput, persistRun };
