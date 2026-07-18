// crawler-os/storage.js
//
// THE storage services. Canonical semantics, enforced here (not in the UI):
//   - funding_opportunities is the GLOBAL catalog (NO profile_id).
//   - match score lives ONLY in profile_opportunity_matches (profile_id, opp_id).
//   - saved / hidden / pipeline / applications / documents are PROFILE-SCOPED:
//     a row for one profile can never be read as another's.
//   - pipeline stage transitions go through the canonical stages.assertTransition.
//   - rejected opportunities never enter the catalog.
//   - nothing fails silently; illegal operations throw.
//
// Backed by the abstract store (store.js). SCHEMA_DDL below is the production
// SQL contract for createSqlStore(db).

import { ACCEPTABLE_REALITY_STATUSES, canonicalOpportunityKey } from './contract.js';
import { PIPELINE_STAGE, isValidStage, assertTransition } from './stages.js';
import {
  cleanEligibilityText, cleanEligibilityBullets, cleanSchemaVersion,
  cleanFieldProvenance, mergeFieldProvenance,
} from './pageFacts.js';

const nowIso = () => new Date().toISOString();

// ---- catalog (global) -----------------------------------------------------

export function upsertSource(store, src) {
  return store.upsert('funding_sources', ['source_id'], {
    source_id: src.source_id, name: src.name, source_type: src.source_type,
    trust_tier: src.trust_tier, base_url: src.base_url,
    directory: src.directory ? 1 : 0, loan_allowed: src.loan_allowed ? 1 : 0,
    cost_share_allowed: src.cost_share_allowed ? 1 : 0,
    priority_score: src.priority_score ?? 0,
    refresh_frequency_days: src.refresh_frequency_days ?? 30,
    config_json: JSON.stringify({
      applicant_types: src.applicant_types, need_categories: src.need_categories,
      geography: src.geography, crawler_method: src.crawler_method,
      requires_env: src.requires_env, default_kinds: src.default_kinds,
    }),
    updated_at: nowIso(),
  });
}

/**
 * upsertOpportunity — write a canonical Opportunity into the GLOBAL catalog.
 * Refuses unacceptable reality statuses (no rejected rows leak in).
 *
 * DURABLE cross-source / cross-run dedup: every write computes a
 * source-independent canonicalOpportunityKey. If a catalog row already exists
 * under that key with a DIFFERENT id (the same real opportunity surfaced by a
 * different crawler, possibly on a later run), we do NOT create a second row —
 * we record the new source in opportunity_sources and return { deduped:true }.
 * This makes the run-local Map in pipeline.js a fast-path optimisation, while
 * the store is the permanent authority that keeps the catalog and the
 * recommendation count from inflating.
 *
 * @returns {{ stored:boolean, reason?:string, deduped?:boolean, canonical_id?:string }}
 */
