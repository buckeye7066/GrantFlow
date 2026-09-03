import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { APPLICABLE_KINDS } from '../crawler-os/contract.js'
import {
  LINK_LIFECYCLE_KINDS,
  isLegacyDefaultedLinkLifecycleKind,
  isLinkLifecycleKind,
  legacyDefaultedLinkLifecycleKindSql,
  linkLifecycleKindSql,
  linkLifecycleOpportunitySql,
  normalizeLinkLifecycleKind,
} from '../config/linkLifecycleKinds.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

describe('link lifecycle kind registry', () => {
  it('is total over legacy DIRECT plus every apply-capable Crawler OS kind', () => {
    expect(LINK_LIFECYCLE_KINDS).toEqual(['DIRECT', ...APPLICABLE_KINDS])
    expect(new Set(LINK_LIFECYCLE_KINDS).size).toBe(LINK_LIFECYCLE_KINDS.length)
    expect(LINK_LIFECYCLE_KINDS.every((kind) => kind === kind.toUpperCase())).toBe(true)
  })

  it('normalizes case and whitespace while naming NULL/blank as legacy defaults', () => {
    expect(normalizeLinkLifecycleKind(' direct_grant ')).toBe('DIRECT_GRANT')
    expect(normalizeLinkLifecycleKind(null)).toBe('DIRECT')
    expect(normalizeLinkLifecycleKind('   ')).toBe('DIRECT')
    expect(isLegacyDefaultedLinkLifecycleKind(null)).toBe(true)
    expect(isLegacyDefaultedLinkLifecycleKind('  ')).toBe(true)
    expect(isLegacyDefaultedLinkLifecycleKind('direct')).toBe(false)

    for (const kind of ['direct', ' direct_grant ', 'Program', 'scholarship', 'in_kind', 'benefit', null, '']) {
      expect(isLinkLifecycleKind(kind)).toBe(true)
    }
    for (const kind of ['directory', 'referral', 'school_portal', 'past_award_intel', 'unknown']) {
      expect(isLinkLifecycleKind(kind)).toBe(false)
    }
  })

  it('keeps the finite kind registry for classification but uses every non-pointer row for link proof', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE rows (
        id TEXT PRIMARY KEY,
        opportunity_kind TEXT,
        result_kind TEXT,
        opportunity_type TEXT,
        type TEXT
      )
    `)
    const insert = db.prepare(`
      INSERT INTO rows (id, opportunity_kind, result_kind, opportunity_type, type)
      VALUES (?, ?, ?, ?, ?)
    `)
    const fixtures = [
      ['legacy', ' direct ', 'direct', 'grant', 'OPPORTUNITY'],
      ['direct-grant', ' direct_grant ', 'direct', 'grant', 'OPPORTUNITY'],
      ['program', 'Program', 'direct', 'grant', 'OPPORTUNITY'],
      ['scholarship', ' scholarship ', 'direct', 'grant', 'OPPORTUNITY'],
      ['in-kind', 'in_kind', 'direct', 'grant', 'OPPORTUNITY'],
      ['benefit', ' BENEFIT ', 'direct', 'benefit', 'OPPORTUNITY'],
      ['legacy-null', null, 'direct', 'grant', 'OPPORTUNITY'],
      ['legacy-blank', '   ', 'direct', 'grant', 'OPPORTUNITY'],
      ['pointer-kind', 'DIRECTORY', 'directory', 'directory', 'DIRECTORY'],
      ['pointer-result', null, ' referral ', 'grant', 'OPPORTUNITY'],
      ['pointer-type', 'DIRECT', 'direct', 'grant', 'SCHOOL_PORTAL'],
      ['action-step', 'DIRECT', ' action_step ', 'grant', 'OPPORTUNITY'],
      ['unknown', 'OTHER', 'direct', 'grant', 'OPPORTUNITY'],
    ]
    for (const row of fixtures) insert.run(...row)

    expect(db.prepare(`
      SELECT id FROM rows WHERE ${linkLifecycleKindSql('opportunity_kind')} ORDER BY id
    `).all().map((row) => row.id)).toEqual([
      'action-step',
      'benefit',
      'direct-grant',
      'in-kind',
      'legacy',
      'legacy-blank',
      'legacy-null',
      'pointer-result',
      'pointer-type',
      'program',
      'scholarship',
    ])

    expect(db.prepare(`
      SELECT id FROM rows WHERE ${linkLifecycleOpportunitySql()} ORDER BY id
    `).all().map((row) => row.id)).toEqual([
      'benefit',
      'direct-grant',
      'in-kind',
      'legacy',
      'legacy-blank',
      'legacy-null',
      'program',
      'scholarship',
      'unknown',
    ])

    expect(db.prepare(`
      SELECT SUM(CASE WHEN ${legacyDefaultedLinkLifecycleKindSql('opportunity_kind')} THEN 1 ELSE 0 END) AS n
        FROM rows
       WHERE ${linkLifecycleOpportunitySql()}
    `).get().n).toBe(2)
    db.close()
  })

  it('is the only lifecycle-kind registry used by mission health, quarantine, and repair', () => {
    for (const file of [
      'missionHealthService.js',
      'linkVerificationService.js',
      'linkBacklogRepairService.js',
    ]) {
      const source = fs.readFileSync(path.join(HERE, '..', 'services', file), 'utf8')
      expect(source).toContain("config/linkLifecycleKinds.js'")
      expect(source).not.toContain('APPLICABLE_KIND_SQL')
      expect(source).not.toMatch(/IN\s*\(\s*['"]direct['"]\s*,\s*['"]benefit['"]\s*\)/i)
    }
  })
})
