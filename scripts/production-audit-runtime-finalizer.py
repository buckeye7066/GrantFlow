from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} changed ({count} matches); refusing an unsafe patch")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# 1. Anya failure fallback must not change the hook count.
# ---------------------------------------------------------------------------
anya_path = Path("src/components/anya/AnyaChat.jsx")
anya = anya_path.read_text(encoding="utf-8")
unavailable = '''  if (isUnavailable) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/70 p-4 text-sm text-slate-700 dark:text-slate-300 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full overflow-hidden bg-gradient-to-br from-purple-600 to-blue-600">
            <img src="/images/anya-avatar.svg" alt="Anya" className="h-full w-full object-cover" />
          </div>
          <div className="font-semibold text-slate-800 dark:text-slate-100">Anya is temporarily unavailable</div>
        </div>
        <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          The core app is still working; we’re restoring Anya’s services in the background. Refresh in a minute.
        </div>
      </div>
    )
  }

'''
anya = replace_once(
    anya,
    unavailable,
    "",
    "Anya unavailable block",
)
final_return = '''  const isTaskFormDisabled = !sessionId || isLoading || isSavingTask

  return (
'''
moved = '''  const isTaskFormDisabled = !sessionId || isLoading || isSavingTask

  // React hooks must run in the same order on every render. Bootstrap or tool
  // failures can flip isUnavailable after the initial render; the old early
  // return sat above later hooks and triggered React invariant 300 (rendered
  // fewer hooks than expected), taking the Dashboard down with it.
''' + unavailable + '''  return (
'''
anya = replace_once(anya, final_return, moved, "Anya final return marker")
anya_path.write_text(anya, encoding="utf-8")


