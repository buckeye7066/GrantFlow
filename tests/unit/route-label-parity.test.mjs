import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Every routable page must have a human breadcrumb label. Production
// 2026-09-11: 20 of 65 routes had none, so the breadcrumb and page chrome
// rendered raw route ids such as "NewProject", "InvoiceView" and
// "GreenHomePrograms".
const read = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('every ROUTE_NAMES entry has a ROUTE_LABELS breadcrumb label', () => {
  const names = [...read('src/pages/routeNames.js').matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1])
  const base = read('src/nav/navConfigBase.js')
  const start = base.indexOf('export const ROUTE_LABELS')
  const end = base.indexOf('export const ROUTE_LABEL_I18N')
  assert.ok(start >= 0 && end > start, 'ROUTE_LABELS block not found')
  const labeled = new Set([...base.slice(start, end).matchAll(/^\s+([A-Za-z]+):/gm)].map((m) => m[1]))
  assert.ok(names.length > 40, `route names not parsed (${names.length})`)
  const missing = names.filter((name) => !labeled.has(name))
  assert.deepEqual(missing, [], `routes without a breadcrumb label: ${missing.join(', ')}`)
})
