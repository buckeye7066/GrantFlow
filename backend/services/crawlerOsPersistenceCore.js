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

  const sectionList = Object.entries(sections).map(([key, data]) => ({
    title: key,
    body: typeof data === 'string' ? data : sectionSignalText(data),
  }));

  const needCategories = [
    ...asList(signals.needs),
    ...asList(signals.needCategories),
    ...asList(profile.needs),
    ...asList(profile.need_categories),
    ...asList(ctx.facets?.intent?.primary_need_category),
    ...asList(ctx.normalized?.needCategories),
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

  return {
    id: profile.id ?? ctx.profileId ?? null,
    profile_type: profile.primary_type ?? profile.applicant_type ?? null,
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
    applicant_types: Array.isArray(signals.applicantTypes) ? signals.applicantTypes
      : (signals.applicantTypes ? [...signals.applicantTypes] : []),
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
function osOppToLiveRow(o) {
  const geo = jparse(o.geography_json, {});
  const needCats = jparse(o.need_categories_json, []);
  const state = Array.isArray(geo.states) && geo.states.length ? geo.states[0] : null;
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
    is_national: geo.national ? 1 : 0,
    state,
    // (geo scope is corrected below, once the whole row exists)
    categories: JSON.stringify(needCats),
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
function fundingOpportunityConflictExpr(db) {
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
  return {
    field_provenance: provExpr,
    opportunity_kind: kindExpr,
    amount_min: keep('amount_min'),
    amount_max: keep('amount_max'),
    amount_text: keep('amount_text'),
    amount_status: keep('amount_status'),
    amount_confidence: keep('amount_confidence'),
  };
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
       match_score REAL, match_decision TEXT, match_explanation TEXT, match_reasons TEXT,
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

export async function persistRun(db, memStore, run, opts = {}) {
  await ensureOsTables(db);
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
    const row = osOppToLiveRow(o);
    let targetId = o.id;
    if (row.canonical_opportunity_key) {
      const existing = await db
        .prepare('SELECT id FROM funding_opportunities WHERE canonical_opportunity_key = ? LIMIT 1')
        .get(row.canonical_opportunity_key);
      if (existing && existing.id) targetId = existing.id;
    }
    if (targetId === o.id && row.fingerprint) {
      const existing = await db
        .prepare('SELECT id FROM funding_opportunities WHERE fingerprint = ? LIMIT 1')
        .get(row.fingerprint);
      if (existing && existing.id) targetId = existing.id;
    }
    idRemap.set(o.id, targetId);
    // LIVE-DB per-key provenance merge, done ATOMICALLY inside the single UPSERT
    // (fundingOpportunityConflictExpr) so two concurrent persists can't
    // read-then-clobber each other. The generic upsert would REPLACE the whole
    // field_provenance JSON — dropping keys another extraction stored — so the
    // conflict expression json_patch/jsonb-merges incoming over the current value
    // (incoming wins per key, existing keys survive). A write that carries no
    // provenance never names the column (osOppToLiveRow omits it), so stored
    // provenance is untouched; there is no read-then-write gap and no fetch that
    // could error into a null-clobber.
    await upsertRow(db, 'funding_opportunities', ['id'], { ...row, id: targetId }, {
      conflictExpr: fundingOpportunityConflictExpr(db),
    });
    opportunities += 1;
  }

  // provenance (which sources found each canonical opportunity)
  const sourceRows = memStore.all('opportunity_sources');
  for (const s of sourceRows) {
    await upsertRow(db, 'opportunity_sources', ['opportunity_id', 'source_id'], {
      opportunity_id: idRemap.get(s.opportunity_id) ?? s.opportunity_id, source_id: s.source_id,
      external_id: s.external_id ?? null, apply_url: s.apply_url ?? null,
      first_seen_at: s.first_seen_at ?? nowIso(), last_seen_at: s.last_seen_at ?? nowIso(),
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
    const oppId = idRemap.get(m.opportunity_id) ?? m.opportunity_id; // follow cross-run dedup remap
    const isPrimary = !primaryProfileId || m.profile_id === primaryProfileId;
    const decision = String(m.decision ?? '').toLowerCase();
    if (isPrimary) {
      if (decision === 'reject') continue;
      await upsertRow(db, 'profile_opportunity_matches', ['profile_id', 'opportunity_id'], {
        id: `${m.profile_id}:${oppId}`, // deterministic PK (table PK is id)
        profile_id: m.profile_id, opportunity_id: oppId,
        match_score: m.match_score,
        match_decision: m.decision ?? null,
        match_explanation: explain.why ?? null,
        match_reasons: JSON.stringify(explain.matched_needs ?? []),
        match_explain_json: m.match_explain_json ?? '{}',
        matcher_version: 'crawler-os',
        source_query: m.source_query ?? null,
        discovered_via: m.discovered_via ?? null,
        computed_at: nowIso(), updated_at: nowIso(), evaluated_at: nowIso(),
      });
      matches += 1;
    } else if (decision === 'reject') {
      // A REJECT cross-match is not a match — never store it as one.
      continue;
    } else {
      // Cross-match: a profile that did NOT search for this opp but is eligible.
      // Additive (DO NOTHING) so the profile's own 'crawler-os' match — if it has
      // one for this opp — always wins. Robert clears 'crawler-os-xmatch' once at
      // cycle start, so these are rebuilt fresh each cycle (no staleness).
      try {
        await db.prepare(
          `INSERT INTO profile_opportunity_matches
             (id, profile_id, opportunity_id, match_score, match_decision, match_explanation, match_reasons, match_explain_json, source_query, discovered_via, matcher_version, computed_at, updated_at, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'crawler-os-xmatch', ${nowFn}, ${nowFn}, ${nowFn})
           ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
        ).run(
          `xm:${m.profile_id}:${oppId}`, m.profile_id, oppId,
          m.match_score, m.decision ?? null, explain.why ?? null,
          JSON.stringify(explain.matched_needs ?? []), m.match_explain_json ?? '{}',
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
