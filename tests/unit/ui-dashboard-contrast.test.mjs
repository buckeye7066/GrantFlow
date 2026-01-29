import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  const p = path.resolve(process.cwd(), relPath)
  return fs.readFileSync(p, 'utf8')
}

test('dashboard: avoid low-contrast and opacity-based informational text', () => {
  const files = [
    'src/pages/Dashboard.jsx',
    'src/components/dashboard/PipelineStatusCard.jsx',
    'src/components/dashboard/PipelineActionsCard.jsx',
    'src/components/dashboard/PersonalizationPanel.jsx',
    'src/components/dashboard/ReminderCenterCard.jsx',
    'src/components/dashboard/RecentGrantsCard.jsx',
    'src/components/dashboard/UrgentDeadlinesCard.jsx',
    'src/components/dashboard/UpcomingMilestonesCard.jsx',
  ]

  // Non-negotiable readability rule:
  // - Avoid slate-400/500 label text on light backgrounds
  // - Avoid opacity-based text utilities (e.g. text-blue-700/80, text-white/70) for informational text
  // - Avoid relying on text-muted-foreground for informational copy
  const forbiddenSubstrings = ['text-slate-400', 'text-slate-500', 'text-muted-foreground']
  const opacityTextClass = /text-[a-z0-9-]+\/(10|20|30|40|50|60|70|80|90)\b/i

  for (const file of files) {
    const src = read(file)
    for (const needle of forbiddenSubstrings) {
      assert.ok(!src.includes(needle), `${file} should not include ${needle}`)
    }
    assert.ok(!opacityTextClass.test(src), `${file} should not include opacity-based text classes like text-*/70`)
  }
})

