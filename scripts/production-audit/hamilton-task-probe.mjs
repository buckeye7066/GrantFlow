/**
 * GrantFlow production probe — HAMILTON TASK LIFECYCLE (read-only, CI-only).
 *
 * Answers a fixed list of questions about the live `application_tasks` /
 * `grants` lifecycle so that Hamilton autopilot defect reports can be checked
 * against the real database instead of against a screenshot.
 *
 * Same posture as db-audit.mjs: the connection string is MANDATORY (no
 * fallback that could silently promote the run to superuser), the session is
 * pinned read-only, and every statement is a SELECT. A failing query is
 * recorded and the probe continues — a denied table is itself a result.
 *
 *   node scripts/production-audit/hamilton-task-probe.mjs --out ./probe-out
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

const outIndex = process.argv.indexOf('--out');
const OUT_DIR = outIndex === -1 ? './probe-out' : process.argv[outIndex + 1];

const CONNECTION = process.env.GRANTFLOW_PROD_AUDIT_DATABASE_URL;
if (!CONNECTION) {
  console.error(
    'GRANTFLOW_PROD_AUDIT_DATABASE_URL is required. There is deliberately no fallback.',
  );
  process.exit(1);
}

/**
 * Every question this probe asks. Keeping them declarative means the artifact
 * records the exact SQL beside the exact rows, so a reader can re-derive the
 * conclusion instead of trusting the summary.
 */