export function upsertOpportunity(store, opp) {
  if (!ACCEPTABLE_REALITY_STATUSES.includes(opp.reality_status)) {
    return { stored: false, reason: `reality_status ${opp.reality_status} not catalog-acceptable` };
  }
  const now = nowIso();
  const canonicalKey = canonicalOpportunityKey(opp);

  // Durable dedup: a row for this real-world opportunity may already exist under
  // a different source-folded id (e.g. grants_gov stored it last week, fema_afg
  // re-finds it today). Collapse to the existing canonical row.
  const existing = store.get('funding_opportunities', { canonical_opportunity_key: canonicalKey });
  if (existing && existing.id !== opp.id) {
    recordOpportunitySource(store, existing.id, opp, now);
    // Do NOT discard page facts THIS crawler supplied — merge them into the
    // canonical row, never dropping a fact already stored there.
    if (hasAnyPageFact(opp)) {
      store.update('funding_opportunities', { id: existing.id }, mergePageFactColumns(existing, opp));
    }
    return { stored: false, deduped: true, canonical_id: existing.id };
  }

  // Page-fact provenance (Phase 0.1) — additive, null-default; validated and
  // MERGED with any fact already stored on this id so a re-crawl that lacks a
  // fact never nulls out one already learned (mirrors amount_status). Nothing
  // populates these yet — for existing rows they stay null/[].
  const existingById = store.get('funding_opportunities', { id: opp.id });
  const pageFacts = mergePageFactColumns(existingById, opp);

  store.upsert('funding_opportunities', ['id'], {
    id: opp.id, source_id: opp.source_id, external_id: opp.external_id, kind: opp.kind,
    canonical_opportunity_key: canonicalKey,
    title: opp.title, sponsor: opp.sponsor, summary: opp.summary,
    apply_url: opp.apply_url, info_url: opp.info_url, deadline: opp.deadline,
    is_rolling: opp.is_rolling ? 1 : 0,
    amount_min: opp.funding.amount_min, amount_max: opp.funding.amount_max,
    is_loan: opp.funding.is_loan ? 1 : 0, requires_cost_share: opp.funding.requires_cost_share ? 1 : 0,
    applicant_types_json: JSON.stringify(opp.applicant_types),
    need_categories_json: JSON.stringify(opp.need_categories),
    geography_json: JSON.stringify(opp.geography),
    eligibility_text: pageFacts.eligibility_text,
    eligibility_bullets_json: pageFacts.eligibility_bullets_json,
    page_fact_schema_version: pageFacts.page_fact_schema_version,
    field_provenance_json: pageFacts.field_provenance_json,
    trust_tier: opp.trust_tier, reality_status: opp.reality_status,
    content_hash: opp.evidence?.content_hash ?? null, evidence_url: opp.evidence?.url ?? null,
    fetched_at: opp.evidence?.fetched_at ?? null,
    created_at: opp.created_at ?? now, updated_at: now,
  });
  recordOpportunitySource(store, opp.id, opp, now);
  if (opp.evidence?.content_hash) {
    store.insert('opportunity_evidence', {
      opportunity_id: opp.id, url: opp.evidence.url ?? opp.apply_url ?? opp.info_url,
      content_hash: opp.evidence.content_hash, fetched_at: opp.evidence.fetched_at ?? now,
    });
  }
  return { stored: true };
}

/**
 * recordOpportunitySource — preserve which crawler(s) surfaced a given canonical
 * opportunity, idempotently (one row per opportunity_id + source_id). Lets the
 * catalog stay deduped while keeping full provenance of every source that found
 * the same real opportunity.
 */
function recordOpportunitySource(store, opportunityId, opp, now) {
  const source_id = opp.source_id ?? null;
  if (!source_id) return;
  const existing = store.get('opportunity_sources', { opportunity_id: opportunityId, source_id });
  if (existing) {
    store.update('opportunity_sources', { opportunity_id: opportunityId, source_id }, {
      external_id: opp.external_id ?? existing.external_id ?? null,
      apply_url: opp.apply_url ?? existing.apply_url ?? null,
      last_seen_at: now,
    });
    return;
  }
  store.insert('opportunity_sources', {
    opportunity_id: opportunityId, source_id,
    external_id: opp.external_id ?? null, apply_url: opp.apply_url ?? null,
    first_seen_at: now, last_seen_at: now,
  });
}

/** Does this opportunity carry ANY valid page fact worth persisting? */
function hasAnyPageFact(opp) {
  return Boolean(
    cleanEligibilityText(opp.eligibility_text) ||
    cleanEligibilityBullets(opp.eligibility_bullets).length ||
    cleanSchemaVersion(opp.page_fact_schema_version) ||
    cleanFieldProvenance(opp.field_provenance),
  );
}

/**
 * mergePageFactColumns — the OS-store page-fact column values to persist for a
 * write, validated and PRESERVING any fact already on the row that this write
 * lacks. A blank/empty/malformed incoming fact never overwrites a stored one;
 * provenance is merged per canonical field. Returns the OS-store column shape.
 */
function mergePageFactColumns(existing, opp) {
  const incomingText = cleanEligibilityText(opp.eligibility_text);
  const incomingBullets = cleanEligibilityBullets(opp.eligibility_bullets);
  const incomingVersion = cleanSchemaVersion(opp.page_fact_schema_version);
  const existingText = existing ? cleanEligibilityText(existing.eligibility_text) : null;
  const existingBullets = existing ? cleanEligibilityBullets(existing.eligibility_bullets_json) : [];
  const existingVersion = existing ? cleanSchemaVersion(existing.page_fact_schema_version) : null;
  const mergedProvenance = mergeFieldProvenance(
    existing ? existing.field_provenance_json : null,
    opp.field_provenance,
  );
  const bullets = incomingBullets.length ? incomingBullets : existingBullets;
  return {
    eligibility_text: incomingText ?? existingText,
    eligibility_bullets_json: JSON.stringify(bullets),
    page_fact_schema_version: incomingVersion ?? existingVersion,
    field_provenance_json: mergedProvenance ? JSON.stringify(mergedProvenance) : null,
  };
}

