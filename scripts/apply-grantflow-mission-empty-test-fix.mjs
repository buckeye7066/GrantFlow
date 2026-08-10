import fs from 'node:fs'

const file = 'tests/mission/mission-health-dashboard.test.mjs'
let source = fs.readFileSync(file, 'utf8')

const before = `test('mission-health: empty DB returns ok=true and zero counts', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.equal(h.ok, true)
  assert.equal(h.counts.direct_opportunities_total, 0)
  assert.equal(h.counts.placeholder_opportunities, 0)
  assert.equal(h.alerts.length, 0)
  assert.ok(h.matcher_version)
  assert.ok(h.targets)
})`

const after = `test('mission-health: empty DB stays live but blocks a production release', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.equal(h.ok, true)
  assert.equal(h.counts.direct_opportunities_total, 0)
  assert.equal(h.counts.placeholder_opportunities, 0)
  assert.equal(h.production_gate, false)
  assert.ok(h.release_blockers.some((blocker) => blocker.code === 'release_catalog_empty'))
  assert.ok(h.release_blockers.some((blocker) => blocker.code === 'visible_direct_catalog_empty'))
  assert.equal(h.alerts.length, 2)
  assert.ok(h.matcher_version)
  assert.ok(h.targets)
})`

const first = source.indexOf(before)
if (first < 0) throw new Error('Missing original empty-database mission test')
if (source.indexOf(before, first + before.length) >= 0) {
  throw new Error('Expected one original empty-database mission test')
}
source = source.slice(0, first) + after + source.slice(first + before.length)
fs.writeFileSync(file, source)
console.log('Updated empty-database mission test for strict release gating.')
