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
    id: 'completed_at_by_second',
    why: 'D5 — same check for completions landing in a single second.',
    sql: `SELECT date_trunc('second', completed_at) AS at_second, COUNT(*)::int AS n
            FROM application_tasks
           WHERE completed_at IS NOT NULL
           GROUP BY 1
           ORDER BY n DESC, 1 DESC
           LIMIT 15`,
  },
  {
    id: 'title_resolution',
    why: 'D2 — can a display name be resolved at all, or is it genuinely absent?',
    sql: `SELECT COUNT(*)::int                                                        AS tasks,
                 COUNT(t.opportunity_id)::int                                          AS with_opportunity_id,
                 COUNT(t.grant_id)::int                                                AS with_grant_id,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(g.title), '') IS NOT NULL)::int     AS grant_title_present,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(fo.title), '') IS NOT NULL)::int    AS opportunity_title_present,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(g.funder), '') IS NOT NULL)::int    AS grant_funder_present,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(fo.sponsor), '') IS NOT NULL)::int  AS opportunity_sponsor_present,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(t.application_url), '') IS NOT NULL)::int AS task_application_url_present,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(t.portal_url), '') IS NOT NULL)::int      AS task_portal_url_present,
                 COUNT(*) FILTER (
                   WHERE NULLIF(TRIM(g.title), '') IS NULL
                     AND NULLIF(TRIM(fo.title), '') IS NULL
                 )::int                                                                AS no_title_anywhere
            FROM application_tasks t
            LEFT JOIN grants g ON g.id = t.grant_id
            LEFT JOIN funding_opportunities fo ON fo.id = t.opportunity_id`,
  },
  {
    id: 'submitted_tasks',
    why: 'D10/D12/D14 — what the tasks that reached `submitted` actually recorded.',
    sql: `SELECT t.id,
                 t.status,
                 t.automation_type,
                 t.submitted_at,
                 t.auto_submit_enabled,
                 t.allow_auto_submit,
                 t.application_url,
                 t.portal_url,
                 COALESCE(NULLIF(TRIM(g.title), ''), NULLIF(TRIM(fo.title), '')) AS resolved_title,
                 COALESCE(NULLIF(TRIM(g.funder), ''), NULLIF(TRIM(fo.sponsor), '')) AS resolved_funder
            FROM application_tasks t
            LEFT JOIN grants g ON g.id = t.grant_id
            LEFT JOIN funding_opportunities fo ON fo.id = t.opportunity_id
           WHERE t.status = 'submitted' OR t.submitted_at IS NOT NULL
           ORDER BY t.submitted_at DESC NULLS LAST
           LIMIT 50`,
  },
  {
    id: 'auto_submit_settings',
    why: 'D12 — is Hamilton even permitted to submit? Distribution of the two flags.',
    sql: `SELECT COALESCE(auto_submit_enabled::text, '(null)') AS auto_submit_enabled,
                 COALESCE(allow_auto_submit::text, '(null)')   AS allow_auto_submit,
                 COUNT(*)::int AS n
            FROM application_tasks
           GROUP BY 1, 2
           ORDER BY n DESC`,
  },
  {
    id: 'task_event_types',
    why: 'D5/D11 — what per-task events are persisted, and by which actor role.',
    sql: `SELECT event_type,
                 COALESCE(status, '(null)')     AS status,
                 COALESCE(actor_role, '(null)') AS actor_role,
                 COUNT(*)::int AS n
            FROM application_task_events
           GROUP BY 1, 2, 3
           ORDER BY n DESC
           LIMIT 60`,
  },
  {
    id: 'cancellation_events_present',
    why: 'D5 — was a REASON recorded for the mass cancellation, or none at all?',
    sql: `SELECT COUNT(*)::int AS cancelled_tasks,
                 COUNT(*) FILTER (WHERE e.task_id IS NOT NULL)::int AS with_any_cancel_event,
                 COUNT(*) FILTER (
                   WHERE NULLIF(TRIM(t.last_agent_message), '') IS NOT NULL
                 )::int AS with_last_agent_message
            FROM application_tasks t
            LEFT JOIN LATERAL (
              SELECT 1 AS task_id
                FROM application_task_events e
               WHERE e.task_id = t.id
                 AND (e.event_type ILIKE '%cancel%' OR e.status = 'cancelled')
               LIMIT 1
            ) e ON TRUE
           WHERE t.status = 'cancelled'`,
  },
  {
    id: 'grants_status_counts',
    why: 'D15 — the Application Tracker lanes (Draft / In Progress / Submitted / Withdrawn ...).',
    sql: `SELECT COALESCE(status, '(null)') AS status, COUNT(*)::int AS n
            FROM grants
           GROUP BY 1
           ORDER BY n DESC`,
  },
  {
    id: 'grants_untitled',
    why: 'D2/D15 — how many tracker rows carry no usable title.',
    sql: `SELECT COUNT(*)::int AS grants,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(title), '') IS NULL)::int  AS no_title,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(funder), '') IS NULL)::int AS no_funder,
                 COUNT(*) FILTER (WHERE funding_opportunity_id IS NULL)::int   AS no_opportunity_link
            FROM grants`,
  },
  {
    id: 'grants_withdrawn_by_second',
    why: 'D15 — is "Withdrawn" the same one-second sweep as the run view "cancelled"?',
    sql: `SELECT date_trunc('second', updated_at) AS at_second,
                 COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE NULLIF(TRIM(title), '') IS NULL)::int AS untitled
            FROM grants
           WHERE status ILIKE 'withdraw%'
           GROUP BY 1
           ORDER BY n DESC, 1 DESC
           LIMIT 15`,
  },
  {
    id: 'duplicate_programs',
    why: 'D14 — duplicate program records per profile, keyed loosely on title.',
    sql: `SELECT profile_id,
                 lower(regexp_replace(COALESCE(title, ''), '[^a-z0-9]+', ' ', 'gi')) AS norm_title,
                 COUNT(*)::int AS n,
                 COUNT(DISTINCT COALESCE(funder, ''))::int AS distinct_funders,
                 COUNT(DISTINCT COALESCE(funding_opportunity_id::text, ''))::int AS distinct_opportunities
            FROM grants
           WHERE NULLIF(TRIM(title), '') IS NOT NULL
           GROUP BY 1, 2
          HAVING COUNT(*) > 1
           ORDER BY n DESC
           LIMIT 60`,
  },
  {
    id: 'duplicate_task_opportunities',
    why: 'D4c/D14 — the same opportunity or URL claimed by more than one task.',
    sql: `SELECT COUNT(*)::int AS duplicated_groups,
                 COALESCE(SUM(n) - COUNT(*), 0)::int AS excess_rows
            FROM (
              SELECT profile_id, opportunity_id, COUNT(*)::int AS n
                FROM application_tasks
               WHERE opportunity_id IS NOT NULL
               GROUP BY 1, 2
              HAVING COUNT(*) > 1
            ) d`,
  },
  {
    id: 'duplicate_task_application_urls',
    why: 'D4c — the same rescued URL attached to more than one task.',
    sql: `SELECT application_url, COUNT(*)::int AS n
            FROM application_tasks
           WHERE NULLIF(TRIM(application_url), '') IS NOT NULL
           GROUP BY 1
          HAVING COUNT(*) > 1
           ORDER BY n DESC
           LIMIT 40`,
  },
  {
    id: 'rescued_url_hosts',
    why: 'D4a — which hosts URL rescue actually accepted as application pages.',
    sql: `SELECT lower(substring(application_url from '^https?://([^/]+)')) AS host,
                 COUNT(*)::int AS n
            FROM application_tasks
           WHERE NULLIF(TRIM(application_url), '') IS NOT NULL
           GROUP BY 1
           ORDER BY n DESC
           LIMIT 60`,
  },
  {
    id: 'submission_events_table',
    why: 'D12/D13 — does anything write submission_events, and with what recorded_by?',
    sql: `SELECT event_type,
                 COALESCE(outcome, '(null)')     AS outcome,
                 COALESCE(recorded_by, '(null)') AS recorded_by,
                 COUNT(*)::int AS n
            FROM submission_events
           GROUP BY 1, 2, 3
           ORDER BY n DESC
           LIMIT 40`,
  },
  {
    id: 'deadline_events_table',
    why: 'D13 — does a per-profile forward-looking calendar mechanism already carry rows?',
    sql: `SELECT event_type, COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE due_at IS NOT NULL)::int AS with_due_at
            FROM deadline_events
           GROUP BY 1
           ORDER BY n DESC
           LIMIT 40`,
  },
  {
    id: 'manual_receipts',
    why: 'D12 — how many submissions were attested manually by the owner.',
    sql: `SELECT COALESCE(status, '(null)') AS status,
                 COALESCE(channel, '(null)') AS channel,
                 COUNT(*)::int AS n
            FROM hamilton_manual_submission_receipts
           GROUP BY 1, 2
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