export function getOpportunity(store, id) { return store.get('funding_opportunities', { id }); }
export function countOpportunities(store) { return store.all('funding_opportunities').length; }
export function listCatalog(store) { return store.all('funding_opportunities'); }

// ---- per-profile matches (ONLY place score is persisted) ------------------

export function upsertMatch(store, match) {
  const now = nowIso();
  return store.upsert('profile_opportunity_matches', ['profile_id', 'opportunity_id'], {
    profile_id: match.profile_id, opportunity_id: match.opportunity_id,
    match_score: match.match_score, decision: match.decision,
    match_explain_json: JSON.stringify(match.match_explain ?? {}),
    // Crawler-doctor provenance: which query/lane produced this match (null
    // when the lane doesn't supply it — e.g. registry adapters keyed by source).
    source_query: match.source_query ?? null,
    discovered_via: match.discovered_via ?? null,
    created_at: now, updated_at: now,
  });
}

/** Matches for ONE profile only — enforces isolation at the query boundary. */
export function getMatchesForProfile(store, profileId, { minScore = 0 } = {}) {
  const rows = store.all('profile_opportunity_matches', { profile_id: profileId })
    .filter((m) => m.match_score >= minScore)
    .sort((a, b) => b.match_score - a.match_score);
  return rows.map((m) => {
    const o = store.get('funding_opportunities', { id: m.opportunity_id }) ?? {};
    return { ...m, title: o.title, sponsor: o.sponsor, kind: o.kind, apply_url: o.apply_url, reality_status: o.reality_status };
  });
}

// ---- saved / hidden (profile-scoped, persistent) --------------------------

export function saveOpportunity(store, profileId, opportunityId) {
  requireProfile(profileId);
  return store.upsert('profile_saved', ['profile_id', 'opportunity_id'], {
    profile_id: profileId, opportunity_id: opportunityId, saved_at: nowIso(),
  });
}
export function unsaveOpportunity(store, profileId, opportunityId) {
  return store.remove('profile_saved', { profile_id: profileId, opportunity_id: opportunityId });
}
export function getSaved(store, profileId) { return store.all('profile_saved', { profile_id: profileId }); }

export function hideOpportunity(store, profileId, opportunityId, reason = null) {
  requireProfile(profileId);
  return store.upsert('profile_hidden', ['profile_id', 'opportunity_id'], {
    profile_id: profileId, opportunity_id: opportunityId, reason, hidden_at: nowIso(),
  });
}
export function isHidden(store, profileId, opportunityId) {
  return Boolean(store.get('profile_hidden', { profile_id: profileId, opportunity_id: opportunityId }));
}
export function getHidden(store, profileId) { return store.all('profile_hidden', { profile_id: profileId }); }

// ---- pipeline (canonical 11-stage, profile-scoped, transition-guarded) ----

export function addToPipeline(store, profileId, opportunityId, stage = PIPELINE_STAGE.SAVED) {
  requireProfile(profileId);
  if (!isValidStage(stage)) throw new Error(`addToPipeline: invalid stage "${stage}"`);
  const now = nowIso();
  const existing = store.get('profile_pipeline_items', { profile_id: profileId, opportunity_id: opportunityId });
  if (existing) return existing;
  const item = store.insert('profile_pipeline_items', {
    profile_id: profileId, opportunity_id: opportunityId, stage, added_at: now, updated_at: now,
  });
  store.insert('pipeline_events', {
    profile_id: profileId, opportunity_id: opportunityId, from_stage: null, to_stage: stage, at: now,
  });
  return item;
}

/** Move a pipeline item to a new stage. Throws on illegal transition. */
export function moveStage(store, profileId, opportunityId, toStage) {
  const item = store.get('profile_pipeline_items', { profile_id: profileId, opportunity_id: opportunityId });
  if (!item) throw new Error('moveStage: pipeline item not found for this profile');
  assertTransition(item.stage, toStage); // loud failure on illegal move
  const now = nowIso();
  store.update('profile_pipeline_items',
    { profile_id: profileId, opportunity_id: opportunityId },
    { stage: toStage, updated_at: now });
  store.insert('pipeline_events', {
    profile_id: profileId, opportunity_id: opportunityId, from_stage: item.stage, to_stage: toStage, at: now,
  });
  return { ...item, stage: toStage };
}

export function getPipeline(store, profileId) { return store.all('profile_pipeline_items', { profile_id: profileId }); }

