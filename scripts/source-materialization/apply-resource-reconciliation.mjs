import fs from 'node:fs'

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, text) { fs.writeFileSync(file, text) }

function replaceOne(file, pattern, replacement, label) {
  const before = read(file)
  const matches = [...before.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
  if (matches.length !== 1) {
    throw new Error(`${label || file}: expected one match, found ${matches.length}`)
  }
  write(file, before.replace(pattern, replacement))
}

function insertBefore(file, marker, text, label) {
  const before = read(file)
  const first = before.indexOf(marker)
  if (first < 0 || before.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label || file}: marker missing or ambiguous`)
  }
  write(file, before.slice(0, first) + text + before.slice(first))
}

const persistenceFile = 'backend/services/crawlerOsPersistence.js'
const persistenceBefore = read(persistenceFile)
const hasSnapshotFacade =
  persistenceBefore.includes('async function snapshotResourceMatches') &&
  persistenceBefore.includes('async function restoreResourceMatches') &&
  persistenceBefore.includes('resourcesPreserved')
const hasInlineReconciliation =
  persistenceBefore.includes('const deleteStaleDirectMatches = db.prepare') &&
  persistenceBefore.includes('const deleteExplicitReject = db.prepare')

// Current need-first main already carries a stronger snapshot/restore facade. It
// preserves omitted resource rows across the authoritative core reconcile and
// still honors explicit current REJECT decisions. Do not replace a newer valid
// implementation merely because the earlier inline implementation is absent.
if (!hasSnapshotFacade && !hasInlineReconciliation) {
  replaceOne(
    persistenceFile,
    /  \/\/ per-profile matches \(score lives ONLY here\)\.[\s\S]*?(?=  const nowFn =)/,
    `  // per-profile matches (score lives ONLY here).
  //
  // Direct funding is authoritative per discovery run: an old direct match that
  // was not reproduced is stale and must be removed. Non-direct resources are
  // intentionally durable. A directory, referral, school portal, or past-award
  // pointer can remain useful even when one bounded source plan does not find it
  // again, so omission is not a negative eligibility verdict. Preserve those
  // rows unless this run explicitly emits REJECT for the same profile + source.
  const matchRows = memStore.all('profile_opportunity_matches');
  const profileIds = [...new Set(matchRows.map((m) => m.profile_id).filter(Boolean))];
  const reconcileProfiles = primaryProfileId ? [primaryProfileId] : profileIds;
  const reconcileProfileSet = new Set(reconcileProfiles.map((id) => String(id)));
  const resourceKindsSql = "('DIRECTORY', 'PAST_AWARD_INTEL', 'SCHOOL_PORTAL', 'REFERRAL')";

  const deleteStaleDirectMatches = db.prepare(\`
    DELETE FROM profile_opportunity_matches
     WHERE profile_id = ?
       AND matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND opportunity_id NOT IN (
         SELECT id
           FROM funding_opportunities
          WHERE UPPER(COALESCE(opportunity_kind, '')) IN \${resourceKindsSql}
       )
  \`);
  const deleteExplicitReject = db.prepare(\`
    DELETE FROM profile_opportunity_matches
     WHERE profile_id = ?
       AND opportunity_id = ?
       AND matcher_version IN ('crawler-os', 'crawler-os-xmatch')
  \`);

  for (const pid of reconcileProfiles) {
    await deleteStaleDirectMatches.run(pid);
  }

  // Explicit current evidence outranks durability. A resource that this run
  // actually evaluated as REJECT is removed; only mere omission is preserved.
  for (const match of matchRows) {
    if (String(match?.decision ?? '').toLowerCase() !== 'reject') continue;
    if (!reconcileProfileSet.has(String(match?.profile_id ?? ''))) continue;
    const rejectedOpportunityId = idRemap.get(match.opportunity_id) ?? match.opportunity_id;
    await deleteExplicitReject.run(String(match.profile_id), rejectedOpportunityId);
  }
`,
    'resource-preserving profile-match reconciliation',
  )
} else {
  console.log('[global-hardening] compatible resource-preserving reconciliation already present')
}

const verificationFile = 'backend/services/linkVerificationService.js'

// Separate the catalog safety transition from network verification. Railway
// probes /readyz immediately after the process binds; the recurring verifier is
// intentionally delayed and network-bound. This helper is one bounded SQL-only
// transaction surface that can run synchronously after schema initialization.
insertBefore(
  verificationFile,
  'export async function runLinkVerification(',
  `export async function quarantineUnverifiedDirectOpportunities(db) {
  if (!db || typeof db.prepare !== 'function') {
    return { ok: false, quarantined: 0, deactivated: 0, restored: 0, reason: 'database_unavailable' }
  }

  const isPostgres = db?.dialect === 'postgres'
  const trueVal = isPostgres ? true : 1
  const falseVal = isPostgres ? false : 0
  const changes = (result) => Number(result?.changes ?? result?.rowCount ?? 0)
  const directPredicate = [
    "LOWER(COALESCE(opportunity_kind, 'direct')) IN ('direct', 'benefit')",
    "UPPER(COALESCE(type, '')) NOT IN ('DIRECTORY', 'REFERRAL', 'SCHOOL_PORTAL', 'PAST_AWARD_INTEL')",
    "LOWER(COALESCE(result_kind, '')) NOT IN ('directory', 'referral', 'school_portal', 'past_award_intel')",
    "LOWER(COALESCE(opportunity_type, '')) NOT LIKE '%directory%'",
    "LOWER(COALESCE(opportunity_type, '')) NOT LIKE '%referral%'",
  ].join(' AND ')

  try {
    const quarantined = await db
      .prepare(
        'UPDATE funding_opportunities SET is_hidden = ? WHERE ' + directPredicate +
        " AND COALESCE(is_hidden, ?) = ? AND COALESCE(link_status, 'unverified') IN ('unverified', 'unknown', 'broken')",
      )
      .run(trueVal, falseVal, falseVal)

    // Broken direct targets get both the soft quarantine and the hard active-row
    // kill switch so older readers that only filter is_active still fail closed.
    const deactivated = await db
      .prepare(
        'UPDATE funding_opportunities SET is_active = ? WHERE ' + directPredicate +
        " AND COALESCE(is_active, ?) = ? AND link_status = 'broken'",
      )
      .run(falseVal, trueVal, trueVal)

    // A prior interrupted sweep may have left a proven row hidden. Reveal only
    // rows carrying both a successful canonical status and a real timestamp;
    // never reactivate an independently expired/deactivated program.
    const restored = await db
      .prepare(
        'UPDATE funding_opportunities SET is_hidden = ? WHERE ' + directPredicate +
        " AND COALESCE(is_hidden, ?) = ? AND link_status IN ('ok', 'redirect', 'verified') AND last_verified_at IS NOT NULL",
      )
      .run(falseVal, falseVal, trueVal)

    return {
      ok: true,
      quarantined: changes(quarantined),
      deactivated: changes(deactivated),
      restored: changes(restored),
      reason: null,
    }
  } catch (error) {
    return {
      ok: false,
      quarantined: 0,
      deactivated: 0,
      restored: 0,
      reason: 'quarantine_failed',
      error: error?.message || String(error),
    }
  }
}

`,
  'SQL-only direct catalog quarantine helper',
)

replaceOne(
  verificationFile,
  /    expired: 0,\n  \}/,
  `    expired: 0,
    quarantined: 0,
    restored: 0,
  }`,
  'link verification quarantine counters',
)

