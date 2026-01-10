/**
 * Public-safe health summary for monitoring and smoke tests.
 * This must not expose secrets or sensitive payloads.
 */

export function getSafeHealthSummary(db) {
  const summary = {
    timestamp: new Date().toISOString(),
    status: 'healthy',
    counts: {
      opportunities: 0,
      recentFailures: 0,
    },
    summary: 'OK',
  }

  try {
    // Basic DB connectivity check
    db.prepare('SELECT 1').get()
  } catch (error) {
    summary.status = 'degraded'
    summary.summary = 'Database unavailable'
    return summary
  }

  try {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1')
      .get()
    summary.counts.opportunities = row?.count ?? 0
  } catch {
    // Optional; keep summary safe
  }

  try {
    // Best-effort: crawler job failures may not exist in all schemas
    const row = db
      .prepare(
        `
          SELECT COUNT(*) as count
          FROM crawler_jobs
          WHERE status = 'failed'
            AND created_at >= datetime('now', '-24 hours')
        `,
      )
      .get()
    summary.counts.recentFailures = row?.count ?? 0
  } catch {
    // Optional; keep summary safe
  }

  if (summary.counts.recentFailures > 0) {
    summary.status = 'degraded'
    summary.summary = 'Recent crawler failures detected'
  }

  return summary
}

