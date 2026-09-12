/**
 * A profile deleted while a boot recall sweep is scoring it (2026-09-12 boot:
 * 25+ identical "insert failed (non-fatal) ... violates foreign key constraint
 * profile_opportunity_matches_profile_id_fkey" warnings for one vanished
 * profile) stops being scored instead of failing once per candidate.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { __testables } from '../startup/enforceInvariants.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.join(here, '../startup/enforceInvariants.js'), 'utf8')

describe('vanished-profile insert failures in the recall sweeps', () => {
  const { isVanishedProfileInsertError } = __testables

  it('recognizes the profile foreign-key violation Postgres reports', () => {
    const err = new Error('insert or update on table "profile_opportunity_matches" violates foreign key constraint "profile_opportunity_matches_profile_id_fkey"')
    expect(isVanishedProfileInsertError(err)).toBe(true)
  })

  it('never mistakes another insert failure for a vanished profile', () => {
    expect(isVanishedProfileInsertError(new Error('insert or update on table "profile_opportunity_matches" violates foreign key constraint "profile_opportunity_matches_opportunity_id_fkey"'))).toBe(false)
    expect(isVanishedProfileInsertError(new Error('duplicate key value violates unique constraint'))).toBe(false)
    expect(isVanishedProfileInsertError(null)).toBe(false)
  })

  it('every recall sweep that logs "insert failed (non-fatal)" checks for a vanished profile first', () => {
    const lines = SOURCE.split('\n')
    const sites = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /log\.warn\('[a-z_]+: insert failed \(non-fatal\)'/.test(line))
    expect(sites.length).toBeGreaterThanOrEqual(7)
    for (const { line, i } of sites) {
      const catchWindow = lines.slice(Math.max(0, i - 10), i).join('\n')
      expect(catchWindow, line.trim()).toMatch(/isVanishedProfileInsertError\(err\)/)
    }
  })
})
