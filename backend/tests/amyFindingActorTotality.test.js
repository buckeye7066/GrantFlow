/**
 * amyFindingActorTotality.test.js — EVERY FINDING CLASS HAS AN ACTOR.
 *
 * The rule this file enforces (owner directive 2026-08-02): a finding class
 * with no lever is a write-only queue. `buildApprovalQueue` proved it — it read
 * five evaluation FIELDS and never `e.findings`, so nine of the seventeen
 * declared classes could not produce an item, acquire a lever, enter the
 * durable ledger, or be closed by anything. `institution_recall_miss` ran 21 of
 * 21 retained days in prod (282 occurrences) and was never once green.
 *
 * These tests fail the BUILD when:
 *   - a `FINDING_TYPES` value has no entry in `FINDING_ACTORS`;
 *   - an actor names a lever that is not in `LEVER_REGISTRY`;
 *   - an `emitted` flag disagrees with what `amyReport.js` can actually emit;
 *   - a lever has no declared SURFACE class;
 *   - a lever on a FORBIDDEN surface is declared AUTO.
 *
 * The last one is the safety boundary, and it is mutation-verified below: the
 * assertion is re-run against a deliberately corrupted registry and MUST throw.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { FINDING_TYPES } from '../services/amy/amyConstants.js'
import { ACTIONABILITY, LEVER_REGISTRY } from '../services/amy/approvalLedger.js'
import {
  FINDING_ACTORS,
  LEVER_SURFACE,
  SURFACE_CLASSES,
  AUTONOMY_FORBIDDEN,
  actorFor,
  actorlessFindingTypes,
  unregisteredLevers,
  assertAutonomyBoundary,
} from '../services/amy/findingActorRegistry.js'
import { buildApprovalQueue, itemFindingType } from '../services/amy/crawlerTuner.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const amyReportSource = readFileSync(path.join(here, '../services/amy/amyReport.js'), 'utf8')

describe('TOTALITY — every declared finding class maps to an actor', () => {
  it('has no finding type without an actor', () => {
    expect(actorlessFindingTypes()).toEqual([])
  })

  it('covers every FINDING_TYPES value and nothing else', () => {
    const declared = Object.values(FINDING_TYPES).sort()
    expect(Object.keys(FINDING_ACTORS).sort()).toEqual(declared)
  })

  it('names only levers the approval registry knows how to close', () => {
    expect(unregisteredLevers()).toEqual([])
    for (const [type, actor] of Object.entries(FINDING_ACTORS)) {
      expect(LEVER_REGISTRY[actor.lever], `${type} -> ${actor.lever}`).toBeTruthy()
    }
  })

  it('declares a disposition (AUTO / OWNER_API / CODE_CHANGE) for every actor', () => {
    const valid = new Set(Object.values(ACTIONABILITY))
    for (const [type, actor] of Object.entries(FINDING_ACTORS)) {
      const disposition = LEVER_REGISTRY[actor.lever].actionability
      expect(valid.has(disposition), `${type}: ${disposition}`).toBe(true)
    }
  })
})

describe('the `emitted` flag is a fact about the code, not a comment', () => {
  it('every class marked emitted IS reachable from evaluateDiscovery', () => {
    for (const [type, actor] of Object.entries(FINDING_ACTORS)) {
      if (!actor.emitted) continue
      // makeFinding(FINDING_TYPES.X, …) — the only way a finding is produced.
      const constName = Object.entries(FINDING_TYPES).find(([, v]) => v === type)?.[0]
      expect(constName, type).toBeTruthy()
      expect(
        amyReportSource.includes(`FINDING_TYPES.${constName}`),
        `${type} is marked emitted:true but amyReport.js never emits it`,
      ).toBe(true)
    }
  })

  it('every class marked NOT emitted is genuinely absent from the detectors', () => {
    for (const [type, actor] of Object.entries(FINDING_ACTORS)) {
      if (actor.emitted) continue
      const constName = Object.entries(FINDING_TYPES).find(([, v]) => v === type)?.[0]
      expect(
        amyReportSource.includes(`FINDING_TYPES.${constName}`),
        `${type} is marked emitted:false but amyReport.js DOES emit it — the flag has rotted`,
      ).toBe(false)
    }
  })
})

describe('the autonomy boundary is a registry, not scattered conditionals', () => {
  it('declares a surface class for every registered lever', () => {
    const missing = Object.keys(LEVER_REGISTRY).filter((l) => !LEVER_SURFACE[l])
    expect(missing).toEqual([])
  })

  it('uses only declared surface classes', () => {
    const valid = new Set(Object.values(SURFACE_CLASSES))
    for (const [lever, surface] of Object.entries(LEVER_SURFACE)) {
      expect(valid.has(surface), `${lever}: ${surface}`).toBe(true)
    }
  })

  it('the live registry passes the boundary', () => {
    expect(assertAutonomyBoundary()).toBe(true)
  })

  it('never auto-applies matching logic, eligibility, scoring math or security', () => {
    for (const [lever, entry] of Object.entries(LEVER_REGISTRY)) {
      if (entry.actionability !== ACTIONABILITY.AUTO) continue
      expect(AUTONOMY_FORBIDDEN, `${lever} is AUTO`).not.toContain(LEVER_SURFACE[lever])
    }
    // The specific ones the owner named, pinned by hand so a future edit has to
    // change a test that says what it is protecting.
    expect(LEVER_REGISTRY.eligibility_gate.actionability).toBe(ACTIONABILITY.CODE_CHANGE)
    expect(LEVER_SURFACE.eligibility_gate).toBe(SURFACE_CLASSES.ELIGIBILITY)
    expect(LEVER_REGISTRY.geo_scope.actionability).toBe(ACTIONABILITY.CODE_CHANGE)
    expect(LEVER_SURFACE.geo_scope).toBe(SURFACE_CLASSES.MATCHING_LOGIC)
  })

  // MUTATION: a guard that cannot fail proves nothing. Corrupt the registry and
  // the assertion MUST throw.
  it('FAILS when a forbidden-surface lever is flipped to AUTO', () => {
    const corrupted = {
      ...LEVER_REGISTRY,
      eligibility_gate: { ...LEVER_REGISTRY.eligibility_gate, actionability: ACTIONABILITY.AUTO },
    }
    expect(() => assertAutonomyBoundary(corrupted)).toThrow(/eligibility_gate.*forbidden/i)
  })

  it('FAILS when a lever has no declared surface', () => {
    const corrupted = { ...LEVER_REGISTRY, brand_new_lever: { actionability: ACTIONABILITY.AUTO } }
    expect(() => assertAutonomyBoundary(corrupted)).toThrow(/no declared surface/i)
  })
})

// ── The behavioural half: the queue must actually emit the classes ──────────

function evalWithFinding(type, category, evidence = {}) {
  return {
    scenario_id: `${category}-v1`,
    category,
    profile_id: `p-${category}-${type}`,
    status: 'ok',
    stored: 12,
    accepted: 3,
    review: 1,
    sources_failed: 0,
    false_positives: 0,
    ineligible_accepts: 0,
    findings: [{ type, file: 'backend/x.js', evidence }],
  }
}

describe('buildApprovalQueue now emits an item for EVERY emitted class', () => {
  const emitted = Object.entries(FINDING_ACTORS).filter(([, a]) => a.emitted).map(([t]) => t)

  it.each(emitted)('%s produces an approval item with a lever', (type) => {
    const items = buildApprovalQueue([evalWithFinding(type, 'probe_cat')])
    const match = items.find((i) => itemFindingType(i) === type)
    expect(match, `no item for ${type}`).toBeTruthy()
    expect(match.lever).toBe(FINDING_ACTORS[type].lever)
    expect(match.actionability).toBeTruthy()
  })

  it('carries the CONCRETE subject, not just a count', () => {
    const items = buildApprovalQueue([
      evalWithFinding(FINDING_TYPES.INSTITUTION_RECALL_MISS, 'student', { schools: ['West Virginia University'] }),
    ])
    const item = items.find((i) => itemFindingType(i) === FINDING_TYPES.INSTITUTION_RECALL_MISS)
    expect(item.evidence.subjects).toContain('West Virginia University')
    expect(item.rationale).toContain('West Virginia University')
  })

  it('never double-reports a class an existing branch already emitted', () => {
    // zero_result is emitted by the legacy `coverage:` branch. The totality
    // pass must NOT add a second `zero_result:` item for the same run.
    const items = buildApprovalQueue([
      { ...evalWithFinding(FINDING_TYPES.ZERO_RESULT, 'tribal_org'), status: 'zero', stored: 0 },
    ])
    const zeroItems = items.filter((i) => itemFindingType(i) === FINDING_TYPES.ZERO_RESULT)
    expect(zeroItems).toHaveLength(1)
    expect(zeroItems[0].id).toBe('coverage:tribal_org')
  })

  it('attaches a CODE BRIEF to a code-change item, and says Amy wrote no patch', () => {
    const items = buildApprovalQueue([
      evalWithFinding(FINDING_TYPES.AMOUNT_RECALL_MISS, 'probe_cat', { grant_shaped: 9 }),
    ])
    const item = items.find((i) => itemFindingType(i) === FINDING_TYPES.AMOUNT_RECALL_MISS)
    expect(item.actionability).toBe(ACTIONABILITY.CODE_CHANGE)
    expect(item.code_brief).toBeTruthy()
    expect(item.code_brief.file).toBe('backend/services/awardAmountExtractor.js')
    expect(item.code_brief.suggested_test).toMatch(/amount_recall_miss/)
    expect(item.code_brief.patch_authored_by_amy).toBe(false)
  })

  it('does NOT attach a brief to an AUTO item — that is Amy\'s own work', () => {
    const items = buildApprovalQueue([
      evalWithFinding(FINDING_TYPES.INSTITUTION_RECALL_MISS, 'student', { schools: ['X University'] }),
    ])
    const item = items.find((i) => itemFindingType(i) === FINDING_TYPES.INSTITUTION_RECALL_MISS)
    expect(item.actionability).toBe(ACTIONABILITY.AUTO)
    expect(item.requires_approval).toBe(false)
    expect(item.code_brief).toBeUndefined()
  })

  it('emits NOTHING for a class no detector produces', () => {
    // BAD_MATCH is declared vocabulary with no emitter. A run that produces no
    // such finding must not mint an item for it.
    const items = buildApprovalQueue([evalWithFinding(FINDING_TYPES.AMOUNT_RECALL_MISS, 'c1')])
    expect(items.some((i) => itemFindingType(i) === FINDING_TYPES.BAD_MATCH)).toBe(false)
  })

  it('an unknown finding type resolves to an honest null actor', () => {
    expect(actorFor('not_a_real_class')).toBeNull()
    expect(actorFor(undefined)).toBeNull()
  })
})