# ---------------------------------------------------------------------------
# 2. Historical unauthenticated portal scans are public signals only.
# ---------------------------------------------------------------------------
portal_path = Path("backend/services/portalCheckService.js")
portal = portal_path.read_text(encoding="utf-8")
status_heading = '''// ---------------------------------------------------------------------------
// Get last check info for each portal (used by frontend)
// ---------------------------------------------------------------------------
'''
helper = '''/**
 * Reclassify a public portal-check row for owner-facing display.
 *
 * portal_check_results comes exclusively from unauthenticated landing-page
 * reads. Historical versions promoted award-shaped marketing language and the
 * largest public dollar figure into a personal award. A personal award may now
 * be shown only when independently persisted on the owner's university
 * application. Otherwise, the old values survive only as public signals.
 */
export function sanitizePublicPortalCheckResult(row = {}, parsed = {}, mergedAward = null) {
  const updateType = String(parsed?.updateType ?? parsed?.update_type ?? '').trim().toLowerCase()
  const legacyClaim = Number(row?.awards_detected ?? 0) > 0 || updateType === 'scholarship_award'
  const rawAmount = parsed?.awardAmount ?? parsed?.award_amount ?? null
  const rawAmountText = parsed?.awardAmountRaw ?? parsed?.award_amount_raw ?? null
  const hasAmount = rawAmount !== null && rawAmount !== undefined && rawAmount !== ''
  const numericAmount = hasAmount && Number.isFinite(Number(rawAmount)) ? Number(rawAmount) : null
  const existingSignals = parsed?.publicSignals ?? parsed?.public_signals ?? null
  const publicSignals = existingSignals ?? (legacyClaim
    ? {
        has_award_language: true,
        advertised_amount: numericAmount,
        advertised_amount_raw: rawAmountText ? String(rawAmountText) : null,
        legacy_reclassified: true,
      }
    : null)

  return {
    // The checker itself never detected a personal award. An owner-confirmed
    // merge is represented separately by merged_to_profile.
    awards_detected: 0,
    award_name: mergedAward?.award_name ?? null,
    award_amount: mergedAward?.award_amount ?? null,
    award_amount_raw: mergedAward?.award_amount_raw ?? null,
    update_type: mergedAward ? 'owner_merged_award' : null,
    public_signals: publicSignals,
  }
}

'''
portal = replace_once(
    portal,
    status_heading,
    helper + status_heading,
    "Portal status heading",
)
old_map = '''    return latestRows.map((row) => {
      const parsed = row?.results_json ? tryParse(row.results_json) : {}
      const mergedAward = mergedAwards.find((award) => portalAwardsMatch(award, parsed)) || null
      const applicationId = String(parsed?.applicationId ?? parsed?.application_id ?? '').trim() || null
      return {
        id: row?.id ?? null,
        portal_name: row?.portal_name ?? parsed?.portalName ?? null,
        portal_url: row?.portal_url ?? parsed?.portalUrl ?? null,
        awards_detected: row?.awards_detected ?? 0,
        checked_at: row?.checked_at ?? null,
        application_id: applicationId,
        application_name: applicationId ? appNameById.get(applicationId) ?? null : null,
        award_name: parsed?.awardName ?? null,
        award_amount: parsed?.awardAmount ?? null,
        award_amount_raw: parsed?.awardAmountRaw ?? null,
        detected_at: parsed?.detectedAt ?? row?.checked_at ?? null,
        update_type: parsed?.updateType ?? null,
        error: parsed?.error ?? null,
        merged_to_profile: Boolean(mergedAward),
        merged_application_id: mergedAward?.application_id ?? null,
        merged_application_name: mergedAward?.application_name ?? null,
      }
    })
'''
new_map = '''    return latestRows.map((row) => {
      const parsed = row?.results_json ? tryParse(row.results_json) : {}
      const portalIdentity = {
        ...parsed,
        portalName: parsed?.portalName ?? parsed?.portal_name ?? row?.portal_name ?? null,
        portalUrl: parsed?.portalUrl ?? parsed?.portal_url ?? row?.portal_url ?? null,
      }
      const mergedAward = mergedAwards.find((award) => portalAwardsMatch(award, portalIdentity)) || null
      const applicationId = String(parsed?.applicationId ?? parsed?.application_id ?? '').trim() || null
      const safeStatus = sanitizePublicPortalCheckResult(row, parsed, mergedAward)
      return {
        id: row?.id ?? null,
        portal_name: row?.portal_name ?? parsed?.portalName ?? null,
        portal_url: row?.portal_url ?? parsed?.portalUrl ?? null,
        awards_detected: safeStatus.awards_detected,
        checked_at: row?.checked_at ?? null,
        application_id: applicationId,
        application_name: applicationId ? appNameById.get(applicationId) ?? null : null,
        award_name: safeStatus.award_name,
        award_amount: safeStatus.award_amount,
        award_amount_raw: safeStatus.award_amount_raw,
        detected_at: mergedAward?.detected_at ?? parsed?.detectedAt ?? row?.checked_at ?? null,
        update_type: safeStatus.update_type,
        public_signals: safeStatus.public_signals,
        error: parsed?.error ?? null,
        merged_to_profile: Boolean(mergedAward),
        merged_application_id: mergedAward?.application_id ?? null,
        merged_application_name: mergedAward?.application_name ?? null,
      }
    })
'''
portal = replace_once(portal, old_map, new_map, "Portal status mapping")
portal_path.write_text(portal, encoding="utf-8")


