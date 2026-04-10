export async function rollbackBadRules(db) {
  const since1d = db?.dialect === 'postgres'
    ? "created_at > (NOW() - INTERVAL '1 day')"
    : "created_at > datetime('now', '-1 day')"
  const rows = await db.prepare(`
    SELECT rule_id, COUNT(*) as cnt
    FROM exclusion_audit
    WHERE false_positive = 1
      AND ${since1d}
    GROUP BY rule_id
  `).all()

  for (const r of rows) {
    if (r.cnt >= 3) {
      await db.prepare(`
        UPDATE exclusion_rules
        SET action = 'watch'
        WHERE rule_id = ?
      `).run(r.rule_id)
    }
  }
}