// ---- applications + documents (profile-scoped, from Hamilton) -------------

export function saveApplicationRecord(store, rec) {
  requireProfile(rec.profile_id);
  return store.upsert('profile_applications', ['profile_id', 'opportunity_id'], {
    profile_id: rec.profile_id, opportunity_id: rec.opportunity_id,
    pathway: rec.pathway, outcome: rec.outcome, confirmation: rec.confirmation ?? null,
    detail_json: JSON.stringify(rec.detail ?? {}), updated_at: nowIso(),
  });
}
export function getApplications(store, profileId) { return store.all('profile_applications', { profile_id: profileId }); }

export function saveDocument(store, doc) {
  requireProfile(doc.profile_id);
  return store.insert('profile_documents', {
    profile_id: doc.profile_id, opportunity_id: doc.opportunity_id ?? null,
    name: doc.name, kind: doc.kind, format: doc.format ?? 'md',
    content: doc.content ?? null, bytes: doc.bytes ?? null, created_at: nowIso(),
  });
}
export function getDocuments(store, profileId) { return store.all('profile_documents', { profile_id: profileId }); }

// ---- agent jobs / locks / heartbeats --------------------------------------

/** Acquire a named lock. Returns false if held & not stale. */
export function acquireLock(store, name, { ttlMs = 5 * 60_000, now = Date.now() } = {}) {
  const lock = store.get('agent_locks', { name });
  if (lock) {
    const age = now - Date.parse(lock.acquired_at);
    if (Number.isFinite(age) && age < ttlMs) return false; // held and fresh
    store.remove('agent_locks', { name }); // stale -> reclaim
  }
  store.insert('agent_locks', { name, acquired_at: new Date(now).toISOString() });
  return true;
}
export function releaseLock(store, name) { return store.remove('agent_locks', { name }) > 0; }
export function clearStaleLocks(store, { ttlMs = 5 * 60_000, now = Date.now() } = {}) {
  let cleared = 0;
  for (const lock of store.all('agent_locks')) {
    const age = now - Date.parse(lock.acquired_at);
    if (!Number.isFinite(age) || age >= ttlMs) { store.remove('agent_locks', { name: lock.name }); cleared++; }
  }
  return cleared;
}
export function heartbeat(store, agentId, { now = Date.now(), status = 'running' } = {}) {
  return store.upsert('agent_heartbeats', ['agent_id'], { agent_id: agentId, at: new Date(now).toISOString(), status });
}
export function getHeartbeats(store) { return store.all('agent_heartbeats'); }

export function recordAgentJob(store, job) {
  return store.insert('agent_jobs', {
    agent_id: job.agent_id, kind: job.kind ?? 'run', status: job.status,
    detail_json: JSON.stringify(job.detail ?? {}), at: nowIso(),
  });
}
export function getAgentJobs(store) { return store.all('agent_jobs'); }

// ---- admin events ---------------------------------------------------------

export function recordAdminEvent(store, ev) {
  return store.insert('admin_events', {
    actor: ev.actor, action: ev.action, detail_json: JSON.stringify(ev.detail ?? {}), at: nowIso(),
  });
}
export function getAdminEvents(store) { return store.all('admin_events'); }

// ---- Yana leads / John drafts / suppression -------------------------------

export function addSuppression(store, value, scope = 'email') {
  return store.upsert('suppression_list', ['scope', 'value'], { scope, value: String(value).toLowerCase(), at: nowIso() });
}
export function isSuppressed(store, value, scope = 'email') {
  return Boolean(store.get('suppression_list', { scope, value: String(value).toLowerCase() }));
}

export function saveLead(store, lead) {
  // dedup by source_url within a rolling window handled in the agent; here we
  // store keyed by a stable lead_key so re-discovery upserts rather than dupes.
  return store.upsert('yana_qualified_leads', ['lead_key'], {
    lead_key: lead.lead_key, name: lead.name, profile_type: lead.profile_type,
    source_url: lead.source_url, contact: lead.contact ?? null,
    fit_score: lead.fit_score, urgency: lead.urgency,
    why_json: JSON.stringify(lead.why ?? []), evidence_json: JSON.stringify(lead.evidence ?? {}),
    status: lead.status ?? 'qualified', created_at: lead.created_at ?? nowIso(),
  });
}
export function getLeads(store, { since = null } = {}) {
  const all = store.all('yana_qualified_leads');
  if (!since) return all;
  return all.filter((l) => Date.parse(l.created_at) >= since);
}

