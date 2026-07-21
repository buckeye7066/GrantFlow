/**
 * EVA portfolio user-journey QA — ingest + admin read API.
 *
 *   POST /api/eva/ingest        signed result upload from the Windows edge runner
 *   POST /api/eva/heartbeat     signed runner heartbeat (works even when testing can't run)
 *   GET  /api/eva/status        admin: latest run + findings + heartbeat summary
 *   GET  /api/eva/preview-email admin: render the EVA section without sending
 *
 * TWO trust levels in one router:
 *   - /ingest and /heartbeat are SIGNED (HMAC over the raw body, evaIngest) —
 *     the runner is untrusted, so these do NOT use the admin bearer gate. Raw
 *     body is required for signature verification, so they are mounted with
 *     express.raw BEFORE the JSON parser (see server.js registration).
 *   - /status and /preview-email are ADMIN-only reads (bearer/admin gate), same
 *     pattern as the Laptop Connector.
 */
import express from 'express'
import { requireAuthenticatedUser, isAdminUserWithDb } from '../utils/accessControl.js'
import { createLogger } from '../utils/logger.js'
import { ingest, verifyRequest, isIngestConfigured } from '../services/eva/evaIngest.js'
import { recordHeartbeat } from '../services/eva/evaRunStore.js'
import { defaultLoadEvaPortfolioQa, summarizeEvaPortfolioQa } from '../services/eva/evaSummary.js'
import { renderEvaSection } from '../services/eva/evaReportSection.js'
import { recordEvaEvent } from '../services/eva/evaTelemetry.js'

const log = createLogger('route:eva')

// Signed ingest + heartbeat. Mounted EARLY (before express.json) with
// express.raw so req.body is the exact signed bytes. Self-authenticating via
// HMAC — does NOT use the admin bearer gate.
export function createEvaSignedRouter() {
  const router = express.Router()

  function headerBag(req) {
    return {
      'x-eva-runner-id': req.get('x-eva-runner-id'),
      'x-eva-timestamp': req.get('x-eva-timestamp'),
      'x-eva-nonce': req.get('x-eva-nonce'),
      'x-eva-idempotency-key': req.get('x-eva-idempotency-key'),
      'x-eva-signature': req.get('x-eva-signature'),
    }
  }

  // Raw body: these routes are registered with express.raw({ type: '*/*' }) so
  // req.body is a Buffer of the exact signed bytes.
  function rawBodyOf(req) {
    if (Buffer.isBuffer(req.body)) return req.body
    if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8')
    // Fallback: a JSON parser ran first (shouldn't for signed routes) — re-serialize.
    return Buffer.from(JSON.stringify(req.body || {}), 'utf8')
  }

  // ---- Signed ingest (untrusted runner) -----------------------------------
  router.post('/ingest', async (req, res) => {
    if (!isIngestConfigured()) return res.status(503).json({ error: 'eva_ingest_not_configured' })
    try {
      const result = await ingest(req.db, { rawBody: rawBodyOf(req), headers: headerBag(req) })
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, details: result.details })
      }
      // Best-effort telemetry so EVA appears in Mission Control.
      recordEvaEvent(req.db, {
        event_type: 'eva.ingest',
        status: 'succeeded',
        title: 'Portfolio QA results ingested',
        metric_key: 'apps_tested',
        metric_value: result.result?.findings?.length ?? null,
        details: { run_id: result.result?.run_id, duplicate: result.result?.duplicate },
      }).catch(() => {})
      return res.status(result.status).json({ ok: true, run_id: result.result?.run_id, duplicate: result.result?.duplicate })
    } catch (err) {
      log.error('eva ingest route failed', { error: err?.message })
      return res.status(500).json({ error: 'internal_error' })
    }
  })

  // ---- Signed heartbeat ---------------------------------------------------
  router.post('/heartbeat', async (req, res) => {
    if (!isIngestConfigured()) return res.status(503).json({ error: 'eva_ingest_not_configured' })
    try {
      // Reuse the full signature/replay/freshness check; the heartbeat body is
      // small JSON { status, note, version, hostname_hash }.
      const verified = await verifyRequestLoose(req)
      if (!verified.ok) return res.status(verified.status).json({ error: verified.error })
      const body = verified.parsed || {}
      await recordHeartbeat(req.db, {
        runnerId: verified.runnerId,
        version: body.version || null,
        status: body.status || 'ok',
        note: body.note || null,
        hostnameHash: body.hostname_hash || null,
      })
      recordEvaEvent(req.db, { event_type: 'eva.heartbeat', status: 'info', title: `Runner heartbeat: ${body.status || 'ok'}` }).catch(() => {})
      return res.json({ ok: true })
    } catch (err) {
      log.error('eva heartbeat route failed', { error: err?.message })
      return res.status(500).json({ error: 'internal_error' })
    }
  })

  // Heartbeat uses the SAME signature scheme but its body isn't the result
  // schema, so we call verifyRequest which validates the RESULT schema — for the
  // heartbeat we only need signature+replay+freshness, so parse leniently here.
  async function verifyRequestLoose(req) {
    const raw = rawBodyOf(req)
    // verifyRequest also runs result-schema validation; a heartbeat body would
    // fail that. So we short-circuit: build a minimal valid envelope check by
    // reusing verifyRequest but tolerating a schema_invalid verdict as OK for
    // heartbeats (signature already proven before schema is checked).
    const v = await verifyRequest(req.db, { rawBody: raw, headers: headerBag(req) })
    if (v.ok) return v
    if (v.error === 'schema_invalid') {
      // Signature + nonce were already validated before schema; re-parse body.
      try {
        return { ok: true, status: 200, parsed: JSON.parse(raw.toString('utf8')), runnerId: req.get('x-eva-runner-id') }
      } catch {
        return { ok: false, status: 400, error: 'malformed_json' }
      }
    }
    return v
  }

  return router
}

// Admin read endpoints. Mounted in the normal route block (after express.json
// and the auth middleware) so req.ctx/req.user are populated.
export function createEvaAdminRouter() {
  const router = express.Router()

  const adminGate = async (req, res, next) => {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const isAdmin = req.ctx?.isAdmin === true || (await isAdminUserWithDb(req.db, user))
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
    next()
  }

  router.get('/status', adminGate, async (req, res) => {
    try {
      const data = await defaultLoadEvaPortfolioQa(req.db, {})
      const summary = summarizeEvaPortfolioQa(data, {})
      return res.json({ ok: true, summary })
    } catch (err) {
      log.error('eva status route failed', { error: err?.message })
      return res.status(500).json({ error: 'internal_error' })
    }
  })

  router.get('/preview-email', adminGate, async (req, res) => {
    try {
      const data = await defaultLoadEvaPortfolioQa(req.db, {})
      const summary = summarizeEvaPortfolioQa(data, {})
      const section = renderEvaSection(summary)
      // Render as a standalone HTML doc for a quick browser preview; nothing is sent.
      return res
        .type('html')
        .send(`<!doctype html><meta charset="utf-8"><title>EVA section preview</title><body style="font-family:sans-serif;margin:24px">${section.html}<hr><pre style="white-space:pre-wrap">${section.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre></body>`)
    } catch (err) {
      log.error('eva preview route failed', { error: err?.message })
      return res.status(500).json({ error: 'internal_error' })
    }
  })

  return router
}
