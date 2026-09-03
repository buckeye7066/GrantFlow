/**
 * GrantFlow production audit — DATABASE LANE (CI-safe).
 *
 * Runs inside GitHub Actions against production Postgres using ONLY the scoped,
 * expiring, read-only `grantflow_auditor` role. It has no Railway credentials,
 * no superuser fallback, and no write path of any kind.
 *
 * WHY THERE IS NO CONNECTION-STRING FALLBACK: the local kit this evolved from
 * resolved its URL from the Railway CLI when the env var was absent, which
 * silently promoted every run to superuser. That made the containment tests
 * meaningless — they proved a role could be denied while the queries that
 * mattered ran as somebody else entirely. Here the env var is mandatory and a
 * missing one is a hard failure.
 *
 * SCHEMA AUTHORITY IS PRODUCTION, NOT backend/db/schema.sql. That file is a
 * partial declaration with ~160 migrations layered on top and it drifts in both
 * directions. Every column below was read from information_schema on the live
 * database.
 *
 *   node scripts/production-audit/db-audit.mjs --guard-only
 *   node scripts/production-audit/db-audit.mjs --out ./audit-out --profiles a,b,c
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { redact } from './redact.mjs';

const { Client } = pg;

/**
 * Tables this lane must NEVER read. It does not merely avoid them — the guard
 * step asserts the database refuses them, so "we didn't query it" is backed by
 * "we could not have".
 */
const SENSITIVE_TABLES = [
  'users',
  'user_sessions',
  'user_credentials',
  'user_verification_codes',
  'password_setup_tokens',
  'oauth_states',
  'app_runtime_secrets',
  'hamilton_portal_credentials',
  'hamilton_portal_master_vault',
  'hamilton_payment_authorizations',
  'tailored_applications',
];

/** Pipeline bar on the data-point scale (backend/config/matchThresholds.js). */
const PIPELINE_BAR = 8;

/** Amy's synthetic training profiles skew every count. */
const NON_SYNTHETIC = `(p.created_by IS DISTINCT FROM 'agent:amy')`;

/** `$1` is a text[] of profile ids, or NULL for "every real profile". */
const SCOPE = `($1::text[] IS NULL OR p.id = ANY($1))`;

// ---------------------------------------------------------------------------
// Findings. Each maps to a numbered requirement in the audit contract.

