import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(path, 'utf8')
}

function write(path, value) {
  fs.writeFileSync(path, value)
  console.log(`[patch] wrote ${path}`)
}

function replaceExact(text, search, replacement, label) {
  const first = text.indexOf(search)
  if (first < 0) throw new Error(`missing exact patch target: ${label}`)
  if (text.indexOf(search, first + search.length) >= 0) {
    throw new Error(`ambiguous exact patch target: ${label}`)
  }
  return text.slice(0, first) + replacement + text.slice(first + search.length)
}

function replaceRegex(text, regex, replacement, label) {
  const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))]
  if (matches.length !== 1) throw new Error(`expected one regex patch target for ${label}, found ${matches.length}`)
  return text.replace(regex, replacement)
}

function patchRobertAudit() {
  const path = 'backend/services/robert/robertPipelineAudit.js'
  let text = read(path)
  text = replaceExact(
    text,
    `  const funderLeadExclusion = grantCols.has('pipeline_category')\n    ? \`\\n    AND (g.pipeline_category IS NULL OR LOWER(g.pipeline_category) <> 'funder_lead')\`\n    : ''\n`,
    `  // Legacy funder-lead rows are part of the live profile pipeline and must\n  // pass the same four positive gates. New funder research remains catalog-only,\n  // but old rows cannot be exempted from reconciliation indefinitely.\n`,
    'remove funder-lead audit exemption',
  )
  text = replaceExact(
    text,
    `  WHERE g.profile_id = ?\${funderLeadExclusion}\n`,
    `  WHERE g.profile_id = ?\n`,
    'include funder leads in pipeline row query',
  )
  text = replaceExact(
    text,
    `  if (applicantEval.decision === 'mismatch') {\n`,
    `  const positiveApplicantProof =\n    applicantEval.decision === 'pass' && applicantEval.reason === 'explicit_applicant_types_match'\n  if (!positiveApplicantProof) {\n`,
    'require positive applicant proof',
  )
  text = replaceExact(
    text,
    `      evidence: { gate: 'applicant_type', detail: applicantEval.reason, bucket: applicantEval.matched_bucket ?? null },\n`,
    `      evidence: {\n        gate: 'applicant_type',\n        detail: applicantEval.reason || 'applicant_type_not_positively_verified',\n        decision: applicantEval.decision || 'unknown',\n        bucket: applicantEval.matched_bucket ?? null,\n      },\n`,
    'report applicant proof failure',
  )
  write(path, text)
}

