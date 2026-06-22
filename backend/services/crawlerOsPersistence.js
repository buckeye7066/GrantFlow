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
  const rejects = memStore
    .all('profile_opportunity_matches')
    .filter((m) => m.decision === 'reject');
  let dismissed = 0;
  for (const m of rejects) {
    const oppId = idRemap.get(m.opportunity_id) ?? m.opportunity_id;
    const grants = await db
      .prepare('SELECT id, status FROM grants WHERE profile_id = ? AND funding_opportunity_id = ?')
      .all(m.profile_id, oppId);
    if (!grants || grants.length === 0) continue;            // not in any pipeline → nothing to remove
    if (grants.some((g) => g.status && PROTECTED.has(g.status))) continue; // preserve user-progressed work
    await recordDismissal(db, {
      profileId: m.profile_id,
      // buildDismissalKey reads opportunity.id for the opportunity_id key.
      opportunity: { id: oppId },
      reason: 'crawler_os_reject',
    });
    dismissed += 1;
  }
  if (dismissed > 0) await reconcileDismissedGrants(db);
  return dismissed;
}

function jparse(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
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
    body: typeof data === 'string' ? data : JSON.stringify(data ?? {}),
  }));

  const needCategories = [
    ...(Array.isArray(signals.needCategories) ? signals.needCategories : []),
    ...(Array.isArray(profile.interests) ? profile.interests : []),
    ...(signals.keywordSet ? [...signals.keywordSet] : []),
  ];

  const location = signals.location ?? {};

  return {
    id: profile.id ?? ctx.profileId ?? null,
    profile_type: profile.primary_type ?? profile.applicant_type ?? null,
    applicant_types: Array.isArray(signals.applicantTypes) ? signals.applicantTypes
      : (signals.applicantTypes ? [...signals.applicantTypes] : []),
    name: profile.display_name ?? null,
    tags: Array.isArray(profile.tags) ? profile.tags : [],
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
  return {
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
    amount_min: o.amount_min ?? null,
    amount_max: o.amount_max ?? null,
    is_loan: o.is_loan ? 1 : 0,
    requires_match: o.requires_cost_share ? 1 : 0,
    is_national: geo.national ? 1 : 0,
    state,
    categories: JSON.stringify(needCats),
    opportunity_kind: o.kind ?? null,
    source_trust_tier: o.trust_tier ?? null,
    reality_status: o.reality_status ?? null,
    record_origin: 'live_crawl', // CHECK: live_crawl|curated_verified|manual|synthetic
    fingerprint: o.canonical_opportunity_key ?? null,
    evidence_url: o.evidence_url ?? null,
    is_active: 1,
    is_hidden: 0,
    last_crawled: nowIso(),
    last_verified_at: o.fetched_at ?? null,
    discovered_at: o.created_at ?? nowIso(),
    updated_at: nowIso(),
  };
}

async function upsertRow(db, table, keyCols, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter((c) => !keyCols.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
  const sql =
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${updates}`;
  await db.prepare(sql).run(...cols.map((c) => row[c]));
}

/**
 * persistRun — flush an OS memory-store run into the live DB.
 * @param {object} db   live app DB (getDb()) — sync under SQLite, async under PG; awaited either way.
 * @param {object} memStore  the createMemoryStore() the run wrote to.
 * @param {object} run   the runDiscovery result (telemetry).
 * @returns {{opportunities:number, matches:number, sources:number}}
 */
export async function persistRun(db, memStore, run) {
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
    if (row.fingerprint) {
      const existing = await db
        .prepare('SELECT id FROM funding_opportunities WHERE fingerprint = ? LIMIT 1')
        .get(row.fingerprint);
      if (existing && existing.id) targetId = existing.id;
    }
    idRemap.set(o.id, targetId);
    await upsertRow(db, 'funding_opportunities', ['id'], { ...row, id: targetId });
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
  for (const pid of profileIds) {
    await db.prepare(
      `DELETE FROM profile_opportunity_matches WHERE profile_id = ? AND matcher_version = 'crawler-os'`,
    ).run(pid);
  }
  let matches = 0;
  for (const m of matchRows) {
    const explain = jparse(m.match_explain_json, {});
    const oppId = idRemap.get(m.opportunity_id) ?? m.opportunity_id; // follow cross-run dedup remap
    await upsertRow(db, 'profile_opportunity_matches', ['profile_id', 'opportunity_id'], {
      id: `${m.profile_id}:${oppId}`, // deterministic PK (table PK is id)
      profile_id: m.profile_id, opportunity_id: oppId,
      match_score: m.match_score,
      match_decision: m.decision ?? null,
      match_explanation: explain.why ?? null,
      match_reasons: JSON.stringify(explain.matched_needs ?? []),
      match_explain_json: m.match_explain_json ?? '{}',
      matcher_version: 'crawler-os',
      computed_at: nowIso(), updated_at: nowIso(), evaluated_at: nowIso(),
    });
    matches += 1;
  }

  // Remove bad matches (OS REJECTs) from the profile's pipelines too.
  const pipelinePruned = await prunePipelineRejects(db, memStore, idRemap);

  return { opportunities, matches, sources: sourceRows.length, rejected: run?.rejected ?? 0, pipelinePruned };
}

export default { profileContextToThesisInput, persistRun };