export const FINDINGS = [
  {
    id: 'match_specificity',
    requirement: '1. Match specificity across materially different profiles',
    file: 'database',
    question:
      'Do materially different profiles receive materially different matches, or is the matcher returning a generic set? Reports per-profile match volume, score spread, and how many of its matches are shared with a profile of a DIFFERENT primary type.',
    sql: `
      WITH scoped AS (
        SELECT p.id, p.display_name, p.primary_type, pom.opportunity_id, pom.match_score, pom.match_decision
        FROM profiles p
        JOIN profile_opportunity_matches pom ON pom.profile_id = p.id
        WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
      ),
      shared AS (
        SELECT s.id, count(*) FILTER (
                 WHERE EXISTS (
                   SELECT 1 FROM profiles p2
                   JOIN profile_opportunity_matches m2 ON m2.profile_id = p2.id
                   WHERE m2.opportunity_id = s.opportunity_id
                     AND p2.id <> s.id
                     AND p2.primary_type IS DISTINCT FROM s.primary_type
                     AND p2.deleted_at IS NULL
                 ))::int AS shared_with_other_type
        FROM scoped s GROUP BY s.id
      )
      SELECT s.id AS profile_id, s.display_name, s.primary_type,
             count(*)::int AS matches,
             count(DISTINCT s.opportunity_id)::int AS distinct_opportunities,
             round(min(s.match_score)::numeric, 2) AS min_score,
             round(avg(s.match_score)::numeric, 2) AS avg_score,
             round(max(s.match_score)::numeric, 2) AS max_score,
             max(sh.shared_with_other_type)::int AS shared_with_other_profile_type,
             round(100.0 * max(sh.shared_with_other_type) / NULLIF(count(*), 0), 1) AS pct_shared_cross_type
      FROM scoped s JOIN shared sh ON sh.id = s.id
      GROUP BY s.id, s.display_name, s.primary_type
      ORDER BY pct_shared_cross_type DESC NULLS LAST`,
  },
  {
    id: 'cross_profile_repeats',
    requirement: '2. Repeated opportunities across unrelated profiles',
    file: 'database',
    question:
      'Which opportunities surface on many UNRELATED profiles (3+ profiles spanning 2+ primary types)? A high count here is the "same irrelevant grant keeps appearing" complaint, expressed as data.',
    sql: `
      SELECT fo.id AS opportunity_id, fo.title, fo.sponsor, fo.opportunity_kind,
             count(DISTINCT pom.profile_id)::int AS distinct_profiles,
             count(DISTINCT p.primary_type)::int AS distinct_profile_types,
             string_agg(DISTINCT p.primary_type, ', ') AS profile_types,
             round(avg(pom.match_score)::numeric, 2) AS avg_score
      FROM profile_opportunity_matches pom
      JOIN profiles p ON p.id = pom.profile_id
      JOIN funding_opportunities fo ON fo.id = pom.opportunity_id
      WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
      GROUP BY fo.id, fo.title, fo.sponsor, fo.opportunity_kind
      HAVING count(DISTINCT pom.profile_id) >= 3 AND count(DISTINCT p.primary_type) >= 2
      ORDER BY distinct_profile_types DESC, distinct_profiles DESC
      LIMIT 100`,
  },
  {
    id: 'eligibility_contradictions',
    requirement: '3. Hard eligibility contradictions',
    file: 'database',
    question:
      'Matches that record an INELIGIBILITY reason yet are still surfaced as accept/review. A row here contradicts itself: the engine found a disqualifier and recommended it anyway.',
    sql: `
      SELECT p.id AS profile_id, p.display_name, fo.title, fo.sponsor,
             pom.match_score, pom.match_decision, pom.matcher_version,
             left(pom.ineligibility_reasons, 400) AS ineligibility_reasons,
             (pom.match_explain_json::jsonb ->> 'eligibility_fit') AS eligibility_fit,
             (pom.match_explain_json::jsonb -> 'missing_eligibility_fields') AS missing_eligibility_fields
      FROM profile_opportunity_matches pom
      JOIN profiles p ON p.id = pom.profile_id
      JOIN funding_opportunities fo ON fo.id = pom.opportunity_id
      WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
        AND pom.ineligibility_reasons IS NOT NULL
        AND btrim(pom.ineligibility_reasons) NOT IN ('', '[]', 'null')
        AND lower(COALESCE(pom.match_decision, '')) IN ('accept', 'review')
      ORDER BY pom.match_score DESC NULLS LAST
      LIMIT 150`,
  },
  {
    id: 'match_score_components',
    requirement: '4. Match-score numerator, denominator, explanation, matcher version',
    file: 'database',
    question:
      'Can each surfaced score be explained? Extracts the data-point NUMERATOR (data_point_matched) and DENOMINATOR (data_point_total) from the stored breakdown, alongside the explanation and matcher version. Rows where either side is missing cannot be justified to a user.',
    sql: `
      SELECT p.id AS profile_id, p.display_name, fo.title,
             pom.match_score, pom.match_decision, pom.matcher_version,
             (pom.match_explain_json::jsonb -> 'score_breakdown' ->> 'data_point_matched')::numeric AS numerator,
             (pom.match_explain_json::jsonb -> 'score_breakdown' ->> 'data_point_total')::numeric   AS denominator,
             (pom.match_explain_json::jsonb -> 'score_breakdown' ->> 'data_point_coverage')::numeric AS coverage_pct,
             (pom.match_explain_json::jsonb -> 'score_breakdown' ->> 'scoring_model') AS scoring_model,
             (pom.match_explain_json::jsonb ->> 'canonical_score')::numeric AS canonical_score,
             left(pom.match_explanation, 300) AS match_explanation,
             (pom.match_explanation IS NULL OR btrim(pom.match_explanation) = '') AS no_explanation,
             (pom.match_explain_json IS NULL OR btrim(pom.match_explain_json) IN ('', '{}', 'null')) AS no_breakdown
      FROM profile_opportunity_matches pom
      JOIN profiles p ON p.id = pom.profile_id
      JOIN funding_opportunities fo ON fo.id = pom.opportunity_id
      WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
      ORDER BY no_breakdown DESC, no_explanation DESC, pom.match_score DESC NULLS LAST
      LIMIT 200`,
  },
  {
    id: 'below_threshold_surfaced',
    requirement: '5. Results surfaced below the configured threshold',
    file: 'database',
    question: `Matches scoring below the pipeline bar (${PIPELINE_BAR} on the data-point scale) that are STILL carrying an accept/review decision. NULL scores are reported separately — an unscored row is "not scored", not "scored badly", and conflating them was a documented past defect.`,
    sql: `
      SELECT p.id AS profile_id, p.display_name, pom.match_decision,
             count(*)::int AS n,
             count(*) FILTER (WHERE pom.match_score < ${PIPELINE_BAR})::int AS below_bar,
             count(*) FILTER (WHERE pom.match_score IS NULL)::int AS unscored,
             round(min(pom.match_score)::numeric, 2) AS min_score,
             round(avg(pom.match_score)::numeric, 2) AS avg_score
      FROM profile_opportunity_matches pom
      JOIN profiles p ON p.id = pom.profile_id
      WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
      GROUP BY p.id, p.display_name, pom.match_decision
      HAVING count(*) FILTER (WHERE pom.match_score < ${PIPELINE_BAR}) > 0
          OR count(*) FILTER (WHERE pom.match_score IS NULL) > 0
      ORDER BY below_bar DESC
      LIMIT 150`,
  },
  {
    id: 'reject_shown_as_review',
    requirement: '6. REJECT rows transformed or displayed as REVIEW',
    file: 'database',
    question:
      'Rows where the CANONICAL decision recorded in the explanation blob is reject, but the stored match_decision says review/accept. This is the specific "a rejection was relabelled on its way to the user" failure.',
    sql: `
      SELECT p.id AS profile_id, p.display_name, fo.title,
             pom.match_score, pom.match_decision AS stored_decision,
             (pom.match_explain_json::jsonb ->> 'canonical_decision') AS canonical_decision,
             pom.matcher_version, left(pom.match_explanation, 250) AS match_explanation
      FROM profile_opportunity_matches pom
      JOIN profiles p ON p.id = pom.profile_id
      JOIN funding_opportunities fo ON fo.id = pom.opportunity_id
      WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
        AND pom.match_explain_json IS NOT NULL AND btrim(pom.match_explain_json) NOT IN ('', '{}', 'null')
        AND lower(COALESCE(pom.match_explain_json::jsonb ->> 'canonical_decision', '')) = 'reject'
        AND lower(COALESCE(pom.match_decision, '')) IN ('review', 'accept')
      ORDER BY pom.match_score DESC NULLS LAST
      LIMIT 150`,
  },
  {
    id: 'hamilton_open_tasks',
    requirement: '7a. Hamilton application tasks',
    file: 'database',
    question:
      'Non-terminal Hamilton application tasks per profile by status/step, and how many carry an auto-submit flag. NOTE: allow_auto_submit is BOOLEAN on prod Postgres and INTEGER on the SQLite test DB, so the predicate is IS TRUE — "= 1" raises 42883 on production.',
    sql: `
      SELECT p.id AS profile_id, p.display_name, at.status, at.current_step,
             count(*)::int AS tasks,
             count(*) FILTER (WHERE at.allow_auto_submit IS TRUE OR at.auto_submit_enabled IS TRUE)::int AS autosubmit_flagged
      FROM application_tasks at
      JOIN profiles p ON p.id = at.profile_id
      WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
        AND at.status NOT IN ('completed', 'cancelled', 'submitted')
      GROUP BY p.id, p.display_name, at.status, at.current_step
      ORDER BY tasks DESC
      LIMIT 150`,
  },
  {
    id: 'unresolved_missing_info',
    requirement: '7b. Unresolved missing-information rows',
    file: 'database',
    question:
      'Unresolved missing-information asks on live tasks, grouped by key. NOTE: application_missing_info.resolved is BOOLEAN on prod and INTEGER on SQLite — the predicate must be IS NOT TRUE, never "= 0".',
    sql: `
      SELECT p.id AS profile_id, p.display_name, ami.kind, ami.key, ami.label,
             count(DISTINCT ami.task_id)::int AS tasks_flagging_it,
             min(ami.created_at) AS first_flagged,
             max(ami.created_at) AS last_flagged
      FROM application_missing_info ami
      JOIN application_tasks at ON at.id = ami.task_id
      JOIN profiles p ON p.id = at.profile_id
      WHERE ami.resolved IS NOT TRUE
        AND ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
        AND at.status NOT IN ('completed', 'cancelled')
      GROUP BY p.id, p.display_name, ami.kind, ami.key, ami.label
      ORDER BY tasks_flagging_it DESC
      LIMIT 150`,
  },
  {
    id: 'repeated_field_flags',
    requirement: "8. Repeated first-name or field flags across a profile's tasks",
    file: 'database',
    question:
      'The Demo Student class: ONE profile field flagged as missing across MANY tasks simultaneously. A profile-wide fact cannot be missing on 30 tasks and present on the profile — that is a reconciliation failure, not 30 separate gaps. Reported where the same key is unresolved on 2+ tasks.',
    sql: `
      SELECT p.id AS profile_id, p.display_name, ami.key, ami.kind,
             count(DISTINCT ami.task_id)::int AS distinct_tasks,
             min(ami.created_at) AS first_flagged,
             max(ami.created_at) AS last_flagged
      FROM application_missing_info ami
      JOIN application_tasks at ON at.id = ami.task_id
      JOIN profiles p ON p.id = at.profile_id
      WHERE ami.resolved IS NOT TRUE
        AND ami.kind = 'field'
        AND ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
        AND at.status NOT IN ('completed', 'cancelled')
      GROUP BY p.id, p.display_name, ami.key, ami.kind
      HAVING count(DISTINCT ami.task_id) >= 2
      ORDER BY distinct_tasks DESC
      LIMIT 150`,
  },
  {
    id: 'portal_sessions',
    requirement: '9. Portal session existence and lifecycle (redacted view only)',
    file: 'portal',
    question:
      'Does a reusable portal session exist, and is it live? Reads audit.hamilton_saved_sessions — a view that exposes WHETHER state exists and its lifecycle timestamps, never the state. The ciphertext column and both retrieval pointers are withheld at the database level, and the guard step proves the base table is denied.',
    sql: `
      SELECT s.profile_id, p.display_name, s.portal_host, s.label,
             s.authentication_strategy, s.status,
             s.has_storage_state, s.has_state_pointer, s.is_expired,
             s.established_at, s.last_used_at, s.expires_at
      FROM audit.hamilton_saved_sessions s
      LEFT JOIN profiles p ON p.id = s.profile_id
      WHERE ($1::text[] IS NULL OR s.profile_id = ANY($1))
      ORDER BY s.portal_host, s.last_used_at DESC NULLS LAST`,
  },
  {
    id: 'portal_sync_runs',
    requirement: '10a. Portal sync runs, directions, errors',
    file: 'portal',
    question:
      'Sync history by host and DIRECTION. Direction is the safety-relevant column: a "read"/"pull" observes, a "write"/"push"/"both" changes the portal side. Any write-direction run inside the audit window would be a violation of this audit\'s own contract.',
    sql: `
      SELECT psr.portal_host, psr.direction, psr.status,
             count(*)::int AS runs,
             max(psr.started_at) AS last_run,
             count(*) FILTER (WHERE psr.error IS NOT NULL AND btrim(psr.error) <> '')::int AS with_error,
             left(max(psr.error), 300) AS sample_error
      FROM portal_sync_runs psr
      WHERE ($1::text[] IS NULL OR psr.profile_id = ANY($1))
      GROUP BY psr.portal_host, psr.direction, psr.status
      ORDER BY last_run DESC NULLS LAST
      LIMIT 150`,
  },
  {
    id: 'portal_sync_persisted',
    requirement: '10b. Persisted fields, persisted awards, merged status',
    file: 'portal',
    question:
      'What a sync run actually PERSISTED, read from its summary blob: the read/write nodes, whether it merged, and whether it reported needs_session. Distinguishes "the run completed" from "the run changed something".',
    sql: `
      SELECT psr.profile_id, p.display_name, psr.portal_host, psr.direction, psr.status,
             psr.started_at, psr.finished_at,
             (psr.summary -> 'read')  AS read_summary,
             (psr.summary -> 'write') AS write_summary,
             (psr.summary ->> 'merged') AS merged,
             (psr.summary ->> 'needs_session') AS needs_session,
             (psr.summary ->> 'connector') AS connector
      FROM portal_sync_runs psr
      LEFT JOIN profiles p ON p.id = psr.profile_id
      WHERE ($1::text[] IS NULL OR psr.profile_id = ANY($1))
      ORDER BY psr.started_at DESC NULLS LAST
      LIMIT 100`,
  },
  {
    id: 'portal_status_evidence',
    requirement: '11. Portal status rows with and without evidence',
    file: 'portal',
    question:
      'HONEST AGGREGATE, not a sample: what share of portal-status rows carry no evidence, by status. A row claiming Synced/Merged/Completed with no evidence is an unsupported claim shown to a user. ROLLUP adds the all-status total.',
    sql: `
      SELECT COALESCE(pps.status, '(all statuses)') AS status,
             count(*)::int AS total_rows,
             count(*) FILTER (WHERE pps.evidence IS NULL
                                OR btrim(pps.evidence) IN ('', '{}', '[]', 'null'))::int AS no_evidence,
             round(100.0 * count(*) FILTER (WHERE pps.evidence IS NULL
                                OR btrim(pps.evidence) IN ('', '{}', '[]', 'null'))
                   / NULLIF(count(*), 0), 1) AS pct_no_evidence
      FROM profile_portal_status pps
      WHERE ($1::text[] IS NULL OR pps.profile_id = ANY($1))
      GROUP BY ROLLUP (pps.status)
      ORDER BY total_rows DESC`,
  },
  {
    id: 'portal_check_personal_awards',
    requirement: '15. Public portal-check rows that claim personal awards',
    file: 'portal',
    question:
      'Portal checks reporting awards_detected > 0. NOTE this table names the portal portal_name/portal_url and has NO portal_host column, unlike portal_sync_runs and profile_portal_status. A public check claiming a personal award is a provenance error worth confirming.',
    sql: `
      SELECT pcr.portal_name, pcr.check_type, pcr.status,
             count(*)::int AS n,
             sum(COALESCE(pcr.awards_detected, 0))::int AS awards_detected,
             count(DISTINCT pcr.profile_id)::int AS distinct_profiles,
             max(pcr.checked_at) AS last_seen
      FROM portal_check_results pcr
      WHERE ($1::text[] IS NULL OR pcr.profile_id = ANY($1))
      GROUP BY pcr.portal_name, pcr.check_type, pcr.status
      HAVING sum(COALESCE(pcr.awards_detected, 0)) > 0
      ORDER BY awards_detected DESC
      LIMIT 100`,
  },
  {
    id: 'pipeline_applications',
    requirement: '13. Applications, submissions, awards, denials, amounts',
    file: 'database',
    question:
      'The real pipeline outcome ledger per profile: grants by status, how many carry a submitted date, and total awarded. A "submitted" status with no submitted_date is the imported-status-honesty class documented in CLAUDE.md.',
    sql: `
      SELECT p.id AS profile_id, p.display_name, g.status,
             count(*)::int AS grants,
             count(*) FILTER (WHERE g.submitted_date IS NOT NULL)::int AS with_submitted_date,
             count(*) FILTER (WHERE g.status = 'submitted' AND g.submitted_date IS NULL)::int AS submitted_without_date,
             sum(COALESCE(g.amount_awarded, 0))::numeric AS total_awarded
      FROM grants g
      JOIN profiles p ON p.id = g.profile_id
      WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
      GROUP BY p.id, p.display_name, g.status
      ORDER BY p.display_name, g.status
      LIMIT 200`,
  },
  {
    id: 'grant_applications_ledger',
    requirement: '13b. Formal grant_applications outcomes',
    file: 'database',
    question:
      'The grant_applications table: submitted, awarded, denied counts and amount awarded per profile. Contact columns exist on this table and are deliberately NOT selected.',
    sql: `
      SELECT p.id AS profile_id, p.display_name, ga.status,
             count(*)::int AS applications,
             count(*) FILTER (WHERE ga.submitted_at IS NOT NULL)::int AS submitted,
             sum(COALESCE(ga.amount_requested, 0))::numeric AS total_requested,
             sum(COALESCE(ga.amount_awarded, 0))::numeric AS total_awarded
      FROM grant_applications ga
      JOIN profiles p ON p.id = ga.profile_id
      WHERE ${NON_SYNTHETIC} AND p.deleted_at IS NULL AND ${SCOPE}
      GROUP BY p.id, p.display_name, ga.status
      ORDER BY p.display_name, ga.status
      LIMIT 200`,
  },
  {
    id: 'catalog_contamination',
    requirement: '14. Portal-derived personal awards in the GLOBAL catalog',
    file: 'database',
    question:
      'funding_opportunities is the GLOBAL catalog; a row carrying a profile_id is profile-scoped by definition, and a portal-derived personal award leaking in would be shown to unrelated users. Grouped by source/origin/kind so the producing lane is identifiable.',
    sql: `
      SELECT fo.source, fo.record_origin, fo.opportunity_kind,
             count(*)::int AS rows_with_profile_id,
             count(*) FILTER (WHERE fo.is_active)::int AS active
      FROM funding_opportunities fo
      WHERE fo.profile_id IS NOT NULL
      GROUP BY fo.source, fo.record_origin, fo.opportunity_kind
      ORDER BY rows_with_profile_id DESC
      LIMIT 100`,
    unscoped: true, // a global-catalog question; profile scoping would hide it
  },
];

