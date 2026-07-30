import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, value) => fs.writeFileSync(file, value)

function countMatches(value, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return value.match(new RegExp(pattern.source, flags))?.length || 0
}

function replaceExactlyOnce(source, pattern, replacement, label) {
  const matches = countMatches(source, pattern)
  if (matches !== 1) throw new Error(`${label}: expected one match, found ${matches}`)
  return source.replace(pattern, replacement)
}

const serviceFile = 'backend/services/linkBacklogRepairService.js'
const routeFile = 'backend/routes/linkBacklogRepair.js'
const testFile = 'backend/tests/linkBacklogSafetyRegression.test.js'

const serviceBefore = read(serviceFile)
const routeBefore = read(routeFile)
const testBefore = read(testFile)

if (
  serviceBefore.includes('scheduled_retry_portable_order') &&
  routeBefore.includes('scheduled_retry_uses_canonical_30_day_window') &&
  testBefore.includes('pins scheduled retry to portable ordering and the verifier window')
) {
  console.log('[source-materialization] scheduled-retry portability already present')
} else {
  if (
    serviceBefore.includes('scheduled_retry_portable_order') ||
    routeBefore.includes('scheduled_retry_uses_canonical_30_day_window') ||
    testBefore.includes('pins scheduled retry to portable ordering and the verifier window')
  ) {
    throw new Error('[source-materialization] partial scheduled-retry portability detected')
  }

  let serviceAfter = replaceExactlyOnce(
    serviceBefore,
    /  const retryAfterDays = Math\.max\(1, Math\.min\(90, Number\(options\.retryAfterDays\) \|\| 30\)\)/,
    `  // scheduled_retry_uses_canonical_30_day_window: runLinkVerification uses
  // a fixed 30-day re-verification window. Do not expose a pretend per-request
  // delay that the verifier cannot honor.
  const retryAfterDays = 30`,
    'Canonical scheduled-retry window',
  )
  serviceAfter = replaceExactlyOnce(
    serviceAfter,
    /     ORDER BY fo\.last_verified_at ASC NULLS FIRST, fo\.id ASC/,
    `     -- scheduled_retry_portable_order: explicit CASE works on both SQLite and Postgres.
     ORDER BY CASE WHEN fo.last_verified_at IS NULL THEN 0 ELSE 1 END,
              fo.last_verified_at ASC, fo.id ASC`,
    'Portable scheduled-retry ordering',
  )

  const routeAfter = replaceExactlyOnce(
    routeBefore,
    /      retryAfterDays: req\.body\?\.retry_after_days,/,
    `      // scheduled_retry_uses_canonical_30_day_window
      retryAfterDays: 30,`,
    'Canonical scheduled-retry route window',
  )

  const testMarker = "  it('pins shared locking and success-driven visibility restoration', () => {"
  const first = testBefore.indexOf(testMarker)
  if (first < 0 || testBefore.indexOf(testMarker, first + testMarker.length) >= 0) {
    throw new Error('Scheduled-retry portability regression marker missing or ambiguous')
  }
  const testAddition = `  it('pins scheduled retry to portable ordering and the verifier window', () => {
    const service = fs.readFileSync(path.resolve(HERE, '../services/linkBacklogRepairService.js'), 'utf8')
    const route = fs.readFileSync(path.resolve(HERE, '../routes/linkBacklogRepair.js'), 'utf8')
    expect(service).toContain('scheduled_retry_portable_order')
    expect(service).not.toContain('fo.last_verified_at ASC NULLS FIRST')
    expect(service).toContain('const retryAfterDays = 30')
    expect(route).toContain('scheduled_retry_uses_canonical_30_day_window')
    expect(route).toContain('retryAfterDays: 30')
  })

`
  const testAfter = testBefore.slice(0, first) + testAddition + testBefore.slice(first)

  const originals = new Map([
    [serviceFile, serviceBefore],
    [routeFile, routeBefore],
    [testFile, testBefore],
  ])
  const outputs = new Map([
    [serviceFile, serviceAfter],
    [routeFile, routeAfter],
    [testFile, testAfter],
  ])
  const written = []
  try {
    for (const [file, value] of outputs) {
      write(file, value)
      written.push(file)
    }
  } catch (error) {
    for (const file of written.reverse()) {
      try { write(file, originals.get(file)) } catch { /* keep first error */ }
    }
    throw error
  }

  console.log('[source-materialization] scheduled-retry portability applied')
}
