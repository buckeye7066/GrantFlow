import fs from 'node:fs'

function replaceExact(file, before, after, label) {
  const text = fs.readFileSync(file, 'utf8')
  const first = text.indexOf(before)
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block missing or ambiguous`)
  }
  fs.writeFileSync(file, text.slice(0, first) + after + text.slice(first + before.length))
}

const verificationFile = 'backend/services/linkVerificationService.js'
replaceExact(
  verificationFile,
  `        " AND COALESCE(is_hidden, ?) = ? AND COALESCE(link_status, 'unverified') IN ('unverified', 'unknown', 'broken')",`,
  `        // proof-based startup quarantine: only a timestamped successful probe
        // may keep a direct/benefit row visible. skipped, null, stale-claimed,
        // unknown, and future noncanonical statuses all fail closed.
        " AND COALESCE(is_hidden, ?) = ? AND (COALESCE(link_status, 'unverified') NOT IN ('ok', 'redirect', 'verified') OR last_verified_at IS NULL)",`,
  'proof-based direct quarantine rule',
)

const testFile = 'backend/tests/linkVerificationQuarantine.test.js'
replaceExact(
  testFile,
  `      insertOpportunity(db, { id: 'broken-direct', url: 'https://8.8.8.8/broken', status: 'broken' })
      insertOpportunity(db, { id: 'directory-resource', kind: 'directory', status: 'unverified' })`,
  `      insertOpportunity(db, { id: 'broken-direct', url: 'https://8.8.8.8/broken', status: 'broken' })
      insertOpportunity(db, { id: 'skipped-direct', url: 'https://8.8.8.8/skipped', status: 'skipped' })
      insertOpportunity(db, { id: 'directory-resource', kind: 'directory', status: 'unverified' })`,
  'skipped-status quarantine fixture',
)
replaceExact(
  testFile,
  `      expect(stats).toMatchObject({ ok: true, quarantined: 2, deactivated: 1, restored: 1 })`,
  `      expect(stats).toMatchObject({ ok: true, quarantined: 3, deactivated: 1, restored: 1 })`,
  'proof-based quarantine count',
)
replaceExact(
  testFile,
  `      expect(readRow(db, 'broken-direct')).toMatchObject({ is_hidden: 1, is_active: 0 })
      expect(readRow(db, 'directory-resource')).toMatchObject({ is_hidden: 0, is_active: 1 })`,
  `      expect(readRow(db, 'broken-direct')).toMatchObject({ is_hidden: 1, is_active: 0 })
      expect(readRow(db, 'skipped-direct')).toMatchObject({ is_hidden: 1, is_active: 1 })
      expect(readRow(db, 'directory-resource')).toMatchObject({ is_hidden: 0, is_active: 1 })`,
  'skipped-status quarantine assertion',
)

const verification = fs.readFileSync(verificationFile, 'utf8')
if (!verification.includes('proof-based startup quarantine')) {
  throw new Error('proof-based startup quarantine was not installed')
}
if (!verification.includes("NOT IN ('ok', 'redirect', 'verified') OR last_verified_at IS NULL")) {
  throw new Error('direct visibility is not restricted to positive verification proof')
}

console.log('[global-hardening] proof-based startup quarantine applied')
