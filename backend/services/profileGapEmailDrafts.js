/**
 * profileGapEmailDrafts.js — when a profile has gaps, draft a warm "a few quick
 * questions" email (Annie voice) so the owner can review and send it.
 *
 * SAFETY: like John's outreach, this is DRAFT-ONLY. It never sends. Drafts land in
 * the configured mailbox's Drafts folder (JOHN_PRIMARY_MAILBOX =
 * dr.johnwhite@axiombiolabs.org) for the owner to review and send (or not).
 * Gated by GAP_EMAIL_DRAFTS_ENABLED (default OFF) so nothing is created until the
 * owner turns it on, and idempotent (one open gap-draft per profile).
 */

import { createLogger } from '../utils/logger.js'
import { buildProfileGapPlan } from './profileGapInterview.js'
import { getJohnConfig } from './john/johnOutreachSafety.js'

const log = createLogger('profileGapEmailDrafts')
const KV_PREFIX = 'gap_email_draft:'

export function gapEmailDraftsEnabled() {
  return String(process.env.GAP_EMAIL_DRAFTS_ENABLED ?? 'false').toLowerCase() === 'true'
}

async function ensureKv(db) {
  try { await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run() } catch { /* exists */ }
}
async function kvGet(db, key) {
  try { const r = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key); return r?.value ? JSON.parse(r.value) : null } catch { return null }
}
async function kvSet(db, key, value) {
  const now = new Date().toISOString()
  const v = JSON.stringify({ ...value, at: value.at || now })
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(v, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, v, now)
  }
}

/**
 * draftGapEmailsForIncompleteProfiles — sweep real active profiles; for each that
 * is incomplete AND has a usable (non-admin, non-.invalid) owner email AND has no
 * open gap-draft yet, create a review draft. Injectable deps for tests.
 *
 * @param {object} db
 * @param {object} opts
 * @param {object}  opts.provider        Outlook provider (createDraft). Required to actually create.
 * @param {boolean} [opts.dryRun=false]  count only, create nothing.
 * @param {boolean} [opts.force=false]   bypass the GAP_EMAIL_DRAFTS_ENABLED gate.
 * @param {number}  [opts.limit=200]
 * @param {number}  [opts.minCoverage=0.5]
 * @param {Function}[opts.resolveContacts] override resolveProfileContacts (tests)
 * @param {Function}[opts.normalize]       override normalizeProfile (tests)
 */
export async function draftGapEmailsForIncompleteProfiles(db, {
  provider = null, dryRun = false, force = false, limit = 200, minCoverage = 0.5,
  resolveContacts = null, normalize = null,
} = {}) {
  if (!db?.prepare) return { ok: false, skipped: 'no_db' }
  const enabled = force || gapEmailDraftsEnabled()
  if (!enabled) return { ok: true, enabled: false, scanned: 0, drafted: 0, skipped: { disabled: true } }
  await ensureKv(db)

  const _resolve = resolveContacts || (await import('./comms/commsService.js')).resolveProfileContacts
  const _normalize = normalize || (await import('./profileNormalizer.js')).normalizeProfile

  // profiles has NO state/city/zip columns (location lives in the
  // basic_information section) — the old SELECT threw on every run and the
  // .catch(() => []) fallback made the whole sweep a SILENT no-op.
  let profiles = []
  try {
    profiles = await db.prepare(
      `SELECT p.id, p.display_name, p.primary_type FROM profiles p
        WHERE (p.status='active' OR p.status IS NULL) AND (p.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM profile_sections ps WHERE ps.profile_id=p.id AND ps.section_key='amy_metadata')
        LIMIT ${Number(limit) || 200}`,
    ).all()
  } catch {
    profiles = await db.prepare(`SELECT id, display_name, primary_type FROM profiles WHERE status='active' LIMIT ${Number(limit) || 200}`).all().catch(() => [])
  }

  const summary = { ok: true, enabled: true, dry_run: Boolean(dryRun), scanned: 0, drafted: 0,
    skipped: { complete: 0, no_email: 0, already: 0, error: 0 }, details: [] }

  for (const p of profiles) {
    summary.scanned += 1
    try {
      const rows = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(p.id)
      const sections = {}
      for (const s of rows) { try { sections[s.section_key] = JSON.parse(s.data) } catch { sections[s.section_key] = {} } }
      const normalized = _normalize(p, sections)
      const firstName = String(p.display_name || '').trim().split(/\s+/)[0] || 'there'
      const plan = buildProfileGapPlan(normalized, sections, { displayName: firstName, minCoverage, profile: p })
      if (plan.complete || !plan.email) { summary.skipped.complete += 1; continue }

      const contacts = await _resolve(db, p.id)
      const toEmail = contacts?.primary_email || (contacts?.emails?.[0]?.email ?? null)
      if (!toEmail || contacts?.has_usable_email === false) { summary.skipped.no_email += 1; continue }

      const kvKey = `${KV_PREFIX}${p.id}`
      const prior = await kvGet(db, kvKey)
      if (prior && !dryRun) { summary.skipped.already += 1; continue }

      if (dryRun) { summary.details.push({ profile_id: p.id, would_draft_to: toEmail, subject: plan.email.subject }); summary.drafted += 1; continue }

      if (!provider?.createDraft) { summary.skipped.error += 1; continue }
      const johnConfig = getJohnConfig()
      const res = await provider.createDraft({
        toEmail, toName: contacts?.display_name || p.display_name || null,
        subject: plan.email.subject, bodyText: plan.email.body,
        requestedFromAlias: johnConfig.fromAlias, replyTo: johnConfig.replyTo, displayName: johnConfig.displayName,
      })
      await kvSet(db, kvKey, { draft_id: res?.provider_draft_id || null, to: toEmail })
      summary.drafted += 1
      summary.details.push({ profile_id: p.id, drafted_to: toEmail, draft_id: res?.provider_draft_id || null })
    } catch (err) {
      summary.skipped.error += 1
      log.warn('gap-email draft failed for profile (non-fatal)', { profile: p.id, error: err?.message })
    }
  }
  if (summary.drafted > 0) log.info('gap-email review drafts created', { drafted: summary.drafted, dryRun })
  return summary
}

export default { draftGapEmailsForIncompleteProfiles, gapEmailDraftsEnabled }
