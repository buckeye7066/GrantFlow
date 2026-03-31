import express from 'express'
import crypto from 'crypto'
import { standardRateLimiter, mutationRateLimiter } from '../middleware/rateLimiting.js'

const router = express.Router()

router.use(standardRateLimiter)

const ALLOWED_ACTIONS = new Set(['accept', 'reject', 'correct', 'escalate'])

function getActorUserId(req) {
  const raw = req.ctx?.userId || req.user?.userId || null
  return raw ? String(raw).trim() : null
}

function isAdmin(req) {
  return Boolean(req.ctx?.isAdmin || req.user?.is_admin === true || req.user?.role === 'admin')
}

function parseStoredJson(value) {
  if (value == null) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toStoredJson(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ value: String(value) })
  }
}

function validateConfidence(value) {
  if (value == null || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    throw new Error('Confidence must be between 0 and 1')
  }
  return num
}

async function ensureReviewsTable(db) {
  const createTableSql = db?.dialect === 'postgres'
    ? `
        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          reviewer_user_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'correct', 'escalate')),
          prior_value TEXT,
          new_value TEXT,
          reason_code TEXT NOT NULL,
          evidence_url TEXT NOT NULL,
          confidence REAL,
          metadata TEXT DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_reviews_item_id ON reviews(item_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_user_id ON reviews(reviewer_user_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at);
      `
    : `
        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          reviewer_user_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'correct', 'escalate')),
          prior_value TEXT,
          new_value TEXT,
          reason_code TEXT NOT NULL,
          evidence_url TEXT NOT NULL,
          confidence REAL,
          metadata TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_reviews_item_id ON reviews(item_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_user_id ON reviews(reviewer_user_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at);
      `

  await db.exec(createTableSql)
}

function mapReviewRow(row) {
  if (!row) return null
  return {
    id: row.id,
    item_id: row.item_id,
    reviewer_user_id: row.reviewer_user_id,
    action: row.action,
    prior_value: parseStoredJson(row.prior_value),
    new_value: parseStoredJson(row.new_value),
    reason_code: row.reason_code,
    evidence_url: row.evidence_url,
    confidence: row.confidence == null ? null : Number(row.confidence),
    metadata: parseStoredJson(row.metadata) || {},
    created_at: row.created_at,
  }
}

function requireAuthenticatedUser(req, res) {
  const actorUserId = getActorUserId(req)
  if (!actorUserId) {
    res.status(401).json({ success: false, error: 'Authentication required' })
    return null
  }
  return actorUserId
}

router.get('/export/training', async (req, res) => {
  const actorUserId = requireAuthenticatedUser(req, res)
  if (!actorUserId) return
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Admin access required' })
  }

  try {
    await ensureReviewsTable(req.db)
    const limit = Math.max(1, Math.min(Number(req.query?.limit || 1000), 5000))
    const rows = await req.db
      .prepare(
        `
          SELECT id, item_id, reviewer_user_id, action, new_value, reason_code, evidence_url, confidence, metadata, created_at
          FROM reviews
          WHERE action = 'correct'
            AND new_value IS NOT NULL
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(limit)

    const lines = rows.map((row) => {
      const metadata = parseStoredJson(row.metadata) || {}
      return JSON.stringify({
        review_id: row.id,
        item_id: row.item_id,
        reviewer_user_id: row.reviewer_user_id,
        corrected_value: parseStoredJson(row.new_value),
        reason_code: row.reason_code,
        evidence_url: row.evidence_url,
        reviewer_confidence: row.confidence == null ? null : Number(row.confidence),
        labelsource: 'human',
        metadata,
        created_at: row.created_at,
      })
    })

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.send(lines.join('\n'))
  } catch (error) {
    console.error('[reviews] Failed to export training data:', error)
    res.status(500).json({ success: false, error: 'Failed to export training data' })
  }
})

router.get('/', async (req, res) => {
  const actorUserId = requireAuthenticatedUser(req, res)
  if (!actorUserId) return

  try {
    await ensureReviewsTable(req.db)
    const admin = isAdmin(req)
    const onlyMine = String(req.query?.only_mine || '').trim().toLowerCase() === 'true'
    const itemId = String(req.query?.item_id || '').trim() || null
    const limit = Math.max(1, Math.min(Number(req.query?.limit || 50), 200))

    let rows = []
    if (admin && !onlyMine && itemId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(itemId)) {
  return res.status(400).json({ success: false, error: 'Invalid item_id format' })
}
      rows = await req.db
        .prepare(
          `
            SELECT *
            FROM reviews
            WHERE item_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(itemId, limit)
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(itemId, limit)
    } else if (admin && !onlyMine) {
      rows = await req.db
        .prepare(
          `
            SELECT *
            FROM reviews
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(limit)
    } else if (itemId) {
      rows = await req.db
        .prepare(
          `
            SELECT *
            FROM reviews
            WHERE reviewer_user_id = ?
              AND item_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(actorUserId, itemId, limit)
    } else {
      rows = await req.db
        .prepare(
          `
            SELECT *
            FROM reviews
            WHERE reviewer_user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(actorUserId, limit)
    }

    res.json({
      success: true,
      reviews: rows.map(mapReviewRow),
    })
  } catch (error) {
    console.error('[reviews] Failed to list reviews:', error)
    res.status(500).json({ success: false, error: 'Failed to list reviews' })
  }
})

router.post('/', mutationRateLimiter, async (req, res) => {
  const actorUserId = requireAuthenticatedUser(req, res)
  if (!actorUserId) return

  try {
    await ensureReviewsTable(req.db)

    const itemId = String(req.body?.item_id || '').trim()
    const action = String(req.body?.action || '').trim().toLowerCase()
    const reasonCode = String(req.body?.reason_code || '').trim()
    const evidenceUrl = String(req.body?.evidence_url || '').trim()
    const confidence = validateConfidence(req.body?.confidence)

    if (!itemId) {
      return res.status(400).json({ success: false, error: 'item_id is required' })
    }

    if (!ALLOWED_ACTIONS.has(action)) {
      return res.status(400).json({ success: false, error: 'action must be one of accept, reject, correct, or escalate' })
    }

    if (!reasonCode) {
      return res.status(400).json({ success: false, error: 'reason_code is required' })
    }

    if (!evidenceUrl) {
      return res.status(400).json({ success: false, error: 'evidence_url is required' })
    }

    if (action === 'correct' && req.body?.new_value == null) {
      return res.status(400).json({ success: false, error: 'new_value is required for correct actions' })
    }

    const reviewId = crypto.randomUUID()
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}

    await req.db
      .prepare(
        `
          INSERT INTO reviews (
            id,
            item_id,
            reviewer_user_id,
            action,
            prior_value,
            new_value,
            reason_code,
            evidence_url,
            confidence,
            metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        reviewId,
        itemId,
        actorUserId,
        action,
        toStoredJson(req.body?.prior_value),
        toStoredJson(req.body?.new_value),
        reasonCode,
        evidenceUrl,
        confidence,
        toStoredJson(metadata) || '{}',
      )

    const created = await req.db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId)
    res.status(201).json({
      success: true,
      review: mapReviewRow(created),
    })
  } catch (error) {
    console.error('[reviews] Failed to create review:', error)
    res.status(500).json({ success: false, error: 'Failed to create review' })
  }
})

export default router
