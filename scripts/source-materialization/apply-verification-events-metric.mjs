import fs from 'node:fs'

const serviceFile = 'backend/services/missionHealthService.js'
const testFile = 'tests/mission/mission-health-dashboard.test.mjs'
const canonicalMetricSignature = 'SELECT COUNT(*) AS n FROM verification_events WHERE ts >= ?'

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, text) {
  fs.writeFileSync(file, text)
}

function replaceExactlyOnce(file, before, after, label) {
  const source = read(file)
  const first = source.indexOf(before)
  const second = first < 0 ? -1 : source.indexOf(before, first + before.length)
  if (first < 0 || second >= 0) {
    throw new Error(`${label}: expected exactly one source match`)
  }
  write(file, source.slice(0, first) + after + source.slice(first + before.length))
}

const serviceSource = read(serviceFile)
if (!serviceSource.includes(canonicalMetricSignature)) {
  replaceExactlyOnce(
    serviceFile,
    'SELECT COUNT(*) AS n FROM verification_events WHERE created_at >= ?',
    canonicalMetricSignature,
    'verification-events metric column',
  )
}

let testSource = read(testFile)
if (!testSource.includes('CREATE TABLE verification_events (\n      id TEXT PRIMARY KEY,\n      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP')) {
  const legacySchema = 'CREATE TABLE verification_events (\n      id TEXT PRIMARY KEY,\n      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
  const canonicalSchema = 'CREATE TABLE verification_events (\n      id TEXT PRIMARY KEY,\n      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
  const first = testSource.indexOf(legacySchema)
  const second = first < 0 ? -1 : testSource.indexOf(legacySchema, first + legacySchema.length)
  if (first < 0 || second >= 0) {
    throw new Error('verification-events test schema: expected exactly one legacy schema match')
  }
  testSource = testSource.slice(0, first) + canonicalSchema + testSource.slice(first + legacySchema.length)
}

const testName = "test('mission-health: verification_events_24h uses the canonical ts column'"
if (!testSource.includes(testName)) {
  const marker = "test('mission-health: targets export matches the production minimums'"
  const index = testSource.indexOf(marker)
  if (index < 0 || testSource.indexOf(marker, index + marker.length) >= 0) {
    throw new Error('verification-events test insertion marker missing or ambiguous')
  }
  const test = `test('mission-health: verification_events_24h uses the canonical ts column', async () => {\n  const db = createDb()\n  const recent = new Date().toISOString()\n  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()\n  db.raw.prepare('INSERT INTO verification_events (id, ts) VALUES (?, ?)').run('recent', recent)\n  db.raw.prepare('INSERT INTO verification_events (id, ts) VALUES (?, ?)').run('old', old)\n\n  const h = await buildMissionHealth(db)\n\n  assert.equal(h.counts.verification_events_24h, 1)\n})\n\n`
  testSource = testSource.slice(0, index) + test + testSource.slice(index)
}
write(testFile, testSource)

const finalService = read(serviceFile)
const finalTest = read(testFile)
if (!finalService.includes(canonicalMetricSignature)) {
  throw new Error('verification-events metric did not materialize with the canonical ts column')
}
if (!finalTest.includes(testName)) {
  throw new Error('verification-events regression test did not materialize')
}

console.log('[global-hardening] verification-events metric uses canonical ts column')
