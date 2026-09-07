/**
 * NEED PROVENANCE + SIGNAL VERSIONING (owner order 2026-09-07: "figure out the
 * root of this issue and fix it globally and permanently").
 *
 * Three official housing locators told a Tennessee student "Why this matched:
 * Veteran / Emergency need". Root cause, proven by replay: `normalizeProfile`
 * read `profile.tags` as NEED declarations, and the crawler-os lane fills the
 * canonical profile's `tags` with applicant types and mined keywords — so
 * "individual" became a need on every crawler-scored row and, before #1564,
 * the word "veteran" inside her own DENIAL did too. The stored rows then kept
 * surfacing because `isStaleMatchExplain` only checked that SOME policy
 * version was present, never whether it was CURRENT.
 *
 * Permanent parts pinned here:
 *   1. tags are not needs;
 *   2. every persisted explain carries `signal_version`, and an explain made
 *      under any other version is stale (the boot drain re-scores it);
 *   3. the derivation files are HASHED — change one without bumping
 *      PROFILE_SIGNAL_VERSION and this test fails.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeProfile } from '../services/profileNormalizer.js'
import {
  PROFILE_SIGNAL_VERSION, PROFILE_SIGNAL_DERIVATION_FILES, PROFILE_SIGNAL_DERIVATION_HASH,
} from '../config/profileSignalVersion.js'
import {
  isStaleMatchExplain, staleMatchExplainSql, buildPersistedMatchExplain,
} from '../services/matching/matchExplainPersistence.js'
import { computeMatchDecision as crawlerOsDecision } from '../crawler-os/matchEngine.js'

describe('need provenance — a tag is not a need', () => {
  it('tags carrying applicant types, populations, or denial vocabulary never become need categories', () => {
    const n = normalizeProfile(
      { id: 'p', primary_type: 'student', needs: ['education'], tags: ['individual', 'veteran', 'student', 'emergency assistance', 'utilities', 'military'] },
      {}, null,
    )
    expect(n.needCategories).toContain('education')
    for (const junk of ['individual', 'veteran', 'emergency', 'utilities']) expect(n.needCategories).not.toContain(junk)
  })

  it('declared need fields still count (needs, need_categories, a need-keyed section)', () => {
    const n = normalizeProfile(
      { id: 'p', primary_type: 'individual', needs: ['housing'], need_categories: ['food'] },
      { utilities: { help_with_bills: true } }, null,
    )
    expect(n.needCategories).toEqual(expect.arrayContaining(['housing', 'food', 'utilities']))
  })

  it('the crawler-os lane no longer reports an opportunity\'s applicant types as the profile\'s matched needs', () => {
    const thesis = {
      profile_id: 'p', applicant_types: ['student', 'individual'], needs: ['education', 'scholarship'], needs_defaulted: false,
      keywords: ['education', 'scholarship', 'student', 'individual'], location: { state: 'TN', city: 'Cleveland' }, state: 'TN',
    }
    const opp = {
      id: 'o', source_id: 'x', title: 'Housing help finder', sponsor: 'State Housing Agency', description: 'Housing and emergency help.',
      applicant_types: ['individual', 'family', 'veteran'], need_categories: ['housing', 'emergency', 'veteran'],
      geography: { national: false, states: ['TN'] }, opportunity_kind: 'DIRECTORY', kind: 'DIRECTORY', state: 'TN',
      reality_status: 'directory', apply_url: 'https://example.org/x', info_url: 'https://example.org/x',
    }
    const d = crawlerOsDecision(opp, thesis, {})
    const needs = (d.matched_needs ?? d.canonical?.matchedNeeds ?? []).map((x) => String(x).toLowerCase())
    expect(needs).not.toContain('veteran')
    expect(needs).not.toContain('individual')
    const facts = JSON.stringify(d.matched_profile_facts ?? [])
    expect(facts).not.toMatch(/Need: veteran/)
    expect(facts).not.toMatch(/Need: individual/)
  })
})

describe('signal version — stored evidence expires with the code that made it', () => {
  const fresh = { scoring_policy_version: 'need_first_v2', signal_version: PROFILE_SIGNAL_VERSION, matchedNeeds: ['education'], matchedSignals: ['needs'] }

  it('buildPersistedMatchExplain stamps the current signal_version', () => {
    const out = buildPersistedMatchExplain({ match_explain: { scoring_policy_version: 'need_first_v2', matchedNeeds: [], matchedSignals: [] } })
    expect(out.signal_version).toBe(PROFILE_SIGNAL_VERSION)
  })

  it('an explain without signal_version, or with an older one, is stale; the current one is not', () => {
    expect(isStaleMatchExplain(fresh)).toBe(false)
    expect(isStaleMatchExplain({ ...fresh, signal_version: undefined })).toBe(true)
    expect(isStaleMatchExplain({ ...fresh, signal_version: '2000.01.01-0' })).toBe(true)
    expect(isStaleMatchExplain(JSON.stringify(fresh))).toBe(false)
  })

  it('the SQL predicate names the current version so the drain finds every older row', () => {
    const sql = staleMatchExplainSql('m')
    expect(sql).toContain('signal_version')
    expect(sql).toContain(PROFILE_SIGNAL_VERSION)
  })

  it('the version format is date + counter', () => {
    expect(PROFILE_SIGNAL_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/)
  })

  it('TRIPWIRE: the derivation files match the pinned hash — bump PROFILE_SIGNAL_VERSION and run `node scripts/pin-signal-version.mjs` when they change', () => {
    const h = createHash('sha256')
    for (const rel of PROFILE_SIGNAL_DERIVATION_FILES) {
      const text = readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')
      h.update(`${rel}\n${text}\n`)
    }
    const current = h.digest('hex')
    expect(
      current,
      `profile-signal derivation changed (files: ${PROFILE_SIGNAL_DERIVATION_FILES.join(', ')}). ` +
      'Bump PROFILE_SIGNAL_VERSION in backend/config/profileSignalVersion.js, then run `node scripts/pin-signal-version.mjs`.',
    ).toBe(PROFILE_SIGNAL_DERIVATION_HASH)
  })
})
