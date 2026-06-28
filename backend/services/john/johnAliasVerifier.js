/**
 * John — alias verifier.
 *
 * Steps:
 *   1. Verify the configured primary mailbox exists in Microsoft Graph.
 *   2. Verify a from-alias is configured.
 *   3. Create a small test draft addressed to JOHN_TEST_RECIPIENT, asking
 *      Graph to set the From alias. Record whether Graph accepted it.
 *   4. Persist the result via johnRunStore.recordAliasCheck().
 *
 * The verifier never sends. The test draft is created in the Drafts folder
 * of the primary mailbox so Dr. White can see exactly what Graph produced.
 *
 * Inputs are injected so unit tests can pass a fake provider without
 * touching the network.
 */

import { getJohnConfig, maskSecrets } from './johnOutreachSafety.js'
import { recordAliasCheck } from './johnRunStore.js'
import { makeAliasReport } from './johnTypes.js'
import { createOutlookProvider } from './johnOutlookProvider.js'

export async function verifyAlias({
  db,
  provider,
  config = getJohnConfig(),
  logger = console,
} = {}) {
  const p = provider || createOutlookProvider({ config, logger })
  const aliasReport = makeAliasReport({
    requested_from_alias: config.fromAlias || null,
    reply_to: config.replyTo || null,
  })
  const details = { steps: [] }
  let testProviderId = null
  let errorString = null

  try {
    if (!p.ready) {
      details.provider = { configured: false, missing: p.missing }
      details.steps.push({ step: 'provider_ready', ok: false, missing: p.missing })
      const detailsClean = maskSecrets(details)
      if (db) {
        await recordAliasCheck(db, {
          primary_mailbox: config.primaryMailbox,
          from_alias: config.fromAlias,
          alias_verified: false,
          alias_send_supported: false,
          test_draft_provider_id: null,
          details_json: detailsClean,
          error: `provider_not_configured (${p.missing})`,
        })
      }
      return {
        ok: false,
        reason: 'provider_not_configured',
        missing: p.missing,
        report: aliasReport,
      }
    }

    const mailbox = await p.verifyMailbox()
    details.steps.push({ step: 'verify_mailbox', ok: !!mailbox.ok, ...mailbox })
    if (!mailbox.ok) {
      const detailsClean = maskSecrets(details)
      // Surface the provider's honest reason instead of collapsing every
      // non-200 to "mailbox_not_found": a 403 is insufficient Graph privileges
      // (the app has Mail.ReadWrite but not directory read), NOT a missing
      // mailbox — mislabeling it sent operators down the wrong path.
      const reason = mailbox.reason || 'mailbox_not_found'
      if (db) {
        await recordAliasCheck(db, {
          primary_mailbox: config.primaryMailbox,
          from_alias: config.fromAlias,
          alias_verified: false,
          alias_send_supported: false,
          test_draft_provider_id: null,
          details_json: detailsClean,
          error: reason,
        })
      }
      return { ok: false, reason, report: aliasReport }
    }

    if (!config.fromAlias) {
      details.steps.push({ step: 'alias_configured', ok: false, reason: 'JOHN_FROM_ALIAS not set' })
      const detailsClean = maskSecrets(details)
      if (db) {
        await recordAliasCheck(db, {
          primary_mailbox: config.primaryMailbox,
          from_alias: null,
          alias_verified: false,
          alias_send_supported: false,
          test_draft_provider_id: null,
          details_json: detailsClean,
          error: 'alias_not_configured',
        })
      }
      return { ok: false, reason: 'alias_not_configured', report: aliasReport }
    }

    const draft = await p.createDraft({
      toEmail: config.testRecipient || config.primaryMailbox,
      toName: 'GrantFlow Alias Verification',
      subject: 'Ellie alias verification (test draft, do not send)',
      bodyText:
        'This is an automated test draft created by John to verify the From alias configuration. Do not send.\n\nIf you received this in your sent folder, that means John attempted to set the From alias and Microsoft Graph accepted it.',
      requestedFromAlias: config.fromAlias,
      replyTo: config.replyTo,
      displayName: config.displayName,
    })
    testProviderId = draft.provider_draft_id
    details.steps.push({
      step: 'create_test_draft',
      ok: true,
      alias_attempted: draft.alias_attempted,
      alias_set: draft.alias_set,
      provider_draft_id: testProviderId,
      actual_from: draft.actual_from || null,
    })

    aliasReport.alias_verified = true
    aliasReport.alias_send_supported = !!draft.alias_set
    aliasReport.actual_from = draft.actual_from || null
    aliasReport.fallback_used = !draft.alias_set
    aliasReport.needs_sender_alias_review =
      !draft.alias_set && config.requireAliasReviewIfFallback === true

    const detailsClean = maskSecrets(details)
    if (db) {
      await recordAliasCheck(db, {
        primary_mailbox: config.primaryMailbox,
        from_alias: config.fromAlias,
        alias_verified: true,
        alias_send_supported: !!draft.alias_set,
        test_draft_provider_id: testProviderId,
        details_json: detailsClean,
        error: null,
      })
    }
    return {
      ok: true,
      alias_send_supported: !!draft.alias_set,
      report: aliasReport,
      test_draft_provider_id: testProviderId,
      details: detailsClean,
    }
  } catch (err) {
    errorString = err?.message || String(err)
    logger?.warn?.('[John] alias verification failed', { error: errorString })
    const detailsClean = maskSecrets({ ...details, error: errorString })
    if (db) {
      try {
        await recordAliasCheck(db, {
          primary_mailbox: config.primaryMailbox,
          from_alias: config.fromAlias,
          alias_verified: false,
          alias_send_supported: false,
          test_draft_provider_id: testProviderId,
          details_json: detailsClean,
          error: errorString,
        })
      } catch { /* ignore audit-write failures */ }
    }
    return {
      ok: false,
      reason: 'verification_failed',
      error: errorString,
      report: aliasReport,
    }
  }
}
