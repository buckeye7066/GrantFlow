import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  const p = path.resolve(process.cwd(), relPath)
  return fs.readFileSync(p, 'utf8')
}

test('BillingSheet: contains all canonical service IDs (drift guard)', () => {
  const src = read('src/pages/BillingSheet.jsx')
  const expectedIds = [
    'quick_scan',
    'comprehensive_dossier',
    'application_strategy',
    'micro_grant',
    'standard_foundation',
    'complex_federal',
    'scholarship_pack',
    'editing',
    'budget_development',
    'compliance_reporting',
    'grant_calendar',
    'hourly_consultation',
  ]

  for (const id of expectedIds) {
    assert.ok(src.includes(`id: '${id}'`) || src.includes(`id: \"${id}\"`), `missing BillingSheet service id: ${id}`)
  }
})

