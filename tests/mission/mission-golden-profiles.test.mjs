/**
 * Mission test suite — five golden production profiles (Phase D).
 *
 * Each fixture is a fully-shaped profile + sections object that flows
 * through the *real* production code paths:
 *
 *   profileTypeRegistry.resolveProfileType
 *   profileTypeRegistry.recommendedSourcesFor
 *   sourceRegistry.planCoverage
 *   profileHelpers.buildProfileSignals + buildProfileSignalAudit
 *   sourceRegistry.buildGrantsGovQueryTerms
 *   sourceRegistry.looksLikePiiTerm
 *   sourceRegistry.buildCoverageReport
 *   matchEngine.computeMatchDecision
 *   zeroResultLadder.assembleFundingResults
 *   applicationWorkflow.generateActionPlan
 *   anyaToolRegistry.invokeTool('anya.nextBestAction'...)
 *
 * If any fixture starts losing its canonical profile type, planning <3
 * sources, leaking PII, or returning a bare-blank zero-result page,
 * exactly one of the assertions below trips and the build fails.
 *
 * The five golden profiles intentionally cover non-overlapping mission
 * surfaces (county-gov / VFD / student / teacher / family-medical), so
 * "all five green" is the production-readiness gate for discovery.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { GOLDEN_PROFILES } from '../fixtures/goldenProfiles.mjs'

import {
  resolveProfileType,
  recommendedSourcesFor,
  defaultNeedsFor,
  recommendStrategyFor,
} from '../../backend/services/profileTypeRegistry.js'

import {
  planCoverage,
  buildCoverageReport,
  buildGrantsGovQueryTerms,
  looksLikePiiTerm,
  SOURCES,
} from '../../backend/services/sourceRegistry.js'

import {
  buildProfileSignals,
  buildProfileSignalAudit,
} from '../../backend/services/profileHelpers.js'

import { computeMatchDecision } from '../../backend/services/matchEngine.js'

import {
  assembleFundingResults,
  TIERS,
} from '../../backend/services/zeroResultLadder.js'

import {
  generateActionPlan,
} from '../../backend/services/applicationWorkflow.js'

import { invokeTool } from '../../backend/services/anyaToolRegistry.js'

// ── In-memory DB fixture for Anya tools ─────────────────────────────────
function createDb(profile) {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      display_name TEXT,
      status TEXT,
      state TEXT,
      zip TEXT,
      city TEXT,
      organization_type TEXT,
      primary_type TEXT,
      applicant_type TEXT,
      categories TEXT,
      tags TEXT,
      interests TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      grant_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE application_steps (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      step_order INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      due_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)

  const stmt = raw.prepare(`
    INSERT INTO profiles
      (id, organization_id, display_name, status, state, zip, city,
       organization_type, primary_type, applicant_type, categories)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    profile.id,
    profile.organization_id ?? null,
    profile.display_name ?? null,
    profile.status ?? 'active',
    profile.state ?? null,
    profile.zip ?? null,
    profile.city ?? null,
    profile.organization_type ?? null,
    profile.primary_type ?? null,
    profile.applicant_type ?? null,
    Array.isArray(profile.categories) ? JSON.stringify(profile.categories) : null,
  )

  return wrapDb(raw)
}

function wrapDb(raw) {
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        async get(...args) { return stmt.get(...args) },
        async all(...args) { return stmt.all(...args) },
        async run(...args) { return stmt.run(...args) },
      }
    },
  }
}

function userCtx({ profileId } = {}) {
  return {
    userId: 'u-test',
    email: 'tester@example.com',
    isAdmin: false,
    activeProfileId: profileId,
    accessibleProfileIds: profileId ? [profileId] : [],
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────
function isAcceptableType(actual, expected, fallback) {
  if (Array.isArray(expected)) return expected.includes(actual)
  if (actual === expected) return true
  if (Array.isArray(fallback) && fallback.includes(actual)) return true
  return false
}

function flatten(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(flatten).join(' ')
  if (typeof value === 'object') {
    return Object.values(value).map(flatten).join(' ')
  }
  return ''
}

function flattenAll(...things) {
  return things.map(flatten).join(' ').toLowerCase()
}

// ─── 1. resolveProfileType — every fixture canonicalizes ────────────────
for (const fixture of GOLDEN_PROFILES) {
  test(`golden:${fixture.name} — primary_type resolves to a canonical id`, () => {
    const resolved = resolveProfileType(fixture.profile.primary_type) ??
      resolveProfileType(fixture.profile.applicant_type) ??
      resolveProfileType(fixture.profile.organization_type)
    assert.ok(
      resolved,
      `${fixture.name}: primary_type=${fixture.profile.primary_type} must resolve, got null. ` +
        `Make sure the type is registered in backend/services/profileTypeRegistry.js`,
    )
    assert.ok(
      isAcceptableType(resolved, fixture.expectations.canonicalType, fixture.expectations.acceptableCanonicalTypes),
      `${fixture.name}: expected canonical type ` +
        `${JSON.stringify(fixture.expectations.canonicalType)} (or one of ` +
        `${JSON.stringify(fixture.expectations.acceptableCanonicalTypes)}), got ${resolved}`,
    )
  })

  test(`golden:${fixture.name} — recommendedSourcesFor returns >= 3 unique sources`, () => {
    const srcs = recommendedSourcesFor(fixture.profile.primary_type)
    assert.ok(
      Array.isArray(srcs) && srcs.length >= 3,
      `${fixture.name}: expected >= 3 recommended sources, got ${JSON.stringify(srcs)}`,
    )
  })

  test(`golden:${fixture.name} — required source families are recommended`, () => {
    const srcs = new Set(recommendedSourcesFor(fixture.profile.primary_type))
    const missing = fixture.expectations.requiredSourceCategories.filter((id) => !srcs.has(id))
    assert.equal(
      missing.length,
      0,
      `${fixture.name}: missing required source categories ${JSON.stringify(missing)}; ` +
        `got ${JSON.stringify([...srcs])}`,
    )
  })

  test(`golden:${fixture.name} — recommendStrategyFor is a known strategy`, () => {
    const strat = recommendStrategyFor(fixture.profile.primary_type)
    assert.ok(typeof strat === 'string' && strat.length > 0, `${fixture.name}: strategy must be a non-empty string`)
  })
}

// ─── 2. planCoverage — at least 3 planned, direct source if expected ────
for (const fixture of GOLDEN_PROFILES) {
  test(`golden:${fixture.name} — planCoverage plans >= 3 sources`, () => {
    const signals = buildProfileSignals({
      profile: fixture.profile,
      sections: fixture.sections,
    })
    const plan = planCoverage({ profile: fixture.profile, signals })
    assert.ok(
      plan.sources_planned.length >= 3,
      `${fixture.name}: planned only ${plan.sources_planned.length} sources, expected >= 3. ` +
        `plan=${JSON.stringify(plan, null, 2)}`,
    )
    assert.ok(
      plan.sources_required.length >= 3,
      `${fixture.name}: required only ${plan.sources_required.length} sources, expected >= 3 (mission rule)`,
    )
  })

  if (fixture.expectations.mustHaveDirectSource) {
    test(`golden:${fixture.name} — planCoverage attempts at least one DIRECT source`, () => {
      const signals = buildProfileSignals({ profile: fixture.profile, sections: fixture.sections })
      const plan = planCoverage({ profile: fixture.profile, signals })
      assert.ok(
        plan.direct_sources.length >= 1,
        `${fixture.name}: must include >= 1 DIRECT source. plan=${JSON.stringify(plan)}`,
      )
    })
  }
}

// ─── 3. buildGrantsGovQueryTerms — non-empty, non-PII, profile-flavored ─
for (const fixture of GOLDEN_PROFILES) {
  test(`golden:${fixture.name} — Grants.gov query terms are non-empty + non-PII`, () => {
    const signals = buildProfileSignals({ profile: fixture.profile, sections: fixture.sections })
    const terms = buildGrantsGovQueryTerms({ profile: fixture.profile, signals })
    assert.ok(Array.isArray(terms) && terms.length > 0, `${fixture.name}: must return >= 1 term`)
    for (const term of terms) {
      assert.ok(typeof term === 'string' && term.trim().length > 0, `${fixture.name}: term must be non-blank`)
      assert.equal(
        looksLikePiiTerm(term),
        false,
        `${fixture.name}: PII-shaped term escaped into Grants.gov query: ${JSON.stringify(term)}`,
      )
    }
  })
}

// ─── 4. PII safety — explicit golden tokens never leak anywhere ─────────
for (const fixture of GOLDEN_PROFILES) {
  if (!fixture.expectations.piiTokensThatMustNeverLeak) continue
  test(`golden:${fixture.name} — PII tokens never appear in query terms / coverage report`, () => {
    const signals = buildProfileSignals({ profile: fixture.profile, sections: fixture.sections })
    const terms = buildGrantsGovQueryTerms({ profile: fixture.profile, signals })
    const plan = planCoverage({ profile: fixture.profile, signals })
    const coverage = buildCoverageReport(plan, [])
    const hay = JSON.stringify({ terms, plan, coverage }).toLowerCase()
    for (const token of fixture.expectations.piiTokensThatMustNeverLeak) {
      assert.equal(
        hay.includes(token.toLowerCase()),
        false,
        `${fixture.name}: PII token ${JSON.stringify(token)} leaked into query terms / plan / ` +
          `coverage report. This violates Goal 11 (PII never sent to crawlers/external search).`,
      )
      assert.equal(
        looksLikePiiTerm(token),
        true,
        `${fixture.name}: looksLikePiiTerm() must reject ${JSON.stringify(token)} so it can never ` +
          `escape via signals.needs/interests`,
      )
    }
  })
}

// ─── 5. buildCoverageReport — outcomes flow through correctly ───────────
for (const fixture of GOLDEN_PROFILES) {
  test(`golden:${fixture.name} — buildCoverageReport reflects outcomes (queried/failed/found)`, () => {
    const signals = buildProfileSignals({ profile: fixture.profile, sections: fixture.sections })
    const plan = planCoverage({ profile: fixture.profile, signals })
    const required = plan.sources_required.slice(0, 3)
    const outcomes = required.map((id, i) => ({
      source_id: id,
      queried: true,
      failed: i === 2,
      found: i === 0 ? 4 : 0,
      error: i === 2 ? 'timeout' : null,
    }))
    const report = buildCoverageReport(plan, outcomes)
    assert.equal(report.profile_type, plan.profile_type, `${fixture.name}: report must echo profile_type`)
    assert.ok(report.sources_queried.length >= 3, `${fixture.name}: report must record >= 3 queried sources`)
    assert.ok(
      report.sources_failed.length >= 1,
      `${fixture.name}: failed source must be tracked, got ${JSON.stringify(report.sources_failed)}`,
    )
    assert.equal(report.sources_failed[0].error, 'timeout')
  })
}

// ─── 6. computeMatchDecision — exposes profile facts ────────────────────
for (const fixture of GOLDEN_PROFILES) {
  test(`golden:${fixture.name} — computeMatchDecision includes location + profile facts`, () => {
    const opp = {
      id: `opp-${fixture.name}`,
      title: 'Generic National Opportunity',
      application_url: 'https://example.gov/apply',
      source_url: 'https://example.gov/apply',
      source: 'grants.gov',
      record_origin: 'grants_gov',
      state: 'nationwide',
      is_national: true,
      categories: ['general'],
      keywords: ['general'],
      opportunity_type: 'grant',
      deadline: '2099-12-31',
    }
    const decision = computeMatchDecision(fixture.profile, opp, { profileSections: fixture.sections })
    assert.ok(Array.isArray(decision.matched_profile_facts), `${fixture.name}: matched_profile_facts must be array`)
    assert.ok(decision.matcherVersion, `${fixture.name}: matcherVersion must be set`)
    if (fixture.profile.state) {
      const stateRe = new RegExp(fixture.profile.state, 'i')
      const stateMentioned = decision.matched_profile_facts.some((f) => stateRe.test(f))
      assert.ok(
        stateMentioned,
        `${fixture.name}: matched_profile_facts must mention state ${fixture.profile.state}. ` +
          `Got: ${JSON.stringify(decision.matched_profile_facts)}`,
      )
    }
  })

  test(`golden:${fixture.name} — buildProfileSignalAudit returns non-empty audit`, () => {
    const signals = buildProfileSignals({ profile: fixture.profile, sections: fixture.sections })
    const audit = buildProfileSignalAudit({ profile: fixture.profile, sections: fixture.sections, signals })
    assert.ok(audit, `${fixture.name}: audit must exist`)
    assert.ok(audit.profile_type, `${fixture.name}: audit.profile_type must be set`)
    assert.ok(Array.isArray(audit.location_used), `${fixture.name}: audit.location_used must be array`)
    assert.ok(Array.isArray(audit.needs_used), `${fixture.name}: audit.needs_used must be array`)
  })
}

// ─── 7. zeroResultLadder — never blank, honest fallback ─────────────────
test('golden:zero-result ladder — empty discovery never returns a blank page', () => {
  for (const fixture of GOLDEN_PROFILES) {
    const result = assembleFundingResults([], {
      minScore: 50,
      profileGaps: ['state'].filter(() => !fixture.profile.state),
    })
    assert.ok(result.explanation, `${fixture.name}: zero-result must include explanation`)
    assert.ok(Object.values(TIERS).includes(result.tier), `${fixture.name}: must report a known tier`)
    if (result.opportunities.length === 0) {
      assert.ok(
        result.tier === TIERS.PROFILE_GAPS || result.tier === TIERS.EXPLAIN_ZERO,
        `${fixture.name}: empty opportunities must yield PROFILE_GAPS or EXPLAIN_ZERO tier, ` +
          `got ${result.tier}`,
      )
    }
  }
})

test('golden:zero-result ladder — directories ALWAYS survive strict filtering', () => {
  // Family/medical profile relies on directories (211, Community Action) when
  // direct funding is sparse — this asserts they survive a strict minScore.
  const result = assembleFundingResults([
    { id: 'dir-211', title: 'United Way 211', kind: 'directory',
      match_score: 5, match_decision: 'REVIEW', application_url: 'https://www.211.org' },
  ], { minScore: 95 })
  assert.equal(result.tier, TIERS.DIRECTORY)
  assert.ok(result.opportunities.length >= 1)
})

// ─── 8. applicationWorkflow.generateActionPlan — real plan per fixture ──
for (const fixture of GOLDEN_PROFILES) {
  test(`golden:${fixture.name} — generateActionPlan returns >=3 next_steps + relevant docs`, () => {
    const opp = {
      id: `opp-${fixture.name}`,
      title: `${fixture.summary} (test opportunity)`,
      kind: 'direct',
      deadline: '2099-12-31T00:00:00.000Z',
      application_url: 'https://example.gov/apply',
    }
    const plan = generateActionPlan(opp, { profile: fixture.profile, sections: fixture.sections })
    assert.equal(plan.opportunity_id, opp.id)
    assert.ok(Array.isArray(plan.next_steps), `${fixture.name}: next_steps must be array`)
    assert.ok(plan.next_steps.length >= 3, `${fixture.name}: expected >= 3 next_steps`)
    assert.ok(Array.isArray(plan.documents_needed), `${fixture.name}: documents_needed must be array`)
    assert.equal(plan.deadlines.length, 2, `${fixture.name}: deadline + reminder expected`)

    const docHay = flattenAll(plan.documents_needed, plan.next_steps, plan.notes)
    assert.match(
      docHay,
      fixture.expectations.workflowDocsMustMention,
      `${fixture.name}: workflow docs/steps/notes must include ${fixture.expectations.workflowDocsMustMention} (got: ${docHay.slice(0, 240)}…)`,
    )
  })
}

// ─── 9. Anya — nextBestAction uses real DB + profile context ────────────
for (const fixture of GOLDEN_PROFILES) {
  test(`golden:${fixture.name} — anya.nextBestAction returns grounded actions`, async () => {
    const db = createDb(fixture.profile)
    const ctx = userCtx({ profileId: fixture.profile.id })
    const result = await invokeTool(
      'anya.nextBestAction',
      { profileId: fixture.profile.id, pageContext: { currentPage: 'DiscoverGrants' } },
      { db, ctx },
    )
    const output = result?.output ?? result
    assert.ok(output, `${fixture.name}: nextBestAction must return an output`)
    assert.ok(Array.isArray(output.actions), `${fixture.name}: output.actions must be array`)
    if (fixture.expectations.anyaActionMustExist) {
      assert.ok(
        output.actions.length > 0,
        `${fixture.name}: must have >= 1 next action. Got: ${JSON.stringify(output)}`,
      )
    }
    assert.ok(Array.isArray(output.reasons), `${fixture.name}: output.reasons must be array`)
  })
}
