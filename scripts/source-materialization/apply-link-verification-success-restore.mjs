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
  const restoreActive = db.prepare(\`
    UPDATE funding_opportunities
       SET is_hidden = ?, is_active = ?,
           status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
     WHERE id = ? AND COALESCE(status, 'active') <> 'expired'
  \`)`,
    'Recurring verifier restore statement',
  )
  replaceOnce(
    /          row\.id,\n        \)\n        stats\.checked\+\+/,
    `          row.id,
        )
        if (result.status === 'ok' || result.status === 'redirect') {
          await restoreActive.run(falseVal, trueVal, row.id)
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
      await db.prepare(\`
        UPDATE funding_opportunities
           SET is_hidden = ?, is_active = ?,
               status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
         WHERE id = ? AND COALESCE(status, 'active') <> 'expired'
      \`).run(isPostgres ? false : 0, isPostgres ? true : 1, String(oppRow.id))
    }
  } catch {`,
    'Immediate verifier lifecycle restore',
  )
  fs.writeFileSync(file, source)
  console.log('[source-materialization] successful link verification restores visibility')
}
