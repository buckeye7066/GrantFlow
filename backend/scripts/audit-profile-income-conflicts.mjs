/**
 * Profile Income Conflict Audit (READ-ONLY).
 *
 * Finds every profile whose income figures CONFLICT across the two financial
 * sections ('financial' vs 'financial_information'), or whose individual/student
 * profile carries an implausibly high income alongside low_income / need flags.
 *
 * This script mutates NOTHING. It reuses the EXACT classification + money
 * parsing the boot-sweep reconciler uses (enforceProfileIncomeReconciliation in
 * backend/startup/enforceInvariants.js, via its __testables export) so the audit
 * and the repair can never drift in what they consider a conflict.
 *
 * For each conflicting profile it reports the profile id, both section values,
 * whether it is an INDIVIDUAL (in scope for auto-repair) and whether a need
 * signal is present (so you can see which the boot sweep would auto-fix vs.
 * flag for human review).
 *
 * Run locally (uses the configured DB / DATABASE_URL):
 *   node backend/scripts/audit-profile-income-conflicts.mjs
 *
 * Run against PROD read-only (no local DATABASE_URL needed):
 *   railway ssh "node backend/scripts/audit-profile-income-conflicts.mjs"
 */

import { db } from '../db/index.js'
import { __testables } from '../startup/enforceInvariants.js'

const { isIndividualProfileType, parseIncomeValue } = __testables

const CANONICAL = 'financial_information'
const LEGACY = 'financial'

function sectionIncome(section) {
  if (!section || typeof section !== 'object') return null
  return parseIncomeValue(section.household_income) ?? parseIncomeValue(section.annual_income)
}

function hasNeedSignal(sections, incomes) {
  const NEED_LEVELS = new Set(['high', 'critical', 'extreme'])
  for (const s of sections) {
    if (!s || typeof s !== 'object') continue
    if (s.low_income === true || s.low_income === 'yes') return true
    if (s.below_poverty_line === true || s.below_poverty_line === 'yes') return true
    const level = String(s.financial_need_level ?? '').trim().toLowerCase()
    if (NEED_LEVELS.has(level)) return true
  }
  return incomes.some((n) => n !== null && n < 50000)
}

function safeParse(raw) {
  try {
    return typeof raw === 'object' && raw ? raw : JSON.parse(raw || '{}')
  } catch {
    return null
  }
}

async function main() {
  const profiles = await db
    .prepare('SELECT id, display_name, primary_type, applicant_type FROM profiles')
    .all()
  const sections = await db
    .prepare(
      `SELECT profile_id, section_key, data FROM profile_sections
       WHERE section_key IN (?, ?)`,
    )
    .all(CANONICAL, LEGACY)

  const byProfile = new Map()
  for (const row of sections) {
    const data = safeParse(row.data)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    if (!byProfile.has(row.profile_id)) byProfile.set(row.profile_id, {})
    byProfile.get(row.profile_id)[row.section_key] = data
  }

  const conflicts = []
  for (const p of profiles) {
    const pair = byProfile.get(p.id)
    if (!pair) continue
    const canonical = pair[CANONICAL]
    const legacy = pair[LEGACY]
    if (!canonical || !legacy) continue
    const canonicalIncome = sectionIncome(canonical)
    const legacyIncome = sectionIncome(legacy)
    if (canonicalIncome === null || legacyIncome === null) continue
    if (canonicalIncome === legacyIncome) continue

    const rawType = p.applicant_type || p.primary_type
    const individual = isIndividualProfileType(rawType)
    const need = hasNeedSignal([canonical, legacy], [canonicalIncome, legacyIncome])
    conflicts.push({
      profile_id: p.id,
      display_name: p.display_name,
      type: rawType,
      individual,
      need_signal: need,
      financial_information_income: canonicalIncome,
      financial_income: legacyIncome,
      would: !individual
        ? 'SKIP (organization/business — high income legitimate)'
        : need
          ? `AUTO-REPAIR → keep ${Math.min(canonicalIncome, legacyIncome)} (applicant own/lower)`
          : 'FLAG for human review (no need signal — ambiguous)',
    })
  }

  const autoRepair = conflicts.filter((c) => c.individual && c.need_signal)
  const flagged = conflicts.filter((c) => c.individual && !c.need_signal)
  const orgsSkipped = conflicts.filter((c) => !c.individual)

  const report = {
    generated_at: new Date().toISOString(),
    profiles_scanned: profiles.length,
    conflicts_total: conflicts.length,
    auto_repairable_individuals: autoRepair.length,
    flag_for_human_review: flagged.length,
    orgs_skipped: orgsSkipped.length,
    conflicts,
  }
  console.log(JSON.stringify(report, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('audit failed:', err?.message || err)
    process.exit(1)
  })