export function saveDraft(store, draft) {
  return store.upsert('john_drafts', ['lead_key'], {
    lead_key: draft.lead_key, alias_from: draft.alias_from, to: draft.to ?? null,
    subject: draft.subject, body: draft.body, status: draft.status,
    blocked_reason: draft.blocked_reason ?? null, created_at: nowIso(),
  });
}
export function getDrafts(store) { return store.all('john_drafts'); }

// ---- crawler telemetry ----------------------------------------------------

export function recordRun(store, run) {
  return store.upsert('crawler_runs', ['run_id'], {
    run_id: run.run_id, profile_id: run.profile_id ?? null,
    started_at: run.started_at, finished_at: run.finished_at ?? null,
    planned: run.planned ?? 0, found: run.found ?? 0, stored: run.stored ?? 0, rejected: run.rejected ?? 0,
    zero_result_reason: run.zero_result_reason ?? null, telemetry_json: JSON.stringify(run.telemetry ?? {}),
  });
}
export function recordSourceRun(store, runId, sr) {
  return store.insert('crawler_source_runs', {
    run_id: runId, source_id: sr.source_id, outcome: sr.outcome, reason: sr.reason ?? null,
    fetched: sr.fetched ?? 0, parsed_candidates: sr.parsed_candidates ?? 0,
    rejected: sr.rejected ?? 0, stored: sr.stored ?? 0, error: sr.error ?? null,
    started_at: sr.started_at ?? null, finished_at: sr.finished_at ?? null,
  });
}
export function recordRejection(store, runId, rej) {
  return store.insert('crawler_rejections', {
    run_id: runId, source_id: rej.source_id ?? null, reason: rej.reason,
    detail: rej.detail ?? null, title: rej.title ?? null, url: rej.url ?? null, created_at: nowIso(),
  });
}
export function recordFetch(store, runId, f) {
  return store.insert('crawler_fetches', {
    run_id: runId, source_id: f.source_id ?? null, url: f.url, status: f.status ?? null,
    ok: f.ok ? 1 : 0, content_hash: f.content_hash ?? null, error: f.error ?? null, fetched_at: nowIso(),
  });
}
export function getRun(store, runId) { return store.get('crawler_runs', { run_id: runId }); }

// ---- helpers --------------------------------------------------------------
function requireProfile(profileId) {
  if (!profileId) throw new Error('storage: profile_id is required (profile-scoped row)');
}

// ---- production SQL contract ----------------------------------------------
// The memory store proves these semantics offline. In production, run SCHEMA_DDL
// once, then back the services with createSqlStore(db). Postgres notes: TEXT PKs
// carry over; 0/1 INTEGER booleans -> BOOLEAN; JSON TEXT -> JSONB if desired.
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS funding_sources (
  source_id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL,
  trust_tier TEXT NOT NULL, base_url TEXT NOT NULL, directory INTEGER NOT NULL DEFAULT 0,
  loan_allowed INTEGER NOT NULL DEFAULT 0, cost_share_allowed INTEGER NOT NULL DEFAULT 0,
  priority_score INTEGER NOT NULL DEFAULT 0, refresh_frequency_days INTEGER NOT NULL DEFAULT 30,
  config_json TEXT, updated_at TEXT NOT NULL
);
-- GLOBAL catalog. NO profile_id column by design.
CREATE TABLE IF NOT EXISTS funding_opportunities (
  id TEXT PRIMARY KEY, source_id TEXT, external_id TEXT, kind TEXT NOT NULL,
  canonical_opportunity_key TEXT,
  title TEXT, sponsor TEXT, summary TEXT, apply_url TEXT, info_url TEXT, deadline TEXT,
  is_rolling INTEGER NOT NULL DEFAULT 0, amount_min REAL, amount_max REAL,
  is_loan INTEGER NOT NULL DEFAULT 0, requires_cost_share INTEGER NOT NULL DEFAULT 0,
  applicant_types_json TEXT, need_categories_json TEXT, geography_json TEXT,
  -- Page-fact provenance (Phase 0.1) — additive, NULL-default. eligibility_text +
  -- structured bullets scraped off the page, the extractor schema version, and
  -- per-field {value, evidence_snippet, source} provenance (also the tri-state
  -- home for is_loan/requires_cost_share/national — absent key = "not stated").
  eligibility_text TEXT, eligibility_bullets_json TEXT,
  page_fact_schema_version INTEGER, field_provenance_json TEXT,
  trust_tier TEXT, reality_status TEXT NOT NULL, content_hash TEXT, evidence_url TEXT,
  fetched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fo_reality ON funding_opportunities(reality_status);
-- Durable cross-source / cross-run dedup key (source-INDEPENDENT identity).
CREATE UNIQUE INDEX IF NOT EXISTS idx_fo_canonical_key ON funding_opportunities(canonical_opportunity_key);
-- Provenance: every crawler that surfaced the same canonical opportunity.
CREATE TABLE IF NOT EXISTS opportunity_sources (
  opportunity_id TEXT NOT NULL, source_id TEXT NOT NULL,
  external_id TEXT, apply_url TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (opportunity_id, source_id)
);
CREATE TABLE IF NOT EXISTS opportunity_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id TEXT NOT NULL, url TEXT NOT NULL,
  content_hash TEXT, fetched_at TEXT NOT NULL
);
-- PROFILE-SCOPED. Match score lives ONLY here.
CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
  profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, match_score INTEGER NOT NULL,
  decision TEXT NOT NULL, match_explain_json TEXT,
  source_query TEXT, discovered_via TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_pom_profile ON profile_opportunity_matches(profile_id);
