import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser, ensureGrantAccess, getAccessibleOrganizationIds, ensureProfileAccess } from '../utils/accessControl.js'

const router = express.Router()
router.use(requireAuthenticatedUser)

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function mapRow(row) {
  if (!row) return null
  // Historical schema stores line items as JSON; newer UI treats each row as a "budget line item".
  const parsed = safeJsonParse(row.line_items, null)
  const first = Array.isArray(parsed) ? parsed[0] : parsed && typeof parsed === 'object' ? parsed : null

  const quantity = Number(first?.quantity ?? 1) || 0
  const unitCost = Number(first?.unit_cost ?? 0) || 0
  const total = Number(first?.total ?? row.total_amount ?? 0) || 0

  return {
    id: row.id,
    grant_id: row.grant_id,
    category: first?.category ?? null,
    line_item: first?.line_item ?? row.name ?? '',
    quantity,
    unit_cost: unitCost,
    total,
    justification: first?.justification ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    status: row.status ?? null,
  }
}

function normalizeLimit(val, fallback = 200) {
  const n = Number.parseInt(String(val ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(500, n)
}

router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const limit = normalizeLimit(req.query.limit, 500)
    const grantId = req.query.grant_id ? String(req.query.grant_id) : null
    const id = req.query.id ? String(req.query.id) : null

    const clauses = []
    const params = []

    if (id) {
      clauses.push('b.id = ?')
      params.push(id)
    }
    if (grantId) {
      clauses.push('b.grant_id = ?')
      params.push(grantId)
    }

    if (!req.ctx?.isAdmin) {
      // Profile-scoped access: Only show budgets for grants in the active profile
      const profileId = req.ctx?.activeProfileId
      if (!profileId) {
        return res.json([]) // No active profile context = no budgets visible
      }

      // Validate that the user can actually access this profile
      const canAccess = await ensureProfileAccess(req, res, String(profileId))
      if (!canAccess) {
        return // ensureProfileAccess already sent 403
      }

      // Filter by profile_id: only grants belonging to the active profile
      // The JOIN on grants ensures we get the correct profile_id from the grant
      clauses.push('g.profile_id = ?')
      params.push(String(profileId))
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await req.db
      .prepare(
        `
          SELECT b.*
          FROM budgets b
          INNER JOIN grants g ON g.id = b.grant_id
          ${where}
          ORDER BY b.updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)

    return res.json((rows || []).map(mapRow))
  } catch (error) {
    console.error('[budgets] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.get('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const row = await req.db.prepare('SELECT * FROM budgets WHERE id = ?').get(String(req.params.id))
    if (!row) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(row.grant_id))
    if (!grant) return
    return res.json(mapRow(row))
  } catch (error) {
    console.error('[budgets] get error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const data = req.body ?? {}
    const grantId = data.grant_id ? String(data.grant_id) : null
    if (!grantId) return res.status(400).json({ error: 'grant_id required' })
    const grant = await ensureGrantAccess(req, res, grantId)
    if (!grant) return

    const id = data.id ? String(data.id) : crypto.randomUUID()
    const category = data.category ? String(data.category) : null
    const lineItem = String(data.line_item || data.name || '').trim()
    if (!lineItem) return res.status(400).json({ error: 'line_item required' })

    const quantity = Number(data.quantity ?? 1) || 0
    const unitCost = Number(data.unit_cost ?? 0) || 0
    const total = data.total !== undefined ? Number(data.total) : quantity * unitCost
if (!Number.isFinite(total)) return res.status(400).json({ error: 'Budget total must be a valid number' })
if (total < 0) return res.status(400).json({ error: 'Budget total cannot be negative' })
    const justification = data.justification ?? null

    const lineItemsJson = JSON.stringify({
      category,
      line_item: lineItem,
      quantity,
      unit_cost: unitCost,
      total,
      justification,
    })

    await req.db
      .prepare(
        `
          INSERT INTO budgets (
            id, grant_id,
            name, total_amount,
            line_items, status
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(id, grantId, lineItem, total, lineItemsJson, 'draft')

    const row = await req.db.prepare('SELECT * FROM budgets WHERE id = ?').get(id)
    return res.status(201).json(mapRow(row))
  } catch (error) {
    console.error('[budgets] create error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.put('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM budgets WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(existing.grant_id))
    if (!grant) return

    const data = req.body ?? {}
    const parsed = safeJsonParse(existing.line_items, null)
    const current = Array.isArray(parsed) ? parsed[0] : parsed && typeof parsed === 'object' ? parsed : {}

    const category = data.category ?? current.category ?? null
    const lineItem = data.line_item !== undefined ? String(data.line_item || '').trim() : String(current.line_item || existing.name || '')
    const quantity = data.quantity !== undefined ? Number(data.quantity) || 0 : Number(current.quantity ?? 1) || 0
    const unitCost = data.unit_cost !== undefined ? Number(data.unit_cost) || 0 : Number(current.unit_cost ?? 0) || 0
    const rawTotal = data.total !== undefined ? Number(data.total) : (current.total ?? existing.total_amount ?? quantity * unitCost)
const total = Number(rawTotal)
if (!Number.isFinite(total)) return res.status(400).json({ error: 'Budget total must be a valid number' })
if (total < 0) return res.status(400).json({ error: 'Budget total cannot be negative' })
    const justification = data.justification !== undefined ? data.justification : current.justification ?? null
    const status = data.status ?? existing.status ?? 'draft'

    const lineItemsJson = JSON.stringify({
      category,
      line_item: lineItem,
      quantity,
      unit_cost: unitCost,
      total,
      justification,
    })

    await req.db
      .prepare(
        `
          UPDATE budgets
          SET name = ?,
              total_amount = ?,
              line_items = ?,
              status = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(lineItem, total, lineItemsJson, status, String(req.params.id))

    const row = await req.db.prepare('SELECT * FROM budgets WHERE id = ?').get(String(req.params.id))
    return res.json(mapRow(row))
  } catch (error) {
    console.error('[budgets] update error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.delete('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM budgets WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(existing.grant_id))
    if (!grant) return

    await req.db.prepare('DELETE FROM budgets WHERE id = ?').run(String(req.params.id))
    return res.json({ ok: true })
  } catch (error) {
    console.error('[budgets] delete error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router