const QUERIES = [
  {
    id: 'task_status_counts',
    why: 'D1 — which statuses exist and how many tasks sit in each.',
    sql: `SELECT status, COUNT(*)::int AS n
            FROM application_tasks
           GROUP BY status
           ORDER BY n DESC`,
  },
  {
    id: 'task_status_by_automation_type',
    why: 'D7 — status/substatus pairs, including automation_type NULL ("unknown").',
    sql: `SELECT status,
                 COALESCE(automation_type, '(null)') AS automation_type,
                 COUNT(*)::int AS n
            FROM application_tasks
           GROUP BY 1, 2
           ORDER BY n DESC`,
  },
  {
    id: 'cancelled_at_by_second',
    why: 'D5 — mass cancellation. Buckets of tasks sharing one cancelled_at second.',
    sql: `SELECT date_trunc('second', cancelled_at) AS at_second, COUNT(*)::int AS n
            FROM application_tasks
           WHERE cancelled_at IS NOT NULL
           GROUP BY 1
           ORDER BY n DESC, 1 DESC
           LIMIT 15`,
  },
  {
    id: 'cancel_reason_messages',
    why: 'D5/D11 — what REASON, if any, the mass-cancelled rows actually recorded.',
    sql: `SELECT left(COALESCE(last_agent_message, '(null)'), 160) AS message,
                 COUNT(*)::int AS n,
                 MIN(cancelled_at) AS first_at,
                 MAX(cancelled_at) AS last_at
            FROM application_tasks
           WHERE status = 'cancelled'
           GROUP BY 1
           ORDER BY n DESC
           LIMIT 25`,
  },
  {
    id: 'cancel_event_actors',
    why: 'D5 — who performed the cancellations that DID leave an event.',
    sql: `SELECT COALESCE(e.actor_role, '(null)') AS actor_role,
                 left(COALESCE(e.message, '(null)'), 140) AS message,
                 COUNT(*)::int AS n,
                 MIN(e.created_at) AS first_at,
                 MAX(e.created_at) AS last_at
            FROM application_task_events e
           WHERE e.event_type = 'cancelled' OR e.status = 'cancelled'
           GROUP BY 1, 2
           ORDER BY n DESC
           LIMIT 25`,
  },
  {
    id: 'title_resolution',
    why: 'D2 — can a display name be resolved at all, or is it genuinely absent?',
    sql: `SELECT COUNT(*)::int                                                        AS tasks,
                 COUNT(t.opportunity_id)::int                                          AS with_opportunity_id,
                 COUNT(t.grant_id)::int                                                AS with_grant_id,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(g.title), '') IS NOT NULL)::int     AS grant_title_present,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(fo.title), '') IS NOT NULL)::int    AS opportunity_title_present,
                 COUNT(*) FILTER (
                   WHERE NULLIF(TRIM(g.title), '') IS NULL
                     AND NULLIF(TRIM(fo.title), '') IS NULL
                 )::int                                                                AS no_title_anywhere,
                 COUNT(*) FILTER (
                   WHERE NULLIF(TRIM(g.title), '') IS NULL
                     AND NULLIF(TRIM(fo.title), '') IS NULL
                     AND COALESCE(NULLIF(TRIM(t.application_url), ''), NULLIF(TRIM(t.portal_url), '')) IS NOT NULL
                 )::int                                                                AS no_title_but_has_url
            FROM application_tasks t
            LEFT JOIN grants g ON g.id = t.grant_id
            LEFT JOIN funding_opportunities fo ON fo.id = t.opportunity_id`,
  },
  {
    id: 'submitted_proof_documents',
    why: 'D10/D12 — do the submitted rows point at real CONFIRMATION proof, or at a draft packet?',
    sql: `SELECT COALESCE(d.type, '(no document)') AS document_type, COUNT(*)::int AS n
            FROM application_tasks t
            LEFT JOIN documents d ON d.id = t.output_document_id
           WHERE t.status = 'submitted'
           GROUP BY 1
           ORDER BY n DESC`,
  },
  {
    id: 'submitted_event_actors',
    why: 'D12 — did HAMILTON record these submissions, or a human/bulk admin action?',
    sql: `SELECT COALESCE(e.actor_role, '(null)') AS actor_role,
                 left(COALESCE(e.message, '(null)'), 140) AS message,
                 COUNT(*)::int AS n,
                 MIN(e.created_at) AS first_at,
                 MAX(e.created_at) AS last_at
            FROM application_task_events e
           WHERE e.event_type = 'submitted'
           GROUP BY 1, 2
           ORDER BY n DESC
           LIMIT 25`,
  },
  {
    id: 'duplicate_tasks_by_grant',
    why: 'D14 — the same grant claimed by more than one task on one profile.',
    sql: `SELECT COUNT(*)::int AS duplicated_groups,
                 COALESCE(SUM(n) - COUNT(*), 0)::int AS excess_rows,
                 COALESCE(MAX(n), 0)::int AS worst_group
            FROM (
              SELECT profile_id, grant_id, COUNT(*)::int AS n
                FROM application_tasks
               WHERE grant_id IS NOT NULL
               GROUP BY 1, 2
              HAVING COUNT(*) > 1
            ) d`,
  },
  {
    id: 'duplicate_tasks_by_title',
    why: 'D14 — the same PROGRAM (by resolved title) claimed by several tasks on one profile.',
    sql: `SELECT t.profile_id,
                 lower(regexp_replace(COALESCE(g.title, fo.title, ''), '[^a-z0-9]+', ' ', 'gi')) AS norm_title,
                 COUNT(*)::int AS n,
                 COUNT(DISTINCT t.status)::int AS distinct_statuses,
                 COUNT(DISTINCT COALESCE(g.funder, fo.sponsor, ''))::int AS distinct_funders
            FROM application_tasks t
            LEFT JOIN grants g ON g.id = t.grant_id
            LEFT JOIN funding_opportunities fo ON fo.id = t.opportunity_id
           WHERE COALESCE(NULLIF(TRIM(g.title), ''), NULLIF(TRIM(fo.title), '')) IS NOT NULL
           GROUP BY 1, 2
          HAVING COUNT(*) > 1
           ORDER BY n DESC
           LIMIT 40`,
  },
  {
    id: 'duplicate_task_totals',
    why: 'D14 — the honest headline: how many task rows are excess duplicates of a program.',
    sql: `SELECT COUNT(*)::int AS duplicated_programs,
                 COALESCE(SUM(n) - COUNT(*), 0)::int AS excess_rows
            FROM (
              SELECT t.profile_id,
                     lower(regexp_replace(COALESCE(g.title, fo.title, ''), '[^a-z0-9]+', ' ', 'gi')) AS norm_title,
                     COUNT(*)::int AS n
                FROM application_tasks t
                LEFT JOIN grants g ON g.id = t.grant_id
                LEFT JOIN funding_opportunities fo ON fo.id = t.opportunity_id
               WHERE COALESCE(NULLIF(TRIM(g.title), ''), NULLIF(TRIM(fo.title), '')) IS NOT NULL
               GROUP BY 1, 2
              HAVING COUNT(*) > 1
            ) d`,
  },
  {
    id: 'url_rescue_events',
    why: 'D4 — what URL rescue actually said, and which pages it accepted.',
    sql: `SELECT left(COALESCE(e.message, '(null)'), 200) AS message,
                 COUNT(*)::int AS n,
                 MAX(e.created_at) AS last_at
            FROM application_task_events e
           WHERE e.message ILIKE '%rescue%'
              OR e.step ILIKE '%rescue%'
              OR e.event_type ILIKE '%rescue%'
           GROUP BY 1
           ORDER BY n DESC
           LIMIT 40`,
  },
  {
    id: 'classification_confidence_events',
    why: 'D3 — is the reported classification confidence a constant?',
    sql: `SELECT substring(e.message from 'confidence ([0-9.]+)') AS confidence,
                 substring(e.message from 'as "([a-z_]+)"')        AS classified_as,
                 COUNT(*)::int AS n
            FROM application_task_events e
           WHERE e.message ILIKE '%confidence%'
           GROUP BY 1, 2
           ORDER BY n DESC
           LIMIT 40`,
  },
  {
    id: 'degraded_resolver_events',
    why: 'D9 — how often a resolver degraded, and whether the run continued anyway.',
    sql: `SELECT left(COALESCE(e.message, '(null)'), 160) AS message,
                 COUNT(*)::int AS n
            FROM application_task_events e
           WHERE e.message ILIKE '%degraded%'
              OR e.message ILIKE '%funder_contact_packet%'
           GROUP BY 1
           ORDER BY n DESC
           LIMIT 25`,
  },
  {
    id: 'listing_decomposition_events',
    why: 'D10 — did listing decomposition find nothing, or fail silently?',
    sql: `SELECT left(COALESCE(e.message, '(null)'), 200) AS message,
                 COUNT(*)::int AS n
            FROM application_task_events e
           WHERE e.message ILIKE '%decompos%'
           GROUP BY 1
           ORDER BY n DESC
           LIMIT 25`,
  },
  {
    id: 'junk_host_opportunities',
    why: 'D4a — are the SEO-content-farm pages the owner saw stored as application URLs?',
    sql: `SELECT lower(substring(COALESCE(application_url, source_url) from '^https?://([^/]+)')) AS host,
                 COUNT(*)::int AS n
            FROM funding_opportunities
           WHERE COALESCE(application_url, source_url) ILIKE ANY (ARRAY[
                   '%mjnewellhomes.com%',
                   '%nationaltaxreports.com%',
                   '%wemakescholars.com%',
                   '%tbr.edu%'
                 ])
           GROUP BY 1
           ORDER BY n DESC
           LIMIT 20`,
  },
  {
    id: 'grants_status_counts',
    why: 'D15 — the Application Tracker lanes as they exist on the grants table.',
    sql: `SELECT COALESCE(status, '(null)') AS status, COUNT(*)::int AS n
            FROM grants
           GROUP BY 1
           ORDER BY n DESC`,
  },
];

async function main() {
  const client = new Client({
    connectionString: CONNECTION,
    ssl: { rejectUnauthorized: false },
    application_name: 'hamilton-task-probe',
  });

  await client.connect();
  // Hard write guard: even a typo'd statement cannot mutate production.
  await client.query('SET default_transaction_read_only = on');
  await client.query('SET statement_timeout = 60000');

  const results = [];
  for (const q of QUERIES) {
    try {
      const { rows } = await client.query(q.sql);
      results.push({ id: q.id, why: q.why, sql: q.sql, rowCount: rows.length, rows });
      console.log(`ok   ${q.id} (${rows.length} row(s))`);
    } catch (error) {
      results.push({ id: q.id, why: q.why, sql: q.sql, error: String(error.message || error) });
      console.log(`FAIL ${q.id}: ${error.message}`);
    }
  }

  await client.end();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'hamilton-task-probe.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(`\nwrote ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
