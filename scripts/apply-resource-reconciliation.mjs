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

const transformed = read('backend/services/crawlerOsPersistence.js')
if (!transformed.includes('const deleteStaleDirectMatches = db.prepare')) {
  throw new Error('resource-preserving reconciliation was not installed')
}
if (!transformed.includes('const deleteExplicitReject = db.prepare')) {
  throw new Error('explicit resource reject cleanup was not installed')
}

console.log('[global-hardening] resource reconciliation transformation applied')
