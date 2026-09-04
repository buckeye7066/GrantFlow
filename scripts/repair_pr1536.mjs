import fs from 'node:fs'

function replaceOnce(text, oldText, newText, label) {
  const first = text.indexOf(oldText)
  const last = text.lastIndexOf(oldText)
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one match`)
  }
  return `${text.slice(0, first)}${newText}${text.slice(first + oldText.length)}`
}

function rewrite(path, transform) {
  const before = fs.readFileSync(path, 'utf8')
  const after = transform(before)
  if (after === before) throw new Error(`${path}: no repair diff produced`)
  fs.writeFileSync(path, after)
}

rewrite('backend/services/opportunityMatcher.js', (source) => {
  source = replaceOnce(
    source,
    "  likelySameGrantOpportunity,\n} from '../utils/grantFingerprint.js'",
    "  likelySameGrantOpportunity,\n  opportunityFunder,\n} from '../utils/grantFingerprint.js'",
    'import opportunityFunder',
  )
  return replaceOnce(
    source,
    `  try {\n    return likelySameGrantOpportunity(left, right)\n  } catch {\n    return false\n  }\n}`,
    `  // A shared application portal is not a durable opportunity identity. Many\n  // funders intentionally use the same hosted intake form or directory URL.\n  // Before the fuzzy identity fallback can transfer profile-scoped guidance,\n  // the named funders must not contradict one another.\n  const leftFunder = normalizedIdentity(opportunityFunder(left))\n  const rightFunder = normalizedIdentity(opportunityFunder(right))\n  if (leftFunder && rightFunder && leftFunder !== rightFunder) return false\n\n  try {\n    return likelySameGrantOpportunity(left, right)\n  } catch {\n    return false\n  }\n}`,
    'guard fuzzy identity by funder',
  )
})

rewrite('backend/vnext/stateMachine.js', (source) => replaceOnce(
  source,
  `    if (boundaryNeedsRepair) {\n      const nowExpr = sqlNowLiteral(db)\n      const repair = await db\n        .prepare(\n          \`\n            UPDATE vnext_applications\n            SET boundary_type = ?,\n                boundary_url = ?,\n                updated_at = \${nowExpr}\n            WHERE id = ?\n              AND \${nullSafeEquals(db, 'state')}\n              AND \${nullSafeEquals(db, 'stage')}\n              AND \${nullSafeEquals(db, 'boundary_type')}\n              AND \${nullSafeEquals(db, 'boundary_url')}\n          \`,\n        )\n        .run(\n          boundary_type,\n          boundary_url,\n          String(applicationId),\n          rawState,\n          rawStage,\n          app.boundary_type ?? null,\n          app.boundary_url ?? null,\n        )\n\n      if (changedCount(repair) !== 1) {\n        throw new ConcurrentTransitionError(applicationId, current, target)\n      }\n    }\n`,
  `    if (boundaryNeedsRepair) {\n      const nowExpr = sqlNowLiteral(db)\n      const repair = await db\n        .prepare(\n          \`\n            UPDATE vnext_applications\n            SET boundary_type = ?,\n                boundary_url = ?,\n                updated_at = \${nowExpr}\n            WHERE id = ?\n              AND \${nullSafeEquals(db, 'state')}\n              AND \${nullSafeEquals(db, 'stage')}\n              AND \${nullSafeEquals(db, 'boundary_type')}\n              AND \${nullSafeEquals(db, 'boundary_url')}\n          \`,\n        )\n        .run(\n          boundary_type,\n          boundary_url,\n          String(applicationId),\n          rawState,\n          rawStage,\n          app.boundary_type ?? null,\n          app.boundary_url ?? null,\n        )\n\n      if (changedCount(repair) !== 1) {\n        throw new ConcurrentTransitionError(applicationId, current, target)\n      }\n    } else {\n      // Bind same-state invariant/task side effects to the exact lifecycle\n      // snapshot that authorized them. A concurrent transition makes this\n      // no-op CAS match zero rows and rolls the transaction back.\n      const claim = await db\n        .prepare(\n          \`\n            UPDATE vnext_applications\n            SET updated_at = updated_at\n            WHERE id = ?\n              AND \${nullSafeEquals(db, 'state')}\n              AND \${nullSafeEquals(db, 'stage')}\n          \`,\n        )\n        .run(String(applicationId), rawState, rawStage)\n\n      if (changedCount(claim) !== 1) {\n        throw new ConcurrentTransitionError(applicationId, current, target)\n      }\n    }\n`,
  'add same-state lifecycle CAS',
))