CREATE TABLE IF NOT EXISTS profile_saved (
  profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, saved_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, opportunity_id)
);
CREATE TABLE IF NOT EXISTS profile_hidden (
  profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, reason TEXT, hidden_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, opportunity_id)
);
CREATE TABLE IF NOT EXISTS profile_pipeline_items (
  profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'discovered',
  added_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (profile_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_ppi_profile ON profile_pipeline_items(profile_id);
CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
  from_stage TEXT, to_stage TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_applications (
  profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, pathway TEXT, outcome TEXT,
  confirmation TEXT, detail_json TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (profile_id, opportunity_id)
);
CREATE TABLE IF NOT EXISTS profile_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, opportunity_id TEXT,
  name TEXT NOT NULL, kind TEXT NOT NULL, format TEXT, content TEXT, bytes INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_locks (name TEXT PRIMARY KEY, acquired_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_heartbeats (agent_id TEXT PRIMARY KEY, at TEXT NOT NULL, status TEXT);
CREATE TABLE IF NOT EXISTS agent_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, kind TEXT, status TEXT NOT NULL,
  detail_json TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, detail_json TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppression_list (scope TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (scope, value));
CREATE TABLE IF NOT EXISTS yana_qualified_leads (
  lead_key TEXT PRIMARY KEY, name TEXT, profile_type TEXT, source_url TEXT, contact TEXT,
  fit_score INTEGER, urgency INTEGER, why_json TEXT, evidence_json TEXT, status TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS john_drafts (
  lead_key TEXT PRIMARY KEY, alias_from TEXT, "to" TEXT, subject TEXT, body TEXT,
  status TEXT, blocked_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crawler_runs (
  run_id TEXT PRIMARY KEY, profile_id TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  planned INTEGER DEFAULT 0, found INTEGER DEFAULT 0, stored INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0,
  zero_result_reason TEXT, telemetry_json TEXT
);
CREATE TABLE IF NOT EXISTS crawler_source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, source_id TEXT NOT NULL, outcome TEXT NOT NULL,
  reason TEXT, fetched INTEGER DEFAULT 0, parsed_candidates INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0,
  stored INTEGER DEFAULT 0, error TEXT, started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS crawler_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, source_id TEXT, reason TEXT NOT NULL,
  detail TEXT, title TEXT, url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crawler_fetches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, source_id TEXT, url TEXT NOT NULL, status INTEGER,
  ok INTEGER DEFAULT 0, content_hash TEXT, error TEXT, fetched_at TEXT NOT NULL
);
`;

export default {
  SCHEMA_DDL,
  upsertSource, upsertOpportunity, getOpportunity, countOpportunities, listCatalog,
  upsertMatch, getMatchesForProfile,
  saveOpportunity, unsaveOpportunity, getSaved, hideOpportunity, isHidden, getHidden,
  addToPipeline, moveStage, getPipeline,
  saveApplicationRecord, getApplications, saveDocument, getDocuments,
  acquireLock, releaseLock, clearStaleLocks, heartbeat, getHeartbeats, recordAgentJob, getAgentJobs,
  recordAdminEvent, getAdminEvents,
  addSuppression, isSuppressed, saveLead, getLeads, saveDraft, getDrafts,
  recordRun, recordSourceRun, recordRejection, recordFetch, getRun,
};