# ---------------------------------------------------------------------------
# 3. Repair the legacy rows themselves at the startup/self-heal choke point.
# ---------------------------------------------------------------------------
ensure_path = Path("backend/utils/ensurePortalCheckResultsTable.js")
ensure_path.write_text(
    '''async function repairLegacyPublicAwardClaims(db) {
  let rows = []
  try {
    rows = await db
      .prepare(`SELECT id, awards_detected, results_json
                  FROM portal_check_results
                 WHERE COALESCE(awards_detected, 0) <> 0`)
      .all()
  } catch {
    return 0
  }

  let repaired = 0
  for (const row of rows || []) {
    let parsed = {}
    try {
      parsed = row?.results_json
        ? (typeof row.results_json === 'string' ? JSON.parse(row.results_json) : row.results_json)
        : {}
    } catch {
      parsed = {}
    }

    const rawAmount = parsed?.awardAmount ?? parsed?.award_amount ?? null
    const rawAmountText = parsed?.awardAmountRaw ?? parsed?.award_amount_raw ?? null
    const hasAmount = rawAmount !== null && rawAmount !== undefined && rawAmount !== ''
    const numericAmount = hasAmount && Number.isFinite(Number(rawAmount)) ? Number(rawAmount) : null
    const publicSignals = parsed?.publicSignals ?? parsed?.public_signals ?? {
      has_award_language: true,
      advertised_amount: numericAmount,
      advertised_amount_raw: rawAmountText ? String(rawAmountText) : null,
      legacy_reclassified: true,
    }
    const next = {
      ...parsed,
      updateType: null,
      update_type: null,
      awardName: null,
      award_name: null,
      awardAmount: null,
      award_amount: null,
      awardAmountRaw: null,
      award_amount_raw: null,
      publicSignals,
    }

    try {
      const result = await db
        .prepare('UPDATE portal_check_results SET awards_detected = 0, results_json = ? WHERE id = ?')
        .run(JSON.stringify(next), row.id)
      repaired += Number(result?.changes ?? result?.rowCount ?? 0) || 1
    } catch {
      // A malformed historical row must never prevent schema startup.
    }
  }

  if (repaired > 0) {
    console.info('[portal-check] reclassified legacy public award claims as signals', { repaired })
  }
  return repaired
}

export default async function ensurePortalCheckResultsTable(db) {
  if (!db) return

  if (db?.dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS portal_check_results (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        portal_name TEXT NOT NULL,
        portal_url TEXT,
        check_type TEXT DEFAULT 'scheduled',
        status TEXT DEFAULT 'completed',
        awards_detected INTEGER DEFAULT 0,
        results_json TEXT,
        checked_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_profile_id ON portal_check_results(profile_id);
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_checked_at ON portal_check_results(checked_at);
    `)
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS portal_check_results (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        portal_name TEXT NOT NULL,
        portal_url TEXT,
        check_type TEXT DEFAULT 'scheduled',
        status TEXT DEFAULT 'completed',
        awards_detected INTEGER DEFAULT 0,
        results_json TEXT,
        checked_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_profile_id ON portal_check_results(profile_id);
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_checked_at ON portal_check_results(checked_at);
    `)
  }

  // Called from startup self-heal and before every portal status/check operation.
  // Idempotent: after one repair pass, later calls are a cheap no-op.
  await repairLegacyPublicAwardClaims(db)
}
''',
    encoding="utf-8",
)


# ---------------------------------------------------------------------------
# 4. Regression tripwire for the Dashboard hook-order crash.
# ---------------------------------------------------------------------------
hook_test = Path("tests/unit/anya-chat-hook-order.test.mjs")
hook_test.write_text(
    '''import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../../src/components/anya/AnyaChat.jsx', import.meta.url), 'utf8')
const start = source.indexOf('export default function AnyaChat')
const body = source.slice(start)

test('Anya unavailable fallback occurs after every hook', () => {
  assert.ok(start >= 0, 'AnyaChat component must exist')
  const guard = body.indexOf('if (isUnavailable)')
  assert.ok(guard >= 0, 'unavailable fallback must exist')
  assert.equal(body.indexOf('if (isUnavailable)', guard + 1), -1, 'fallback guard must be unique')

  const hooks = [...body.matchAll(/\\buse[A-Z][A-Za-z0-9]*\\s*\\(/g)]
  assert.ok(hooks.length > 0, 'expected hooks in AnyaChat')
  const lastHook = Math.max(...hooks.map((match) => match.index))
  assert.ok(
    guard > lastHook,
    `isUnavailable returned before a later hook (guard=${guard}, lastHook=${lastHook})`,
  )

  const ensureSession = body.indexOf('const ensureSession = useCallback')
  assert.ok(ensureSession >= 0 && ensureSession < guard, 'ensureSession hook must run before fallback')
})
''',
    encoding="utf-8",
)


