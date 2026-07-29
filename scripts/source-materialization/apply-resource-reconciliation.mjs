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

replaceOne(
  'backend/services/crawlerOsPersistence.js',
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

replaceOne(
  'backend/services/linkVerificationService.js',
  /    expired: 0,\n  \}/,
  `    expired: 0,
    quarantined: 0,
    restored: 0,
  }`,
  'link verification quarantine counters',
)

replaceOne(
  'backend/services/linkVerificationService.js',
  /  const isPostgres = db\?\.dialect === 'postgres'\n  const falseVal = isPostgres \? false : 0/,
  `  const isPostgres = db?.dialect === 'postgres'
  const falseVal = isPostgres ? false : 0
  const trueVal = isPostgres ? true : 1

  // Fail closed at the catalog boundary. Direct opportunities are hidden until
  // a target URL has actually been proven reachable. Directories and referrals
  // remain visible because they are navigation resources rather than promises of
  // an application-ready award. The recurring verifier can still select hidden
  // rows, and a successful probe reveals them again below.
  try {
    const quarantined = await db
      .prepare(\`
        UPDATE funding_opportunities
           SET is_hidden = ?
         WHERE LOWER(COALESCE(opportunity_kind, 'direct')) IN ('direct', 'benefit')
           AND COALESCE(is_hidden, ?) = ?
           AND COALESCE(link_status, 'unverified') IN ('unverified', 'unknown', 'broken')
      \`)
      .run(trueVal, falseVal, falseVal)
    stats.quarantined = Number(quarantined?.changes ?? quarantined?.rowCount ?? 0)
  } catch (err) {
    // Older/minimal schemas can lack is_hidden/opportunity_kind. Verification
    // itself remains available; production schemas carry both columns.
    console.warn('[link-verify] quarantine pass failed:', err?.message)
  }

  const revealVerified = db.prepare(\`
    UPDATE funding_opportunities
       SET is_hidden = ?
     WHERE id = ?
  \`)`,
  'link verification quarantine setup',
)

replaceOne(
  'backend/services/linkVerificationService.js',
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

const persistence = read('backend/services/crawlerOsPersistence.js')
if (!persistence.includes('const deleteStaleDirectMatches = db.prepare')) {
  throw new Error('resource-preserving reconciliation was not installed')
}
if (!persistence.includes('const deleteExplicitReject = db.prepare')) {
  throw new Error('explicit resource reject cleanup was not installed')
}

const verification = read('backend/services/linkVerificationService.js')
if (!verification.includes("COALESCE(link_status, 'unverified') IN ('unverified', 'unknown', 'broken')")) {
  throw new Error('unverified-direct quarantine was not installed')
}
if (!verification.includes("result.status === 'ok' || result.status === 'redirect'")) {
  throw new Error('verified-row reveal was not installed')
}

console.log('[global-hardening] resource reconciliation and verification quarantine transformations applied')