replaceOne(
  verificationFile,
  /  const isPostgres = db\?\.dialect === 'postgres'\n  const falseVal = isPostgres \? false : 0/,
  `  const isPostgres = db?.dialect === 'postgres'
  const falseVal = isPostgres ? false : 0

  const quarantine = await quarantineUnverifiedDirectOpportunities(db)
  if (quarantine?.ok) {
    stats.quarantined += Number(quarantine.quarantined || 0)
    stats.deactivated += Number(quarantine.deactivated || 0)
    stats.restored += Number(quarantine.restored || 0)
  } else {
    console.warn('[link-verify] quarantine pass failed:', quarantine?.reason || 'unknown')
  }

  const revealVerified = db.prepare(\`
    UPDATE funding_opportunities
       SET is_hidden = ?
     WHERE id = ?
  \`)`,
  'link verification quarantine setup',
)

replaceOne(
  verificationFile,
  /        stats\.checked\+\+\n        stats\[result\.status\] = \(stats\[result\.status\] \|\| 0\) \+ 1/,
  `        stats.checked++
        stats[result.status] = (stats[result.status] || 0) + 1

        if (result.status === 'ok' || result.status === 'redirect') {
          try {
            const revealed = await revealVerified.run(falseVal, row.id)
            stats.restored += Number(revealed?.changes ?? revealed?.rowCount ?? 0)
          } catch (err) {
            console.warn('[link-verify] reveal verified row failed for', row.id, err?.message)
          }
        }`,
  'link verification reveal on success',
)

// The SQL-only transition must finish after migrations/schema invariants and
// before app.listen makes /readyz reachable. The slow network sweep remains on
// its existing 30-second delayed scheduler.
replaceOne(
  'backend/server.js',
  /import \{ runLinkVerification, getLinkHealthSummary \} from '\.\/services\/linkVerificationService\.js'/,
  `import {
  runLinkVerification,
  getLinkHealthSummary,
  quarantineUnverifiedDirectOpportunities,
} from './services/linkVerificationService.js'`,
  'startup quarantine import',
)

