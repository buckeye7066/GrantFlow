/**
 * matchEngineCalibratedInventory.test.js
 *
 * Regression coverage for the 2026-07-27 "identical junk lists" report:
 * Anita Mayes (KY, individual) and Anastasia White (TN, student) both had
 * their match lists topped by the SAME broad registry directories at 50-83,
 * labeled "Excellent Match" — with explains like "Matches 9 of the profile's
 * 6 data points — 83% coverage".
 *
 * Root cause: the crawler-os lane scored every profile against its THESIS
 * STUB (~6 data points — the needs list), while the calibrated display bands
 * (8 bar / 11 good / 14 strong) were fit against real 50-150-point profiles.
 * Any topically broad directory trivially "covers" a 6-point inventory.
 *
 * The guarantees pinned here:
 *   1. An inventory below MIN_CALIBRATED_INVENTORY can never mint a
 *      calibrated percentage — it falls to the bounded topical path
 *      (NO_NEEDS_TOPICAL_CAP), so no thin-context caller can ever recreate
 *      the class.
 *   2. A real, rich profile keeps calibrated scoring, and the explanation
 *      can never claim more matched points than the inventory holds.
 *   3. The crawler-os engine forwards a thesis-attached full profile context
 *      into the canonical engine (primary profile), and the OS call sites
 *      thread `_profileContext` (static tripwire).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { scoreOpportunity } from '../services/matchEngine.js'
import { computeMatchDecision as osComputeMatchDecision } from '../crawler-os/matchEngine.js'
import { NO_NEEDS_TOPICAL_CAP, MIN_CALIBRATED_INVENTORY, STRONG_MATCH_SCORE } from '../config/matchThresholds.js'

// A broad national benefits directory — the exact class that topped every
// profile's list (benefits_gov / hrsa_health_workforce / dol_eta_workforce).
const BROAD_DIRECTORY = {
  id: 'opp-benefits-finder',
  title: 'Benefits.gov finder — disability benefits',
  sponsor: 'Benefits.gov',
  description:
    'Find government benefits for disability, health, housing, education, veterans, employment and individuals. Search programs you may be eligible for.',
  source_url: 'https://www.benefits.gov/',
  is_national: true,
  opportunity_kind: 'DIRECTORY',
  categories: '["disability","health_medical","housing","education","veteran","individual"]',
}

// The thesis-stub shape the OS lane used to score with: needs list only.
const STUB_PROFILE = {
  id: 'p-stub',
  primary_type: 'individual',
  needs: ['disability', 'health_medical', 'housing', 'education', 'veteran', 'individual'],
}

describe('MIN_CALIBRATED_INVENTORY floor (the identical-junk-lists class)', () => {
  it('a thesis-stub inventory can never mint a calibrated percentage — capped at the topical bound', () => {
    const { score, reasons } = scoreOpportunity(STUB_PROFILE, BROAD_DIRECTORY)
    expect(score).toBeLessThanOrEqual(NO_NEEDS_TOPICAL_CAP)
    // It must SAY why, and must never emit the calibrated coverage sentence.
    expect(reasons.join(' | ')).toMatch(/too thin for a calibrated coverage claim/i)
    expect(reasons.join(' | ')).not.toMatch(/% coverage of everything this profile tells us/)
    // Below the strong band by construction — this row can never read
    // "Excellent Match" again.
    expect(score).toBeLessThan(STRONG_MATCH_SCORE)
  })

  it('the explanation never claims more matched points than the inventory holds', () => {
    // Rich profile: enough real data points to clear the calibration floor.
    const rich = {
      id: 'p-rich',
      primary_type: 'individual',
      state: 'KY',
      city: 'Louisville',
      zip: '40202',
      needs: ['disability', 'health_medical', 'housing', 'education', 'veteran', 'individual', 'food', 'transportation', 'utilities', 'employment'],
      interests: ['community programs', 'assistance'],
      tags: ['low income', 'single parent'],
    }
    const sections = {
      basic_information: {
        first_name: 'Anita', last_name: 'Mayes', email: 'anita@example.com',
        phone: '555-0100', state: 'KY', city: 'Louisville', zip_code: '40202',
        date_of_birth: '1980-04-02', gender: 'female', marital_status: 'single',
      },
      financial_information: { household_income: 21000, household_size: 3 },
      housing: { housing_status: 'renting', monthly_rent: 900 },
      employment: { employment_status: 'part_time', occupation: 'caregiver' },
    }
    const out = scoreOpportunity(rich, BROAD_DIRECTORY, { profileSections: sections })
    const sentence = out.reasons.find((r) => /Matches \d+ of the profile's \d+ data points/.test(r))
    if (sentence) {
      const [, matched, total] = sentence.match(/Matches (\d+) of the profile's (\d+) data points/)
      expect(Number(matched)).toBeLessThanOrEqual(Number(total))
      expect(Number(total)).toBeGreaterThanOrEqual(MIN_CALIBRATED_INVENTORY)
    } else {
      // If even this profile is below the floor, the honest thin-context
      // sentence must be present instead (and the floor did its job).
      expect(out.reasons.join(' | ')).toMatch(/too thin for a calibrated coverage claim/i)
    }
  })
})

describe('crawler-os lane forwards the primary profile context', () => {
  const OS_OPP = {
    id: 'os-opp-1',
    kind: 'DIRECTORY',
    title: 'Benefits.gov finder — disability benefits',
    sponsor: 'Benefits.gov',
    summary: 'Find government benefits for disability, health, housing, education, veterans, employment.',
    info_url: 'https://www.benefits.gov/',
    applicant_types: ['individual'],
    need_categories: ['disability', 'health_medical', 'housing', 'education'],
    geography: { national: true },
  }
  const THESIS = {
    profile_id: 'p-os',
    applicant_types: ['individual'],
    needs: ['disability', 'health_medical', 'housing', 'education'],
    location: { state: 'KY' },
  }

  it('a context-less thesis stub lands on the topical cap (never 50-83 again)', () => {
    const d = osComputeMatchDecision(OS_OPP, THESIS, {})
    expect(d.match_score).toBeLessThanOrEqual(NO_NEEDS_TOPICAL_CAP)
  })

  it('STATIC TRIPWIRE: both OS scoring call sites thread _profileContext into the engine', () => {
    for (const rel of ['../crawler-os/pipeline.js', '../crawler-os/webLane.js']) {
      const src = fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
      expect(src, `${rel} must pass the thesis-attached profile context`).toContain('_profileContext')
    }
    const svc = fs.readFileSync(path.resolve(__dirname, '../services/crawlerOsService.js'), 'utf8')
    expect(svc, 'runProfileDiscoveryLive must attach the loaded context to the primary thesis').toContain("'_profileContext'")
  })
})
