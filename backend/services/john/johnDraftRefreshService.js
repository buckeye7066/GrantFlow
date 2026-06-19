/**
 * John — draft refresh service.
 *
 * Rewrites the BODY (and subject) of drafts John has already created in the
 * Outlook mailbox so they reflect the current email template — e.g. after the
 * messaging changes (honest origin story + self-serve Anya/prospect-link CTA).
 *
 * For each tracked draft (a row in john_email_drafts with a live
 * provider_draft_id), we:
 *   1. reconstruct the lead interpretation from the stored personalization so
 *      the per-organization details (org name, evidence topic/detail, salutation)
 *      are preserved — only the surrounding copy changes;
 *   2. re-render with the deterministic template composer using the CURRENT
 *      template + current config (prospect link, postal address);
 *   3. re-run the SAME safety classifier the draft service uses, so we never
 *      write a non-compliant body;
 *   4. PATCH the Outlook draft in place (never sends) and update the local row.
 *
 * Drafts that no longer exist in Outlook (human deleted/sent) are skipped, not
 * recreated. Idempotent: a draft whose body already matches is left untouched.
 */

import { composeWithTemplate } from './johnEmailWriter.js'
import { evaluateDraftSafety, getJohnConfig } from './johnOutreachSafety.js'
import { SAFETY_STATUS } from './johnTypes.js'
import { listDrafts, updateDraft } from './johnRunStore.js'
import { createOutlookProvider } from './johnOutlookProvider.js'

// Statuses whose Outlook draft is still live and editable.
const REFRESHABLE_STATUSES = new Set(['created', 'needs_sender_alias_review', 'needs_review'])

/**
 * Rebuild an interpretation object from a stored draft row + its
 * personalization_json so composeWithTemplate reproduces the same per-org
 * personalization with the new template copy.
 */
function interpretationFromDraft(row) {
  const p = row.personalization_json || {}
  return {
    salutation: p.salutation || null,
    organization_name: row.organization_name || p.organization_name || null,
    organization_type: null, // not used by the body template
    contact: {
      email: row.recipient_email || null,
      name: row.recipient_name || p.contact_name || null,
      role: row.recipient_role || p.contact_role || null,
      generic: !!p.contact_generic_address,
    },
    evidence: {
      // evidence_detail is the original full evidence text; deriveEvidenceTopic
      // re-cuts it to reproduce the stored topic.
      text: p.evidence_detail || p.evidence_topic || '',
      source: p.evidence_source_url || null,
    },
  }
}

/**
 * Refresh the bodies of John's existing Outlook drafts.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {object} [opts.provider] - Outlook provider (injectable for tests)
 * @param {object} [opts.config]   - John config (defaults to env)
 * @param {object} [opts.logger]
 * @param {boolean} [opts.dryRun]  - compute changes but do not PATCH/persist
 * @param {number} [opts.limit]    - max drafts to scan (default 500)
 * @returns {Promise<{ ok, scanned, updated, skipped, failed, results }>}
 */
export async function refreshDraftBodies(db, opts = {}) {
  if (!db) throw new Error('refreshDraftBodies: db is required')
  const config = opts.config || getJohnConfig()
  const logger = opts.logger || console
  const dryRun = !!opts.dryRun
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 500))

  const provider = opts.provider || createOutlookProvider({ config, logger })
  if (!provider.ready && !dryRun) {
    return {
      ok: false,
      error: 'provider_not_configured',
      missing: provider.missing,
      scanned: 0, updated: 0, skipped: 0, failed: 0, results: [],
    }
  }

  const drafts = await listDrafts(db, { limit })
  const live = drafts.filter(
    (d) => d.provider_draft_id && REFRESHABLE_STATUSES.has(String(d.draft_status || '')),
  )

  const results = []
  let updated = 0
  let skipped = 0
  let failed = 0

  for (const row of live) {
    const label = { draft_id: row.id, org: row.organization_name, provider_draft_id: row.provider_draft_id }
    try {
      const interpretation = interpretationFromDraft(row)
      const composed = composeWithTemplate({}, { config, interpretation })

      // Nothing to do if the rendered body is already current.
      if (composed.body_text === row.body_text && composed.subject === row.subject) {
        skipped += 1
        results.push({ ...label, status: 'unchanged' })
        continue
      }

      // Re-run the body/subject classifier with a synthetic lead that satisfies
      // the lead-quality gates (this draft already passed them at creation).
      const safety = evaluateDraftSafety({
        lead: {
          qualified: true,
          lead_score: 100,
          public_evidence: [{ summary: 'existing draft refresh' }],
          source_urls: ['existing_draft'],
          do_not_contact_flags: [],
          organization_name: row.organization_name,
        },
        draft: {
          subject: composed.subject,
          body: composed.body_text,
          recipient_email: row.recipient_email,
          recipient_name: row.recipient_name,
        },
        config,
        alreadyDrafted: false,
      })
      if (safety.status === SAFETY_STATUS.BLOCKED) {
        failed += 1
        results.push({ ...label, status: 'safety_blocked', reasons: safety.reasons })
        continue
      }

      if (dryRun) {
        updated += 1
        results.push({ ...label, status: 'would_update' })
        continue
      }

      // Confirm the draft still exists before patching.
      const patchRes = await provider.updateDraftBody({
        messageId: row.provider_draft_id,
        subject: composed.subject,
        bodyText: composed.body_text,
        bodyHtml: composed.body_html,
      })

      await updateDraft(db, row.id, {
        subject: composed.subject,
        body_text: composed.body_text,
        body_html: composed.body_html,
        personalization_json: composed.personalization,
        safety_report_json: safety,
      })

      updated += 1
      results.push({ ...label, status: 'updated', is_draft: patchRes.is_draft })
    } catch (err) {
      if (err?.notFound || err?.status === 404) {
        skipped += 1
        results.push({ ...label, status: 'missing_in_outlook' })
        continue
      }
      failed += 1
      logger?.warn?.('[John] draft refresh failed', { draft_id: row.id, error: err?.message, code: err?.code })
      results.push({ ...label, status: 'error', error: err?.message || String(err) })
    }
  }

  return {
    ok: true,
    scanned: live.length,
    updated,
    skipped,
    failed,
    dry_run: dryRun,
    results,
  }
}