# ---------------------------------------------------------------------------
# 5. Regression tests for historical public-award reclassification.
# ---------------------------------------------------------------------------
portal_test = Path("backend/tests/portalCheckLegacyHonesty.test.js")
portal_test.write_text(
    '''import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import ensurePortalCheckResultsTable from '../utils/ensurePortalCheckResultsTable.js'
import {
  getPortalCheckStatus,
  sanitizePublicPortalCheckResult,
} from '../services/portalCheckService.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  return db
}

describe('legacy public portal-award honesty', () => {
  it('never presents an unauthenticated public-page claim as a personal award', () => {
    const safe = sanitizePublicPortalCheckResult(
      { awards_detected: 274 },
      {
        updateType: 'scholarship_award',
        awardName: 'Advertised scholarship',
        awardAmount: 5000,
        awardAmountRaw: '$5,000',
      },
      null,
    )

    expect(safe).toMatchObject({
      awards_detected: 0,
      award_name: null,
      award_amount: null,
      award_amount_raw: null,
      update_type: null,
      public_signals: {
        has_award_language: true,
        advertised_amount: 5000,
        advertised_amount_raw: '$5,000',
        legacy_reclassified: true,
      },
    })
  })

  it('repairs stored legacy counts and scrubs personal-award fields', async () => {
    const db = makeDb()
    try {
      await ensurePortalCheckResultsTable(db)
      db.prepare(`
        INSERT INTO portal_check_results
          (id, profile_id, portal_name, portal_url, status, awards_detected, results_json, checked_at)
        VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
      `).run(
        'legacy-1',
        'profile-1',
        'Public scholarship landing page',
        'https://example.test/scholarships',
        274,
        JSON.stringify({
          portalName: 'Public scholarship landing page',
          portalUrl: 'https://example.test/scholarships',
          updateType: 'scholarship_award',
          awardName: 'Advertised scholarship',
          awardAmount: 5000,
          awardAmountRaw: '$5,000',
        }),
        '2026-07-28T00:00:00.000Z',
      )

      await ensurePortalCheckResultsTable(db)
      const stored = db.prepare('SELECT awards_detected, results_json FROM portal_check_results WHERE id = ?').get('legacy-1')
      const parsed = JSON.parse(stored.results_json)
      expect(stored.awards_detected).toBe(0)
      expect(parsed.updateType).toBeNull()
      expect(parsed.awardName).toBeNull()
      expect(parsed.awardAmount).toBeNull()
      expect(parsed.publicSignals).toMatchObject({
        advertised_amount: 5000,
        advertised_amount_raw: '$5,000',
        legacy_reclassified: true,
      })

      const status = await getPortalCheckStatus(db, 'profile-1')
      expect(status).toHaveLength(1)
      expect(status[0]).toMatchObject({
        awards_detected: 0,
        award_name: null,
        award_amount: null,
        update_type: null,
        merged_to_profile: false,
      })
    } finally {
      db.close()
    }
  })

  it('shows award details only from an owner-persisted merged award', () => {
    const safe = sanitizePublicPortalCheckResult(
      { awards_detected: 99 },
      { updateType: 'scholarship_award', awardAmount: 999999 },
      {
        award_name: 'Owner-confirmed scholarship',
        award_amount: 2500,
        award_amount_raw: '$2,500',
      },
    )
    expect(safe).toMatchObject({
      awards_detected: 0,
      award_name: 'Owner-confirmed scholarship',
      award_amount: 2500,
      award_amount_raw: '$2,500',
      update_type: 'owner_merged_award',
    })
  })
})
''',
    encoding="utf-8",
)

print("Applied Dashboard hook-order and legacy portal-award corrections")