insertBefore(
  'backend/server.js',
  '  // Publish this process\'s automation posture',
  `  // Production readiness is allowed to inspect only the safe, user-visible
  // direct catalog. Quarantine every unproven/broken direct row synchronously,
  // after schema initialization but before app.listen exposes /readyz. This is
  // SQL-only; the recurring network verifier remains non-blocking below.
  const enforceMissionGateAtBoot =
    String(process.env.NODE_ENV || '').toLowerCase() === 'production' &&
    String(process.env.GRANTFLOW_SKIP_MISSION_GATE || '').toLowerCase() !== 'true'
  if (enforceMissionGateAtBoot) {
    try {
      const quarantine = await quarantineUnverifiedDirectOpportunities(db)
      if (quarantine?.ok) {
        console.info('[link-verify] startup quarantine complete', quarantine)
      } else {
        console.warn('[link-verify] startup quarantine failed closed', {
          reason: quarantine?.reason || 'unknown',
        })
      }
    } catch (quarantineErr) {
      console.warn('[link-verify] startup quarantine threw (readiness remains closed):', quarantineErr?.message || quarantineErr)
    }
  }

`,
  'pre-listen startup quarantine wiring',
)

// Functional regression coverage: the startup helper performs no network I/O,
// preserves resources, hard-deactivates broken direct rows, and restores proven
// rows that were hidden by an interrupted prior cycle.
replaceOne(
  'backend/tests/linkVerificationQuarantine.test.js',
  /import \{ runLinkVerification \} from '\.\.\/services\/linkVerificationService\.js'/,
  `import {
  quarantineUnverifiedDirectOpportunities,
  runLinkVerification,
} from '../services/linkVerificationService.js'`,
  'link quarantine test import',
)

const quarantineTestFile = 'backend/tests/linkVerificationQuarantine.test.js'
const quarantineTest = read(quarantineTestFile)
if (!quarantineTest.includes("describe('startup SQL-only link quarantine'")) {
  write(quarantineTestFile, `${quarantineTest}

describe('startup SQL-only link quarantine', () => {
  it('fails closed without fetching, preserves resources, and restores proven rows', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      insertOpportunity(db, { id: 'unverified-direct', url: 'https://8.8.8.8/unverified' })
      insertOpportunity(db, { id: 'broken-direct', url: 'https://8.8.8.8/broken', status: 'broken' })
      insertOpportunity(db, { id: 'directory-resource', kind: 'directory', status: 'unverified' })
      insertOpportunity(db, { id: 'proven-hidden', url: 'https://8.8.8.8/proven', status: 'ok', hidden: 1 })
      db.prepare('UPDATE funding_opportunities SET last_verified_at = ? WHERE id = ?')
        .run('2026-07-29T12:00:00.000Z', 'proven-hidden')

      const stats = await quarantineUnverifiedDirectOpportunities(db)

      expect(stats).toMatchObject({ ok: true, quarantined: 2, deactivated: 1, restored: 1 })
      expect(fetchSpy).not.toHaveBeenCalled()

      expect(readRow(db, 'unverified-direct')).toMatchObject({ is_hidden: 1, is_active: 1 })
      expect(readRow(db, 'broken-direct')).toMatchObject({ is_hidden: 1, is_active: 0 })
      expect(readRow(db, 'directory-resource')).toMatchObject({ is_hidden: 0, is_active: 1 })
      expect(readRow(db, 'proven-hidden')).toMatchObject({ is_hidden: 0, is_active: 1, link_status: 'ok' })
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })
})
`)
}

const persistence = read(persistenceFile)
const resourcePreservationInstalled =
  (
    persistence.includes('const deleteStaleDirectMatches = db.prepare') &&
    persistence.includes('const deleteExplicitReject = db.prepare')
  ) || (
    persistence.includes('async function snapshotResourceMatches') &&
    persistence.includes('async function restoreResourceMatches') &&
    persistence.includes('resourcesPreserved')
  )
if (!resourcePreservationInstalled) {
  throw new Error('resource-preserving reconciliation was not installed')
}

const verification = read(verificationFile)
if (!verification.includes('export async function quarantineUnverifiedDirectOpportunities')) {
  throw new Error('SQL-only direct catalog quarantine helper was not installed')
}
if (!verification.includes("COALESCE(link_status, 'unverified') IN ('unverified', 'unknown', 'broken')")) {
  throw new Error('unverified-direct quarantine was not installed')
}
if (!verification.includes("result.status === 'ok' || result.status === 'redirect'")) {
  throw new Error('verified-row reveal was not installed')
}

const server = read('backend/server.js')
const startupQuarantine = server.indexOf('await quarantineUnverifiedDirectOpportunities(db)')
const listen = server.indexOf("app.listen(PORT, '0.0.0.0')")
if (startupQuarantine < 0 || listen < 0 || startupQuarantine > listen) {
  throw new Error('startup catalog quarantine must be awaited before app.listen')
}

console.log('[global-hardening] resource reconciliation and verification quarantine transformations applied')