rewrite('backend/tests/vnextApplicationGuidance.test.js', (source) => replaceOnce(
  source,
  "  it('keeps both application rows when loose display similarity lacks canonical identity', () => {\n",
  `  it('does not transfer guidance across different funders that share one portal URL', () => {\n    const applicationBearing = {\n      id: 'foundation-a-row',\n      title: 'Community Support Grant',\n      sponsor: 'Foundation A',\n      state: 'TN',\n      application_url: 'https://shared-portal.org/apply',\n      record_origin: 'curated_program',\n      vnext_application_id: 'app-foundation-a',\n      vnext_application_state: 'MAPPED',\n      vnext_application_stage: 'MAPPED',\n      next_steps: [{ id: 'resolve_missing', category: 'application' }],\n    }\n    const higherTrustDifferentFunder = {\n      id: 'foundation-b-row',\n      title: 'Community Support Grant',\n      sponsor: 'Foundation B',\n      state: 'TN',\n      application_url: 'https://shared-portal.org/apply',\n      record_origin: 'verified_real',\n      next_steps: [{ id: 'save_to_pipeline', category: 'application' }],\n    }\n\n    expect(deduplicateOpportunities([\n      applicationBearing,\n      higherTrustDifferentFunder,\n    ])).toEqual([\n      expect.objectContaining({\n        id: 'foundation-a-row',\n        sponsor: 'Foundation A',\n        vnext_application_id: 'app-foundation-a',\n        next_steps: [{ id: 'resolve_missing', category: 'application' }],\n      }),\n    ])\n  })\n\n  it('keeps both application rows when loose display similarity lacks canonical identity', () => {\n`,
  'add shared portal cross-funder regression',
))

rewrite('backend/tests/vnextStateMachineIntegrity.test.js', (source) => {
  source = replaceOnce(
    source,
    `    expect(db.prepare).not.toHaveBeenCalled()\n  })\n\n  it('revalidates same-state proof`,
    `    expect(db.prepare).toHaveBeenCalledTimes(1)\n    const sql = db.prepare.mock.calls[0][0]\n    expect(sql).toContain('SET updated_at = updated_at')\n    expect(sql).toContain('state IS ?')\n    expect(sql).toContain('stage IS ?')\n  })\n\n  it('blocks a same-state retry when the lifecycle snapshot changes during reconciliation', async () => {\n    getScopedOpportunityForVnextApplication.mockResolvedValue(\n      scopedFixture(VNEXT_STATES.DEDUPED),\n    )\n    const { db } = makeDb({ changes: 0 })\n\n    const result = await attemptTransition(db, 'app-1', VNEXT_STATES.DEDUPED)\n\n    expect(result.ok).toBe(false)\n    expect(result.blockers).toEqual([\n      expect.objectContaining({ code: 'CONCURRENT_TRANSITION' }),\n    ])\n  })\n\n  it('revalidates same-state proof`,
    'update same-state CAS regression',
  )
  return replaceOnce(
    source,
    `    const preparedSql = db.prepare.mock.calls.map(([sql]) => sql)\n    expect(preparedSql.filter((sql) => sql.includes('vnext_application_tasks'))).toHaveLength(3)\n    expect(preparedSql.some((sql) => sql.includes('UPDATE vnext_applications'))).toBe(false)\n  })\n`,
    `    const preparedSql = db.prepare.mock.calls.map(([sql]) => sql)\n    expect(preparedSql.filter((sql) => sql.includes('vnext_application_tasks'))).toHaveLength(3)\n    const lifecycleClaims = preparedSql.filter((sql) => sql.includes('UPDATE vnext_applications'))\n    expect(lifecycleClaims).toHaveLength(1)\n    expect(lifecycleClaims[0]).toContain('SET updated_at = updated_at')\n    expect(lifecycleClaims[0]).not.toContain('SET state = ?')\n  })\n`,
    'update drafting same-state expectations',
  )
})
