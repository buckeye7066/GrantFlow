import fs from 'node:fs'

const file = 'backend/services/linkVerificationService.js'
let source = fs.readFileSync(file, 'utf8')
const signature = 'link_repair_success_restores_visibility'
if (source.includes(signature)) {
  console.log('[source-materialization] link verification success restore already present')
} else {
  function replaceOnce(pattern, replacement, label) {
    const matches = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) || []
    if (matches.length !== 1) throw new Error(`${label}: expected one match, found ${matches.length}`)
    source = source.replace(pattern, replacement)
  }

  replaceOnce(
    /  const isPostgres = db\?\.dialect === 'postgres'\n  const falseVal = isPostgres \? false : 0/,
    `  const isPostgres = db?.dialect === 'postgres'
  const falseVal = isPostgres ? false : 0
  const trueVal = isPostgres ? true : 1
  // link_repair_success_restores_visibility: current proof heals quarantine.
  // Legacy/minimal schemas may not carry status; restoration is additive and
  // must never invalidate the canonical verification timestamp write.
  const restoreVerifiedVisibility = async (opportunityId) => {
    try {
      await db.prepare(\`
        UPDATE funding_opportunities
           SET is_hidden = ?, is_active = ?,
               status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
         WHERE id = ? AND COALESCE(status, 'active') <> 'expired'
      \`).run(falseVal, trueVal, opportunityId)
    } catch {
      try {
        await db.prepare(\`
          UPDATE funding_opportunities SET is_hidden = ?, is_active = ? WHERE id = ?
        \`).run(falseVal, trueVal, opportunityId)
      } catch { /* visibility columns may also be absent on a narrow legacy fixture */ }
    }
  }`,
    'Recurring verifier restore helper',
  )
  replaceOnce(
    /          row\.id,\n        \)\n        stats\.checked\+\+/,
    `          row.id,
        )
        if (result.status === 'ok' || result.status === 'redirect') {
          await restoreVerifiedVisibility(row.id)
        }
        stats.checked++`,
    'Recurring verifier lifecycle restore',
  )
  replaceOnce(
    /      String\(oppRow\.id\),\n    \)\n  \} catch \{/,
    `      String(oppRow.id),
    )
    if (result.status === 'ok' || result.status === 'redirect') {
      const isPostgres = db?.dialect === 'postgres'
      const falseVal = isPostgres ? false : 0
      const trueVal = isPostgres ? true : 1
      try {
        await db.prepare(\`
          UPDATE funding_opportunities
             SET is_hidden = ?, is_active = ?,
                 status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
           WHERE id = ? AND COALESCE(status, 'active') <> 'expired'
        \`).run(falseVal, trueVal, String(oppRow.id))
      } catch {
        try {
          await db.prepare(\`
            UPDATE funding_opportunities SET is_hidden = ?, is_active = ? WHERE id = ?
          \`).run(falseVal, trueVal, String(oppRow.id))
        } catch { /* legacy schema: verification truth already persisted above */ }
      }
    }
  } catch {`,
    'Immediate verifier lifecycle restore',
  )
  fs.writeFileSync(file, source)
  console.log('[source-materialization] successful link verification restores visibility')
}