function patchHamiltonPolicy() {
  const path = 'backend/services/hamilton/hamiltonFundingSourcePolicy.js'
  let text = read(path)
  text = replaceExact(
    text,
    `const ALLOWED_MATCH_DECISIONS = new Set(['accept', 'review'])\n`,
    `const ALLOWED_MATCH_DECISIONS = new Set(['accept'])\n`,
    'Hamilton accepts only canonical ACCEPT',
  )
  text = replaceExact(
    text,
    `  if (!match && profileId && opportunityId && requiresProfileMatch(subject)) {\n`,
    `  if (!match && profileId) {\n`,
    'live decision required for every source without persisted truth',
  )
  text = replaceExact(
    text,
    `    if (liveDecision === 'accept' || liveDecision === 'review') {\n`,
    `    if (liveDecision === 'accept') {\n`,
    'live REVIEW cannot authorize Hamilton',
  )
  text = replaceRegex(
    text,
    /  const applicantVerdict = await assessApplicantTypeForPolicy\(db, profileId, subject\)\n  if \(applicantVerdict\?\.decision === 'mismatch'\) \{[\s\S]*?\n  \}\n\n  return \{\n    ok: true,/,
    `  const applicantVerdict = await assessApplicantTypeForPolicy(db, profileId, subject)\n  const positiveApplicantProof =\n    applicantVerdict?.decision === 'pass'\n    && applicantVerdict?.reason === 'explicit_applicant_types_match'\n  if (!positiveApplicantProof) {\n    const hardMismatch = applicantVerdict?.decision === 'mismatch'\n    const reasons = [\n      hardMismatch ? 'profile_match_rejected' : 'profile_match_not_accepted',\n      \`applicant_type:\${applicantVerdict?.reason || 'not_positively_verified'}\`,\n    ]\n    return {\n      ok: false,\n      code: hardMismatch\n        ? 'funding_source_profile_rejected'\n        : 'funding_source_profile_not_accepted',\n      reasons,\n      trust,\n      match,\n      applicant_type: applicantVerdict ?? { decision: 'review', reason: 'unavailable' },\n      message: buildPolicyMessage(reasons),\n    }\n  }\n\n  return {\n    ok: true,`,
    'Hamilton requires positive applicant-type evidence',
  )
  write(path, text)
}

function patchHamiltonOrchestrator() {
  const path = 'backend/services/hamilton/hamiltonAutomationOrchestrator.js'
  let text = read(path)
  text = replaceRegex(
    text,
    /const SKIP_CLOSEABLE_STATUSES = Object\.freeze\(\[[\s\S]*?\n\]\)\n/,
    `const REFUSAL_PROTECTED_TASK_STATUSES = Object.freeze([\n  'submitted', 'completed', 'complete', 'done',\n  'cancelled', 'canceled', 'archived', 'rejected', 'closed',\n  // Never erase an uncertain external-submission boundary. These remain visible\n  // for confirmation, but no new automation may be created for the source.\n  'submit_attempt_started', 'submit_evidence_pending', 'submission_verification_required',\n])\n`,
    'replace idle-only refusal closure status set',
  )
  text = replaceExact(
    text,
    `    const placeholders = SKIP_CLOSEABLE_STATUSES.map(() => '?').join(', ')\n`,
    `    const placeholders = REFUSAL_PROTECTED_TASK_STATUSES.map(() => '?').join(', ')\n`,
    'refusal protected placeholders',
  )
  text = replaceExact(
    text,
    `            AND status IN (\${placeholders})`,
    `            AND (status IS NULL OR status NOT IN (\${placeholders}))`,
    'close every nonterminal refused task',
  )
  text = replaceExact(
    text,
    `        ...SKIP_CLOSEABLE_STATUSES,\n`,
    `        ...REFUSAL_PROTECTED_TASK_STATUSES,\n`,
    'bind refusal protected statuses',
  )
  text = replaceRegex(
    text,
    /  if \(eligibility\?\.code === 'funding_source_profile_rejected'\) \{[\s\S]*?\n  const classification = classifyFundingSource\(\{/,
    `  if (eligibility?.ok === false || (eligibility?.code && eligibility?.ok !== true)) {\n    const pointerLead = eligibility?.code === 'pointer_research_lead'\n    const profileRejected = eligibility?.code === 'funding_source_profile_rejected'\n    const reason = pointerLead\n      ? 'pointer_research_lead'\n      : profileRejected\n        ? 'ineligible_profile'\n        : (eligibility?.code || 'funding_source_disallowed')\n    const message = eligibility?.message\n      || (pointerLead\n        ? 'This source is a research lead, not an application. Hamilton closed the task.'\n        : 'This source does not have the positive GrantFlow evidence required for Hamilton automation. Hamilton closed the task.')\n    const closedTasks = await closeExistingTasksForRefusedSource(db, {\n      profileId: resolvedProfileId,\n      opportunityId,\n      grantId,\n      reason,\n      message,\n    })\n    return {\n      task: null,\n      skipped: true,\n      reason,\n      closed_tasks: closedTasks,\n      ...(eligibility?.handoff ? { manual_handoff: eligibility.handoff } : {}),\n      policy: {\n        code: eligibility?.code || 'funding_source_disallowed',\n        reasons: eligibility?.reasons || [],\n        message,\n        ...(eligibility?.handoff ? { handoff: eligibility.handoff } : {}),\n      },\n    }\n  }\n\n  const classification = classifyFundingSource({`,
    'generic fail-closed Hamilton policy refusal',
  )
  write(path, text)
}

function patchPipelineInvariant() {
  const path = 'backend/startup/enforceInvariants.js'
  let text = read(path)
  text = replaceExact(
    text,
    `  'cancelled', 'canceled', 'archived', 'rejected', 'closed',\n])\n`,
    `  'cancelled', 'canceled', 'archived', 'rejected', 'closed',\n  'submit_attempt_started', 'submit_evidence_pending', 'submission_verification_required',\n])\n`,
    'preserve uncertain submission boundaries',
  )
  text = replaceExact(
    text,
    `    const { loadProfileFacts, loadPipelineRows, gateRelatable, gateQualifies, gateCoversNeed, gateRealOffline, GATES } = audit\n`,
    `    const {\n      loadProfileFacts, loadPipelineRows, gateRelatable, gateQualifies,\n      gateCoversNeed, gateRealOffline, GATES, PROTECTED_GRANT_STATUSES,\n    } = audit\n`,
    'use narrow protected pipeline statuses',
  )
  text = replaceExact(
    text,
    `    let cancelApplicationTask = null\n`,
    `    let cancelApplicationTask = null\n    let updateApplicationTask = null\n`,
    'declare task intent updater',
  )
  text = replaceExact(
    text,
    `    try { ({ cancelApplicationTask } = await import('../services/hamilton/applicationTaskStore.js')) } catch { cancelApplicationTask = null }\n`,
    `    try {\n      ({ cancelApplicationTask, updateApplicationTask } = await import('../services/hamilton/applicationTaskStore.js'))\n    } catch {\n      cancelApplicationTask = null\n      updateApplicationTask = null\n    }\n`,
    'load task cancellation and intent update tools',
  )
  text = replaceExact(
    text,
    `    const limit = _boundedLimit('PIPELINE_PRECISION_LIMIT', 2000)\n`,
    `    const limit = _boundedLimit('PIPELINE_PRECISION_LIMIT', 100000)\n`,
    'complete fleet cleanup in one boot',
  )
  text = replaceExact(
    text,
    `    const hasIneligReasons = grantCols.has('ineligibility_reasons')\n`,
    `    const hasIneligReasons = grantCols.has('ineligibility_reasons')\n    const hasMatchDecision = grantCols.has('match_decision')\n`,
    'detect match decision column',
  )
  text = replaceExact(
    text,
    `      scanned: 0, kept: 0, removed: 0, relabeled: 0, failed: 0, tasksCancelled: 0,\n`,
    `      scanned: 0, kept: 0, removed: 0, relabeled: 0, failed: 0,\n      tasksCancelled: 0, matchesRemoved: 0,\n`,
    'count task and match cleanup',
  )
  text = replaceRegex(
    text,
    /    const isProtectedRow = \(row, awarded\) => \{[\s\S]*?\n    \}\n\n    for \(const profileId of profileIds\) \{/,
    `    const isProtectedRow = (row, awarded) => {\n      const status = row.grant_status === null || row.grant_status === undefined\n        ? null\n        : String(row.grant_status).toLowerCase()\n      if (status && PROTECTED_GRANT_STATUSES.has(status)) return true\n      if ((awarded.get(String(row.grant_id)) || 0) > 0) return true\n      return false\n    }\n\n    const cancelTasksForFailedPair = async (profileId, row, reason) => {\n      if (!hasTasks || !cancelApplicationTask) return 0\n      let taskRows = []\n      try {\n        const ph = TERMINAL_TASK_STATUSES.map(() => '?').join(', ')\n        taskRows = await db.prepare(\n          \`SELECT id FROM application_tasks\n            WHERE profile_id = ?\n              AND ((grant_id IS NOT NULL AND grant_id = ?)\n                OR (opportunity_id IS NOT NULL AND opportunity_id = ?))\n              AND (status IS NULL OR LOWER(status) NOT IN (\${ph}))\`,\n        ).all(\n          profileId,\n          row.grant_id ? String(row.grant_id) : null,\n          row.funding_opportunity_id ? String(row.funding_opportunity_id) : null,\n          ...TERMINAL_TASK_STATUSES,\n        )\n      } catch { taskRows = [] }\n      let cancelled = 0\n      for (const task of taskRows || []) {\n        try {\n          if (updateApplicationTask) {\n            await updateApplicationTask(db, task.id, { allowAutoSubmit: false, autoSubmitEnabled: false })\n          }\n        } catch { /* denial is still enforced by cancellation below */ }\n        try {\n          await cancelApplicationTask(db, task.id, { actorRole: 'system', reason })\n          cancelled += 1\n        } catch (err) {\n          log.warn('pipeline_precision: task cancel failed (non-fatal)', { task: task.id, error: String(err?.message || err) })\n        }\n      }\n      return cancelled\n    }\n\n    const removePersistedMatchForFailedPair = async (profileId, row) => {\n      if (!row.funding_opportunity_id) return 0\n      try {\n        const result = await db.prepare(\n          'DELETE FROM profile_opportunity_matches WHERE profile_id = ? AND opportunity_id = ?',\n        ).run(profileId, row.funding_opportunity_id)\n        return changesOf(result)\n      } catch { return 0 }\n    }\n\n    for (const profileId of profileIds) {`,
    'narrow protected rows and add pair cleanup helpers',
  )
  text = replaceExact(
    text,
    `          if (!failedGate) {\n            verdict = gateCoversNeed(row, facts)\n            if (!verdict.pass) failedGate = GATES.COVERS_NEED\n            else if (profileDeclaresNoNeeds) counts.needNeutralProfile += 1\n            else if (verdict?.evidence?.detail === 'opportunity_states_no_need_vocabulary') counts.needNeutralRow += 1\n          }\n`,
    `          if (!failedGate) {\n            verdict = gateCoversNeed(row, facts)\n            if (profileDeclaresNoNeeds) counts.needNeutralProfile += 1\n            else if (verdict?.evidence?.detail === 'opportunity_states_no_need_vocabulary') counts.needNeutralRow += 1\n            if (!verdict.pass) failedGate = GATES.COVERS_NEED\n          }\n`,
    'count strict need-evidence failures',
  )
  text = replaceExact(
    text,
    `        if (isProtectedRow(row, awarded)) {\n`,
    `        const cleanupReason = \`Pipeline precision — \${reasonKey}\`\n        counts.tasksCancelled += await cancelTasksForFailedPair(profileId, row, cleanupReason)\n        counts.matchesRemoved += await removePersistedMatchForFailedPair(profileId, row)\n\n        if (isProtectedRow(row, awarded)) {\n`,
    'clean tasks and matches before grant retention decision',
  )
  text = replaceRegex(
    text,
    /        if \(isProtectedRow\(row, awarded\)\) \{[\s\S]*?\n          continue\n        \}\n\n        \/\/ Early\/discovery row: cancel open tasks, tombstone, delete\./,
    `        if (isProtectedRow(row, awarded)) {\n          try {\n            let existing = []\n            if (hasIneligReasons) {\n              try {\n                const cur = await db.prepare('SELECT ineligibility_reasons FROM grants WHERE id = ?').get(row.grant_id)\n                const raw = cur?.ineligibility_reasons\n                existing = typeof raw === 'string' ? JSON.parse(raw || '[]') : (Array.isArray(raw) ? raw : [])\n              } catch { existing = [] }\n              if (!Array.isArray(existing)) existing = []\n              const tag = \`pipeline_precision:\${reasonKey}\${detail ? \`:\${detail}\` : ''}\`\n              if (!existing.includes(tag)) existing.push(tag)\n            }\n            const sets = []\n            const params = []\n            if (hasEligStatus) { sets.push('eligibility_status = ?'); params.push('ineligible') }\n            if (hasIneligReasons) { sets.push('ineligibility_reasons = ?'); params.push(JSON.stringify(existing)) }\n            if (hasMatchDecision) { sets.push('match_decision = ?'); params.push('REJECT') }\n            if (sets.length === 0) {\n              throw new Error('protected row cannot be marked ineligible/rejected on this schema')\n            }\n            params.push(row.grant_id)\n            await db.prepare(\`UPDATE grants SET \${sets.join(', ')} WHERE id = ?\`).run(...params)\n            writes += 1\n            counts.relabeled += 1\n            byGate[failedGate] = (byGate[failedGate] || 0) + 1\n            byReason[reasonKey] = (byReason[reasonKey] || 0) + 1\n            affectedProfiles.add(profileId)\n          } catch (err) {\n            counts.failed += 1\n            log.warn('pipeline_precision: re-label failed (non-fatal)', { grant: row.grant_id, error: String(err?.message || err) })\n          }\n          continue\n        }\n\n        // Early/discovery row: its tasks and persisted match were already closed above;\n        // now tombstone and delete the invalid grant so it cannot reappear.`,
    'cancel protected-row tasks and mark canonical reject',
  )
  text = replaceRegex(
    text,
    /          if \(hasTasks && cancelApplicationTask\) \{[\s\S]*?\n          \}\n          if \(recordDismissalFn\) \{/,
    `          if (recordDismissalFn) {`,
    'remove duplicate early-task cancellation block',
  )
  text = replaceExact(
    text,
    `    return {\n      ...counts,\n      repaired: counts.removed + counts.relabeled,\n`,
    `    try {\n      const summary = JSON.stringify({\n        timestamp: new Date().toISOString(),\n        scanned: counts.scanned, removed: counts.removed, relabeled: counts.relabeled,\n        tasksCancelled: counts.tasksCancelled, matchesRemoved: counts.matchesRemoved,\n        failed: counts.failed, truncated: counts.truncated,\n        profiles: profileIds.length, profilesAffected: affectedProfiles.size,\n        byGate, byReason,\n      })\n      const updated = await db.prepare(\n        'UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?',\n      ).run(summary, new Date().toISOString(), 'pipeline_precision_last_run')\n      if (!changesOf(updated)) {\n        await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')\n          .run('pipeline_precision_last_run', summary, new Date().toISOString())\n      }\n    } catch (err) {\n      log.warn('pipeline_precision: last-run summary persist failed (non-fatal)', { error: String(err?.message || err) })\n    }\n\n    return {\n      ...counts,\n      repaired: counts.removed + counts.relabeled,\n`,
    'persist sanitized production cleanup summary',
  )
  write(path, text)
}

function patchPipelinePrecisionTests() {
  const path = 'backend/tests/pipelinePrecisionSweep.test.js'
  let text = read(path)
  text = replaceExact(
    text,
    `  // A row that states NO need vocabulary is silent, not contrary → KEEP (counted needNeutralRow).\n  { id: 'silent', t: 'Murfreesboro Community Scholarship', s: 'Rutherford County Foundation', ent: ['student'], cats: [], url: 'https://example-rcf.org/apply', keep: true, silent: true },\n`,
    `  // A row that states NO need vocabulary cannot prove it covers a declared need.\n  { id: 'silent', t: 'Murfreesboro Community Scholarship', s: 'Rutherford County Foundation', ent: ['student'], cats: [], url: 'https://example-rcf.org/apply', remove: 'covers_need', silent: true },\n`,
    'strict silent opportunity fixture',
  )
  text = replaceExact(text, `    expect(result.byGate).toEqual({ relatable: 1, qualifies: 2, covers_need: 1, real: 1 })\n`, `    expect(result.byGate).toEqual({ relatable: 1, qualifies: 2, covers_need: 2, real: 1 })\n`, 'strict per-gate count')
  text = replaceExact(text, `    expect(result.removed).toBe(4)\n    expect(result.kept).toBe(2)\n`, `    expect(result.removed).toBe(5)\n    expect(result.kept).toBe(1)\n`, 'strict removed and kept count')
  text = replaceExact(text, `    expect(tombstones.length).toBe(4)\n`, `    expect(tombstones.length).toBe(5)\n`, 'strict tombstone count')
  text = replaceExact(text, `    expect(again.scanned).toBe(3) // pell + silent + the re-labeled HUD row\n`, `    expect(again.scanned).toBe(2) // pell + the re-labeled HUD history row\n`, 'strict idempotent scan count')
  text = replaceRegex(
    text,
    /describe\('enforcePipelinePrecision — silence is neutral and REPORTED',[\s\S]*?\n\}\)\n\ndescribe\('pipelinePrecision — the shared declared-need predicate'/,
    `describe('enforcePipelinePrecision — silence fails closed for automated pipeline rows', () => {\n  it('a profile that declares NO needs cannot positively prove need coverage', async () => {\n    const { sqlite, db } = seed(ROWS.filter((r) => r.id === 'legal' || r.id === 'pell'), { declareNeeds: false })\n    const res = await enforcePipelinePrecision(db)\n    expect(res.ok).toBe(true)\n    expect(res.byGate.covers_need).toBe(2)\n    expect(res.needNeutralProfile).toBe(2)\n    expect(grantIds(sqlite)).toEqual([])\n  })\n\n  it('skips LOUDLY (not green) when the catalog lacks the gate-evidence columns', async () => {\n    const raw = new Database(':memory:')\n    raw.dialect = 'sqlite'\n    raw.exec(\`\n      CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, status TEXT);\n      CREATE TABLE profiles (id TEXT PRIMARY KEY);\n      CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT);\n    \`)\n    const res = await enforcePipelinePrecision(wrapSqlite(raw))\n    expect(res.ok).toBe(true)\n    expect(res.skipped).toBe('schema')\n    expect(res.missingColumns).toContain('entity_types_allowed')\n    expect(res.repaired).toBe(0)\n  })\n})\n\ndescribe('pipelinePrecision — the shared declared-need predicate'`,
    'replace fail-open silence test block',
  )
  text = replaceExact(
    text,
    `  it('is neutral — and SAYS so — when either side is silent', () => {\n    const noProfile = evaluateDeclaredNeedCoverage({ categories: ['legal'] }, [])\n    expect(noProfile.pass).toBe(true)\n    expect(noProfile.detail).toBe(NEED_COVERAGE_DETAIL.PROFILE_DECLARES_NO_NEEDS)\n    const noRow = evaluateDeclaredNeedCoverage({ categories: [] }, ['education'])\n    expect(noRow.pass).toBe(true)\n    expect(noRow.detail).toBe(NEED_COVERAGE_DETAIL.OPPORTUNITY_STATES_NO_NEEDS)\n  })\n`,
    `  it('fails closed — and SAYS why — when either side is silent', () => {\n    const noProfile = evaluateDeclaredNeedCoverage({ categories: ['legal'] }, [])\n    expect(noProfile.pass).toBe(false)\n    expect(noProfile.detail).toBe(NEED_COVERAGE_DETAIL.PROFILE_DECLARES_NO_NEEDS)\n    const noRow = evaluateDeclaredNeedCoverage({ categories: [] }, ['education'])\n    expect(noRow.pass).toBe(false)\n    expect(noRow.detail).toBe(NEED_COVERAGE_DETAIL.OPPORTUNITY_STATES_NO_NEEDS)\n  })\n`,
    'strict shared silence predicate expectations',
  )
  write(path, text)
}

function patchHamiltonTests() {
  const creationPath = 'backend/tests/hamiltonTaskCreationGate.test.js'
  let creation = read(creationPath)
  creation = replaceExact(
    creation,
    `      display_name TEXT\n`,
    `      display_name TEXT,\n      primary_type TEXT\n`,
    'task creation profile type column',
  )
  creation = replaceExact(
    creation,
    `      evidence_url TEXT\n`,
    `      evidence_url TEXT,\n      entity_types_allowed TEXT\n`,
    'task creation opportunity applicant types',
  )
  creation = replaceExact(
    creation,
    `  await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')\n    .run(PROFILE, 'user-1', 'Robert Michael White')\n`,
    `  await db.prepare('INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES (?, ?, ?, ?)')\n    .run(PROFILE, 'user-1', 'Robert Michael White', 'college_student')\n`,
    'seed positive profile type',
  )
  creation = replaceExact(
    creation,
    `  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url) VALUES (?, ?, ?, ?)')\n    .run('opp-restricted', 'UNCF Scholarship', 'Apply through the portal.', 'https://portal.uncf-fixture.org/apply')\n`,
    `  await db.prepare('INSERT INTO funding_opportunities (id, title, description, application_url, entity_types_allowed) VALUES (?, ?, ?, ?, ?)')\n    .run('opp-restricted', 'UNCF Scholarship', 'Apply through the portal.', 'https://portal.uncf-fixture.org/apply', JSON.stringify(['student', 'individual']))\n`,
    'seed positive opportunity applicant type',
  )
  creation = replaceRegex(
    creation,
    /  it\('still ADMITS a REVIEW verdict[\s\S]*?\n  \}\)\n\n  it\('still ADMITS a source with NO stored verdict at all'[\s\S]*?\n  \}\)/,
    `  it('REFUSES a REVIEW verdict because uncertainty is not qualification', async () => {\n    await storeDecision(db, 'review')\n    const r = await automateSingleSource(db, {\n      profileId: PROFILE,\n      source: { grant_id: 'g-restricted' },\n    })\n    expect(r.skipped).toBe(true)\n    expect(r.reason).toBe('funding_source_profile_not_accepted')\n    expect(r.task).toBeNull()\n    expect(await taskCount(db)).toBe(0)\n  })\n\n  it('REFUSES a source with no stored or live ACCEPT', async () => {\n    const r = await automateSingleSource(db, {\n      profileId: PROFILE,\n      source: { grant_id: 'g-restricted' },\n    })\n    expect(r.skipped).toBe(true)\n    expect(r.task).toBeNull()\n    expect(await taskCount(db)).toBe(0)\n  })\n\n  it('ADMITS a stored ACCEPT only when applicant type is positively supported', async () => {\n    await storeDecision(db, 'accept')\n    const r = await automateSingleSource(db, {\n      profileId: PROFILE,\n      source: { grant_id: 'g-restricted' },\n    })\n    expect(r.skipped).not.toBe(true)\n    expect(r.task?.id).toBeTruthy()\n    expect(await taskCount(db)).toBe(1)\n  })`,
    'Hamilton REVIEW and missing verdict tests',
  )
  write(creationPath, creation)

  const closePath = 'backend/tests/hamiltonSkipClosesExistingTask.test.js'
  let close = read(closePath)
  close = replaceExact(
    close,
    `  it('does NOT close drafted human-facing work (waiting_for_review) — reports the skip only', async () => {\n`,
    `  it('closes drafted waiting_for_review work when the source fails policy', async () => {\n`,
    'close rejected drafted work test title',
  )
  close = replaceExact(
    close,
    `    expect(result.closed_tasks).toEqual([])\n    const after = await getApplicationTask(db, task.id)\n    expect(after.status).toBe('waiting_for_review')\n`,
    `    expect(result.closed_tasks).toEqual([task.id])\n    const after = await getApplicationTask(db, task.id)\n    expect(after.status).toBe('cancelled')\n`,
    'close rejected waiting_for_review task',
  )
  close = replaceExact(
    close,
    `  it('unresolvable-source close does NOT touch drafted human-facing work (waiting_for_review)', async () => {\n`,
    `  it('unresolvable-source close cancels drafted waiting_for_review work', async () => {\n`,
    'close dangling drafted work test title',
  )
  close = replaceExact(
    close,
    `    expect(thrown?.closed_tasks).toEqual([])\n    const after = await getApplicationTask(db, task.id)\n    expect(after.status).toBe('waiting_for_review')\n`,
    `    expect(thrown?.closed_tasks).toEqual([task.id])\n    const after = await getApplicationTask(db, task.id)\n    expect(after.status).toBe('cancelled')\n`,
    'close dangling waiting_for_review task',
  )
  write(closePath, close)
}

function writeIntegrationTest() {
  const path = 'backend/tests/pipelinePrecisionTaskReconciliation.test.js'
  const content = `import { describe, it, expect } from 'vitest'\nimport Database from 'better-sqlite3'\n\nprocess.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'd'.repeat(64)\n\nconst { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')\nconst { enforcePipelinePrecision } = await import('../startup/enforceInvariants.js')\nconst {\n  ensureApplicationTask, updateApplicationTask, getApplicationTask, _resetSchemaCache,\n} = await import('../services/hamilton/applicationTaskStore.js')\n\nconst PROFILE = 'live-task-reconciliation-profile'\n\nfunction makeDb() {\n  const sqlite = new Database(':memory:')\n  sqlite.dialect = 'sqlite'\n  sqlite.exec(\`\n    CREATE TABLE profiles (\n      id TEXT PRIMARY KEY, display_name TEXT, applicant_type TEXT, primary_type TEXT,\n      status TEXT, tags TEXT, deleted_at DATETIME\n    );\n    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);\n    CREATE TABLE funding_opportunities (\n      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,\n      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,\n      need_types_supported TEXT, categories TEXT, keywords TEXT,\n      opportunity_kind TEXT, opportunity_type TEXT, funding_category TEXT,\n      source TEXT, record_origin TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,\n      final_url TEXT, evidence_url TEXT, external_id TEXT, state TEXT,\n      is_national INTEGER, deadline TEXT, deadline_type TEXT,\n      amount_min REAL, amount_max REAL, amount_text TEXT, is_active INTEGER,\n      link_status TEXT, canonical_opportunity_key TEXT\n    );\n    CREATE TABLE grants (\n      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,\n      funder TEXT, status TEXT, deadline TEXT, application_url TEXT, url TEXT,\n      amount_requested REAL, amount_awarded REAL, match_score REAL, match_decision TEXT,\n      eligibility_status TEXT, ineligibility_reasons TEXT, matcher_version TEXT,\n      pipeline_category TEXT, fingerprint TEXT, updated_at DATETIME\n    );\n    CREATE TABLE profile_opportunity_matches (\n      profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT,\n      match_explanation TEXT, matcher_version TEXT, updated_at DATETIME, computed_at DATETIME\n    );\n    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);\n  \`)\n  const db = wrapSqlite(sqlite)\n  _resetSchemaCache()\n  return { sqlite, db }\n}\n\nasync function seed() {\n  const { sqlite, db } = makeDb()\n  sqlite.prepare('INSERT INTO profiles (id, display_name, primary_type, status, tags) VALUES (?, ?, ?, ?, ?)')\n    .run(PROFILE, 'Live Reconciliation Student', 'college_student', 'active', '[]')\n  sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')\n    .run(PROFILE, 'basic_information', JSON.stringify({ state: 'TN', profile_category: 'college_student' }))\n  sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')\n    .run(PROFILE, 'financial_information', JSON.stringify({ needs: ['education', 'housing'] }))\n\n  const opportunities = [\n    ['good', 'Tennessee Direct Student Scholarship', 'TN Student Foundation', ['student'], ['education'], 'direct', 'TN'],\n    ['saved', 'NSF Institutional Infrastructure Grant', 'U.S. National Science Foundation', ['nonprofit', 'school'], ['education'], 'direct', null],\n    ['interested', 'Alaska Emergency Rental Assistance Program', 'Alaska Housing Finance Corporation', ['individual', 'family'], ['housing'], 'direct', 'AK'],\n    ['portal', 'Middle Tennessee State University Institutional Research Portal', 'Middle Tennessee State University', ['school', 'university'], ['education'], 'direct', 'TN'],\n    ['submitted', 'HUD Institutional Grant Programs', 'HUD', ['government', 'nonprofit'], ['housing'], 'direct', null],\n  ]\n  const fo = sqlite.prepare(\`INSERT INTO funding_opportunities\n    (id, title, sponsor, description, entity_types_allowed, need_types_supported, categories,\n     opportunity_kind, source, record_origin, source_url, application_url, state, is_active, link_status)\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test_lane', 'live_crawl', ?, ?, ?, 1, 'ok')\`)
  const g = sqlite.prepare(\`INSERT INTO grants\n    (id, profile_id, funding_opportunity_id, title, funder, status, application_url, url,\n     match_score, match_decision, eligibility_status, ineligibility_reasons, matcher_version, updated_at)\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 90, 'ACCEPT', 'eligible', '[]', 'crawler-os', CURRENT_TIMESTAMP)\`)
  const m = sqlite.prepare(\`INSERT INTO profile_opportunity_matches\n    (profile_id, opportunity_id, match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at)\n    VALUES (?, ?, 90, 'accept', 'fixture', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)\`)
\n  const grantStatuses = { good: 'saved', saved: 'saved', interested: 'interested', portal: 'portal', submitted: 'submitted' }\n  for (const [id, title, sponsor, entities, needs, kind, state] of opportunities) {\n    const url = \`https://example.org/\${id}/apply\`\n    fo.run(\`fo-\${id}\`, title, sponsor, 'Apply through the official program.', JSON.stringify(entities), JSON.stringify(needs), JSON.stringify(needs), kind, url, url, state)\n    g.run(\`g-\${id}\`, PROFILE, \`fo-\${id}\`, title, sponsor, grantStatuses[id], url, url)\n    m.run(PROFILE, \`fo-\${id}\`)\n    const task = await ensureApplicationTask(db, {\n      profileId: PROFILE, opportunityId: \`fo-\${id}\`, grantId: \`g-\${id}\`,\n      automationType: 'portal', initialStatus: 'queued',\n    })\n    const taskStatus = id === 'good' ? 'ready_to_start'\n      : id === 'interested' ? 'filling_portal'\n        : 'waiting_for_review'\n    await updateApplicationTask(db, task.id, { status: taskStatus, allowAutoSubmit: true, autoSubmitEnabled: true })\n  }\n  return { sqlite, db }\n}\n\ndescribe('pipeline precision reconciles live Hamilton tasks with four-gate truth', () => {\n  it('removes machine-progressed bad grants, cancels their tasks, removes match truth, and preserves only valid/submitted history', async () => {\n    const { sqlite, db } = await seed()\n    const result = await enforcePipelinePrecision(db)\n    expect(result.ok).toBe(true)\n    expect(result.failed).toBe(0)\n    expect(result.removed).toBe(3)\n    expect(result.relabeled).toBe(1)\n    expect(result.tasksCancelled).toBe(4)\n    expect(result.matchesRemoved).toBe(4)\n\n    const remaining = sqlite.prepare('SELECT id, status, eligibility_status, match_decision FROM grants ORDER BY id').all()\n    expect(remaining.map((row) => row.id)).toEqual(['g-good', 'g-submitted'])\n    const submitted = remaining.find((row) => row.id === 'g-submitted')\n    expect(submitted.status).toBe('submitted')\n    expect(submitted.eligibility_status).toBe('ineligible')\n    expect(submitted.match_decision).toBe('REJECT')\n\n    const matches = sqlite.prepare('SELECT opportunity_id FROM profile_opportunity_matches ORDER BY opportunity_id').all()\n    expect(matches.map((row) => row.opportunity_id)).toEqual(['fo-good'])\n\n    const tasks = sqlite.prepare('SELECT grant_id, status, allow_auto_submit FROM application_tasks ORDER BY grant_id').all()\n    for (const task of tasks.filter((row) => row.grant_id !== 'g-good')) {\n      expect(task.status).toBe('cancelled')\n      expect(Boolean(task.allow_auto_submit)).toBe(false)\n    }\n    expect(tasks.find((row) => row.grant_id === 'g-good')?.status).toBe('ready_to_start')\n\n    const tombstones = sqlite.prepare('SELECT opportunity_id FROM pipeline_dismissals WHERE profile_id = ? ORDER BY opportunity_id').all(PROFILE)\n    expect(tombstones.map((row) => row.opportunity_id)).toEqual(['fo-interested', 'fo-portal', 'fo-saved'])\n\n    const summary = JSON.parse(sqlite.prepare("SELECT value FROM system_kv WHERE key = 'pipeline_precision_last_run'").get().value)\n    expect(summary.tasksCancelled).toBe(4)\n    expect(summary.matchesRemoved).toBe(4)\n    expect(summary.truncated).toBe(false)\n  })\n})\n`
  fs.writeFileSync(path, content)
  console.log(`[patch] wrote ${path}`)
}

patchRobertAudit()
patchHamiltonPolicy()
patchHamiltonOrchestrator()
patchPipelineInvariant()
patchPipelinePrecisionTests()
patchHamiltonTests()
writeIntegrationTest()
console.log('[patch] live pipeline/task reconciliation patch complete')