// ---------------------------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`FATAL: ${name} is not set. This lane has no fallback by design.`);
    process.exit(2);
  }
  return v.trim();
}

function parseArgs(argv) {
  const get = (flag, dflt = null) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  return {
    guardOnly: argv.includes('--guard-only'),
    outDir: get('--out', path.join(process.cwd(), 'audit-out')),
    profiles: (get('--profiles', '') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    minimal: argv.includes('--minimal'),
  };
}

async function connect() {
  const client = new Client({
    connectionString: requireEnv('GRANTFLOW_PROD_AUDIT_DATABASE_URL'),
    // Railway's managed Postgres public endpoint serves a self-signed cert.
    // This mirrors backend/db/index.js's own production posture and is
    // acceptable only because this path is read-only diagnostics.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
  });
  await client.connect();
  await client.query("SET SESSION default_transaction_read_only = on");
  await client.query("SET SESSION statement_timeout = '30s'");
  await client.query("SET SESSION lock_timeout = '5s'");
  await client.query("SET SESSION idle_in_transaction_session_timeout = '60s'");
  return client;
}

/**
 * Run one statement isolated by a SAVEPOINT.
 *
 * Inside a READ ONLY transaction a single failing statement poisons the whole
 * transaction (every later query returns 25P02), so one denied table would
 * otherwise cascade into "everything failed" and look like a much larger
 * problem than it is. Returns the SQLSTATE instead of throwing.
 */
async function probe(client, sql, params = []) {
  await client.query('SAVEPOINT p');
  try {
    const res = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT p');
    return { ok: true, rows: res.rows };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT p').catch(() => {});
    await client.query('RELEASE SAVEPOINT p').catch(() => {});
    return { ok: false, code: err.code || null, message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Guard: containment + production safety posture.

async function runGuard(client, { baseUrl, writePrivilegeCode }) {
  const checks = [];
  const record = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const who = await probe(client, 'SELECT current_user AS u, current_database() AS db');
  record(
    'connects as a non-superuser scoped role',
    who.ok && who.rows[0].u === 'grantflow_auditor',
    who.ok ? `current_user=${who.rows[0].u}` : who.message,
  );

  const su = await probe(client, 'SELECT usesuper FROM pg_user WHERE usename = current_user');
  record(
    'role is NOT a superuser',
    su.ok && su.rows[0]?.usesuper === false,
    su.ok ? `usesuper=${su.rows[0]?.usesuper}` : su.message,
  );

  const ro = await probe(client, 'SHOW default_transaction_read_only');
  record(
    'session is read-only',
    ro.ok && ro.rows[0].default_transaction_read_only === 'on',
    ro.ok ? `default_transaction_read_only=${ro.rows[0].default_transaction_read_only}` : ro.message,
  );

  // A real write attempt. 25006 = read_only_sql_transaction (the session guard),
  // 42501 = insufficient_privilege (the GRANT). Either is a genuine refusal;
  // SUCCESS is a hard stop.
  const w = await probe(client, 'CREATE TEMP TABLE _audit_write_probe (x int)');
  record(
    'write attempt is REFUSED by production',
    !w.ok && (w.code === '25006' || w.code === '42501'),
    w.ok ? 'A WRITE SUCCEEDED — containment is broken' : `SQLSTATE ${w.code}`,
  );

  // A second, different write shape: privilege-level refusal on a real table,
  // so the proof does not rest on the session flag alone.
  const ins = await probe(client, "INSERT INTO public.profiles (id) VALUES ('_audit_write_probe')");
  record(
    'INSERT into a real table is REFUSED',
    !ins.ok && (ins.code === '25006' || ins.code === '42501'),
    ins.ok ? 'AN INSERT SUCCEEDED — containment is broken' : `SQLSTATE ${ins.code}`,
  );

  // The decisive one: refused by PRIVILEGE, with our own read-only guard off.
  // A superuser SUCCEEDS here even though it returned 25006 above.
  record(
    'write is refused by PRIVILEGE even with the guard off',
    writePrivilegeCode === '42501',
    writePrivilegeCode === 'SUCCEEDED'
      ? 'A WRITE SUCCEEDED with the guard off — this account CAN write to production'
      : `SQLSTATE ${writePrivilegeCode} (42501 = insufficient_privilege)`,
  );

  // Sensitive tables must be denied, not merely un-queried.
  const leaked = [];
  let denied = 0;
  let absent = 0;
  for (const t of SENSITIVE_TABLES) {
    const exists = await probe(client, 'SELECT to_regclass($1) AS oid', [`public.${t}`]);
    if (!exists.ok || !exists.rows[0].oid) {
      absent += 1;
      continue;
    }
    const r = await probe(client, `SELECT 1 FROM public.${t} LIMIT 1`);
    if (r.ok) leaked.push(t);
    else if (r.code === '42501') denied += 1;
    else leaked.push(`${t}(unexpected ${r.code})`);
  }
  record(
    'every sensitive table is DENIED',
    leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${denied} denied, ${absent} absent`,
  );

  // The redacted session view must be readable while its base table is not —
  // proving the redaction is enforced by the database, not by our restraint.
  const view = await probe(client, 'SELECT count(*)::int AS n FROM audit.hamilton_saved_sessions');
  record(
    'redacted session view is readable',
    view.ok,
    view.ok ? `${view.rows[0].n} rows` : view.message,
  );
  const cipher = await probe(
    client,
    'SELECT storage_state_encrypted FROM public.hamilton_saved_sessions LIMIT 1',
  );
  record(
    'raw session ciphertext is DENIED',
    !cipher.ok && cipher.code === '42501',
    cipher.ok ? 'CIPHERTEXT READABLE — stop' : `SQLSTATE ${cipher.code}`,
  );

  // ---- the auto-submit gate -------------------------------------------------
  const posture = await verifyAutomationPosture(client, { baseUrl, record });

  const failed = checks.filter((c) => !c.pass);
  return { checks, posture, ok: failed.length === 0, failed: failed.map((f) => f.name) };
}

/**
 * Prove HAMILTON_ALLOW_AUTOSUBMIT is disabled IN THE PROCESS SERVING TRAFFIC.
 *
 * Two facts are needed and neither is sufficient alone:
 *   1. system_kv.automation_posture says allow_auto_submit is false;
 *   2. the boot_id in that row equals the bootId reported by the LIVE
 *      /api/health/deployment.
 *
 * Without (2) the row could have been written by a previous deploy that has
 * since been replaced by one with auto-submit armed — a stale record that reads
 * safe. "Cannot verify" is treated exactly like "armed": both abort.
 */
async function verifyAutomationPosture(client, { baseUrl, record }) {
  const row = await probe(client, "SELECT value, updated_at FROM system_kv WHERE key = 'automation_posture'");
  if (!row.ok || !row.rows.length) {
    record(
      'auto-submit posture is verifiable',
      false,
      'system_kv.automation_posture is MISSING — cannot verify, refusing',
    );
    return { verified: false, reason: 'posture_row_missing' };
  }

  let posture;
  try {
    posture = JSON.parse(row.rows[0].value);
  } catch {
    record('auto-submit posture is verifiable', false, 'posture row is not valid JSON');
    return { verified: false, reason: 'posture_unparseable' };
  }

  const authorityIsProfileScoped =
    posture.submission_authority === 'profile_authorization' &&
    posture.profile_authorization_required === true;
  record(
    'Hamilton submission authority is profile-scoped',
    authorityIsProfileScoped,
    `submission_authority=${posture.submission_authority}; profile_authorization_required=${posture.profile_authorization_required}`,
  );

  let live = null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health/deployment`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) live = await res.json();
  } catch (err) {
    // fall through to the un-verifiable branch below
  }

  const bootMatches = Boolean(live?.bootId) && live.bootId === posture.boot_id;
  record(
    'posture was written by the RUNNING process (boot id matches)',
    bootMatches,
    live?.bootId
      ? bootMatches
        ? 'live bootId == posture boot_id'
        : 'MISMATCH — posture is from a previous deploy, refusing'
      : 'live /api/health/deployment did not report a bootId — cannot verify',
  );

  return {
    verified: authorityIsProfileScoped && bootMatches,
    submission_authority: posture.submission_authority,
    profile_authorization_required: posture.profile_authorization_required,
    external_submission_possible: posture.external_submission_possible,
    browser_automation: posture.browser_automation,
    run_on_schedule: posture.run_on_schedule,
    tailored_approval_gate: posture.tailored_approval_gate,
    captured_at: posture.captured_at,
    boot_id_matches_live: bootMatches,
    deployment_commit: live?.commit ?? null,
  };
}

/**
 * Prove the account cannot write even with our OWN guard switched off.
 *
 * WHY THIS EXISTS SEPARATELY: the in-transaction write probe demands 25006, but
 * 25006 is produced by `default_transaction_read_only`, which THIS SCRIPT sets.
 * So that probe passes for ANY account — including a superuser — and proves only
 * that we asked politely. Verified live: pointing the lane at the Railway
 * superuser still returned 25006 on both write probes.
 *
 * The decisive control is the GRANT. This lifts the session flag and attempts a
 * real INSERT, demanding 42501 (insufficient_privilege). An account that can
 * actually write SUCCEEDS here and fails the audit.
 *
 * Must run BEFORE `BEGIN TRANSACTION READ ONLY`: `SET SESSION` cannot make the
 * current read-only transaction writable, so inside it this would return a
 * misleading 25006 and test nothing.
 */
async function probeWritePrivilege(client) {
  await client.query('SET SESSION default_transaction_read_only = off');
  let code = null;
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO public.profiles (id) VALUES ('_audit_write_privilege_probe')");
    code = 'SUCCEEDED';
  } catch (err) {
    code = err.code || 'unknown';
  } finally {
    // Nothing is ever committed: the INSERT lives and dies inside this
    // transaction, and the guard is restored before anything else runs.
    await client.query('ROLLBACK').catch(() => {});
    await client.query('SET SESSION default_transaction_read_only = on').catch(() => {});
  }
  return code;
}

/**
 * Standalone auto-submit gate for callers outside this lane (the app lane).
 *
 * Deliberately shares ONE implementation with the guard above. Two copies of a
 * safety check drift, and the copy that drifts is always the one that stops
 * catching things — so the app lane does not re-derive this, it calls it.
 */
export async function assertReadOnlyAuditPosture({ baseUrl, logger = console } = {}) {
  const client = await connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const record = (name, pass, detail) =>
      logger.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    const posture = await verifyAutomationPosture(client, { baseUrl, record });
    await client.query('ROLLBACK').catch(() => {});
    return posture;
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Amy (requirement 12) — her reports live in system_kv, not in tables.

async function collectAmy(client) {
  const out = { report: null, recent_runs: null, duplicate_runs: [], counts: {}, errors: [] };

  const res = await probe(
    client,
    "SELECT key, value, updated_at FROM system_kv WHERE key IN ('amy_last_report','amy_recent_runs','amy_approval_queue')",
  );
  if (!res.ok) {
    out.errors.push(`system_kv read failed: ${res.code} ${res.message}`);
    return out;
  }

  const byKey = Object.fromEntries(res.rows.map((r) => [r.key, r]));

  const parse = (key) => {
    const raw = byKey[key]?.value;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      out.errors.push(`${key} is not valid JSON`);
      return null;
    }
  };

  const report = parse('amy_last_report');
  const runs = parse('amy_recent_runs');

  out.report_updated_at = byKey.amy_last_report?.updated_at ?? null;
  out.runs_updated_at = byKey.amy_recent_runs?.updated_at ?? null;

  if (report) {
    out.report = report;
    // Amy's daily numbers live on report.cohort (verified against the live
    // amy_last_report shape, 2026-07-27): profiles = evaluated, ok = clean.
    // `issues` is DERIVED as evaluated - ok and labelled as such, because Amy
    // records no single "issue count" field; inventing one under a name that
    // implies she reported it would misrepresent her output.
    const c = report.cohort ?? {};
    const evaluated = c.profiles ?? null;
    const clean = c.ok ?? null;
    out.counts = {
      run_id: report.run_id ?? null,
      started_at: report.started_at ?? null,
      completed_at: report.completed_at ?? null,
      evaluated,
      clean,
      issues_derived: evaluated != null && clean != null ? evaluated - clean : null,
      weak: c.weak ?? null,
      zero: c.zero ?? null,
      errored: c.errored ?? null,
      skipped: c.skipped ?? null,
      false_positive_rate: c.false_positive_rate ?? null,
      covered_rate: c.covered_rate ?? null,
      quality_score: c.quality_score ?? null,
      current_floor: c.current_floor ?? report.slider_floor ?? null,
      approval_queue_size: Array.isArray(report.approval_queue)
        ? report.approval_queue.length
        : (report.approval_queue?.length ?? null),
    };
  }

  if (Array.isArray(runs)) {
    out.recent_runs = runs;
    // Duplicate-run evidence: the same run id recorded more than once, or two
    // runs sharing a started_at. Either means the scoreboard is double-counting.
    const byId = new Map();
    for (const r of runs) {
      const id = r?.run_id ?? r?.id ?? null;
      if (!id) continue;
      byId.set(id, (byId.get(id) || 0) + 1);
    }
    out.duplicate_runs = [...byId.entries()]
      .filter(([, n]) => n > 1)
      .map(([run_id, occurrences]) => ({ run_id, occurrences }));
    out.run_ids = [...byId.keys()].slice(0, 50);
  }

  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.GRANTFLOW_PROD_BASE_URL || 'https://app.axiombiolabs.org';
  fs.mkdirSync(args.outDir, { recursive: true });

  const client = await connect();
  const started = new Date().toISOString();

  try {
    // Privilege probe FIRST — it needs the session guard off, which cannot be
    // done from inside a read-only transaction. It restores the guard itself.
    const writePrivilegeCode = await probeWritePrivilege(client);

    // READ ONLY transaction: belt and braces over the session default, and the
    // level the SQL standard actually enforces.
    await client.query('BEGIN TRANSACTION READ ONLY');

    console.log('Guard — containment and production safety posture:');
    const guard = await runGuard(client, { baseUrl, writePrivilegeCode });

    const guardPath = path.join(args.outDir, 'guard.json');
    fs.writeFileSync(guardPath, JSON.stringify(redact(guard), null, 2));

    if (!guard.ok) {
      console.error(`\nGUARD FAILED (${guard.failed.join('; ')}). Refusing to run the audit.`);
      process.exit(3);
    }
    if (!guard.posture?.verified) {
      console.error(
        '\nHAMILTON AUTHORITY POSTURE NOT VERIFIED — refusing to audit production.\n' +
          `reason: ${guard.posture?.reason || 'profile-scoped submission authority or running boot could not be verified'}`,
      );
      process.exit(4);
    }
    console.log('\nGuard passed: read-only proven, sensitive tables denied, profile-scoped submission authority verified.');

    if (args.guardOnly) {
      await client.query('COMMIT');
      return;
    }

    // ---- findings ---------------------------------------------------------
    const scope = args.profiles.length ? args.profiles : null;
    const buckets = { database: [], portal: [] };
    const summary = [];

    console.log('\nFindings:');
    for (const f of FINDINGS) {
      const t0 = Date.now();
      // An `unscoped` query asks a GLOBAL question and contains no $1, so it
      // must be bound with NO parameters — Postgres rejects a bind that supplies
      // more parameters than the statement declares (08P01).
      const res = await probe(client, f.sql, f.unscoped ? [] : [scope]);
      const ms = Date.now() - t0;
      const entry = {
        id: f.id,
        requirement: f.requirement,
        question: f.question,
        error: res.ok ? null : `${res.code || ''} ${res.message}`.trim(),
        rowCount: res.ok ? res.rows.length : 0,
        rows: res.ok ? redact(res.rows, { minimal: args.minimal }) : [],
      };
      buckets[f.file].push(entry);
      summary.push({ id: f.id, rows: entry.rowCount, ms, error: entry.error });
      console.log(
        `  ${entry.error ? 'ERROR' : 'ok   '}  ${f.id.padEnd(30)} ${String(entry.rowCount).padStart(5)} rows  ${ms}ms` +
          (entry.error ? `\n         ${entry.error}` : ''),
      );
    }

    console.log('\nAmy:');
    const amy = await collectAmy(client);
    console.log(
      `  ok     amy_findings                   evaluated=${amy.counts.evaluated ?? '?'} ` +
        `clean=${amy.counts.clean ?? '?'} issues(derived)=${amy.counts.issues_derived ?? '?'} ` +
        `runs=${amy.recent_runs?.length ?? 0} duplicate_runs=${amy.duplicate_runs.length}`,
    );

    await client.query('COMMIT');

    const meta = {
      lane: 'database',
      started_at: started,
      finished_at: new Date().toISOString(),
      base_url: baseUrl,
      profiles_scoped: scope,
      role: 'grantflow_auditor (scoped, read-only, expiring)',
      posture: guard.posture,
      note:
        'Findings are produced by a READ ONLY transaction on a non-superuser role. ' +
        'Sensitive tables were proven denied, not merely avoided.',
    };

    const write = (name, payload) => {
      const p = path.join(args.outDir, name);
      fs.writeFileSync(p, JSON.stringify(redact(payload), null, 2));
      console.log(`  wrote ${name}`);
    };

    console.log('\nOutput:');
    write('database-findings.json', { ...meta, findings: buckets.database });
    write('portal-findings.json', { ...meta, findings: buckets.portal });
    write('amy-findings.json', { ...meta, requirement: "12. Amy's latest report and run evidence", amy });
    write('db-lane-summary.json', { ...meta, summary });

    const failed = summary.filter((s) => s.error);
    if (failed.length) {
      console.error(`\n${failed.length} finding(s) errored: ${failed.map((f) => f.id).join(', ')}`);
      process.exit(1);
    }
    console.log(`\n${summary.length}/${summary.length} findings succeeded.`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

// Only run when invoked directly, so the query set can be imported and
// exercised by a test without opening a production connection as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}
