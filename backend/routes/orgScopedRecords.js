/**
 * Org-scoped consultant workspace records: projects, time entries/logs,
 * invoices, and invoice lines.
 *
 * These entities were referenced by the frontend generic entity client
 * (client.entities.Invoice / Project / TimeEntry / TimeLog / InvoiceLine)
 * but had no backend resource, so the client silently fell through to its
 * in-memory stub store — the UI showed success toasts and every record
 * vanished on reload. This module gives each a real, tenant-scoped REST
 * resource with the exact HTTP contract createEntityClient speaks:
 *   GET    /            ?sort=&order=&limit=&<column filters>
 *   GET    /:id
 *   POST   /
 *   PUT    /:id
 *   DELETE /:id
 *
 * Access: every row belongs to an organization; reads and writes require
 * access to that organization (ensureOrganizationAccess), admins see
 * everything. Columns are allowlisted — unknown keys are dropped.
 *
 * Distinct from /api/billing subscription invoices (billing_invoices).
 */

import express from 'express'
import crypto from 'crypto'
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  getAccessibleOrganizationIds,
  getAuthUserId,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:orgScopedRecords')

export const ORG_SCOPED_RESOURCES = Object.freeze({
  invoices: Object.freeze({
    table: 'consultant_invoices',
    parent: 'organization',
    columns: Object.freeze([
      'organization_id', 'project_id', 'invoice_number', 'issue_date', 'due_date',
      'payment_terms', 'payment_option', 'subtotal', 'discount_amount',
      'discount_description', 'tax_amount', 'total', 'balance_due', 'amount_paid',
      'status', 'notes', 'contract_terms', 'client_category',
      'qualifies_for_hardship', 'qualifies_for_ministry_discount',
      'rate_override', 'fee_override', 'milestone_type', 'service_type',
      'service_description',
    ]),
    updatable: Object.freeze([
      'project_id', 'invoice_number', 'issue_date', 'due_date', 'payment_terms',
      'payment_option', 'subtotal', 'discount_amount', 'discount_description',
      'tax_amount', 'total', 'balance_due', 'amount_paid', 'status', 'notes',
      'contract_terms', 'client_category', 'qualifies_for_hardship',
      'qualifies_for_ministry_discount', 'rate_override', 'fee_override',
      'milestone_type', 'service_type', 'service_description',
    ]),
    sortable: Object.freeze(['created_at', 'updated_at', 'issue_date', 'due_date', 'status', 'invoice_number']),
    required: Object.freeze(['organization_id']),
    booleanCols: Object.freeze(['qualifies_for_hardship', 'qualifies_for_ministry_discount']),
    jsonCols: Object.freeze([]),
  }),
  'invoice-lines': Object.freeze({
    table: 'consultant_invoice_lines',
    parent: 'invoice',
    columns: Object.freeze([
      'organization_id', 'invoice_id', 'description', 'quantity', 'unit_price',
      'amount', 'line_order', 'is_grant_chargeable',
    ]),
    updatable: Object.freeze([
      'description', 'quantity', 'unit_price', 'amount', 'line_order', 'is_grant_chargeable',
    ]),
    sortable: Object.freeze(['line_order', 'created_at', 'updated_at']),
    required: Object.freeze(['invoice_id']),
    booleanCols: Object.freeze(['is_grant_chargeable']),
    jsonCols: Object.freeze([]),
  }),
  projects: Object.freeze({
    table: 'consultant_projects',
    parent: 'organization',
    columns: Object.freeze([
      'organization_id', 'project_name', 'pricing_model', 'hourly_rate',
      'fixed_fee_amount', 'status', 'scope_of_work', 'payment_option',
    ]),
    updatable: Object.freeze([
      'project_name', 'pricing_model', 'hourly_rate', 'fixed_fee_amount',
      'status', 'scope_of_work', 'payment_option',
    ]),
    sortable: Object.freeze(['created_at', 'updated_at', 'project_name', 'status']),
    required: Object.freeze(['organization_id', 'project_name']),
    booleanCols: Object.freeze([]),
    jsonCols: Object.freeze([]),
  }),
  'time-entries': Object.freeze({
    table: 'consultant_time_entries',
    parent: 'organization',
    columns: Object.freeze([
      'organization_id', 'grant_id', 'project_id', 'user_id', 'task_category',
      'start_at', 'end_at', 'raw_minutes', 'rounded_minutes', 'note',
      'activity_hints', 'source', 'invoiced',
    ]),
    updatable: Object.freeze([
      'grant_id', 'project_id', 'user_id', 'task_category', 'start_at', 'end_at',
      'raw_minutes', 'rounded_minutes', 'note', 'activity_hints', 'source', 'invoiced',
    ]),
    sortable: Object.freeze(['created_at', 'updated_at', 'start_at']),
    required: Object.freeze(['organization_id']),
    booleanCols: Object.freeze(['invoiced']),
    jsonCols: Object.freeze(['activity_hints']),
  }),
  'time-logs': Object.freeze({
    table: 'consultant_time_logs',
    parent: 'project',
    columns: Object.freeze([
      'organization_id', 'project_id', 'date', 'hours', 'description',
      'billable', 'is_grant_chargeable', 'hourly_rate', 'total_amount',
    ]),
    updatable: Object.freeze([
      'project_id', 'date', 'hours', 'description', 'billable',
      'is_grant_chargeable', 'hourly_rate', 'total_amount',
    ]),
    sortable: Object.freeze(['created_at', 'updated_at', 'date']),
    required: Object.freeze(['project_id']),
    booleanCols: Object.freeze(['billable', 'is_grant_chargeable']),
    jsonCols: Object.freeze([]),
  }),
})

function pickAllowed(body, allowed) {
  const out = {}
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key]
  }
  return out
}

function coerceBool(value) {
  if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return 1
  if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false') return 0
  return value
}

function encodeFields(spec, data) {
  const out = { ...data }
  for (const key of spec.booleanCols || []) {
    if (out[key] !== undefined) out[key] = coerceBool(out[key])
  }
  for (const key of spec.jsonCols || []) {
    if (out[key] !== undefined && typeof out[key] !== 'string') {
      try {
        out[key] = JSON.stringify(out[key])
      } catch {
        out[key] = null
      }
    }
  }
  return out
}

function decodeRow(spec, row) {
  if (!row) return row
  const out = { ...row }
  for (const key of spec.jsonCols || []) {
    if (typeof out[key] === 'string' && out[key]) {
      try {
        out[key] = JSON.parse(out[key])
      } catch {
        // leave as stored text
      }
    }
  }
  return out
}

function resolveSortCol(spec, sort) {
  const requested = String(sort || '')
  const aliased = requested === 'created_date' ? 'created_at'
    : requested === 'updated_date' ? 'updated_at'
      : requested
  return spec.sortable.find((c) => c === aliased) ?? 'created_at'
}

async function loadParentOrg(db, spec, body) {
  if (spec.parent === 'invoice') {
    const invoice = await db.prepare(
      'SELECT id, organization_id FROM consultant_invoices WHERE id = ? LIMIT 1',
    ).get(String(body.invoice_id))
    return invoice || null
  }
  if (spec.parent === 'project') {
    const project = await db.prepare(
      'SELECT id, organization_id FROM consultant_projects WHERE id = ? LIMIT 1',
    ).get(String(body.project_id))
    return project || null
  }
  return { organization_id: body.organization_id }
}

async function ensureRowAccess(req, res, spec, id) {
  const row = await req.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ? LIMIT 1`).get(String(id))
  if (!row) {
    res.status(404).json({ error: 'Not found' })
    return null
  }
  const ok = await ensureOrganizationAccess(req, res, String(row.organization_id))
  if (!ok) return null
  return row
}

async function readBillingSeed(db, userId) {
  try {
    const row = await db.prepare(
      'SELECT custom_preferences FROM user_preferences WHERE user_id = ? LIMIT 1',
    ).get(String(userId))
    if (!row?.custom_preferences) return 0
    const custom = typeof row.custom_preferences === 'string'
      ? JSON.parse(row.custom_preferences)
      : row.custom_preferences
    const n = Number(custom?.billing_settings?.last_invoice_number)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

function formatInvoiceNumber(seq, issueDate) {
  const match = String(issueDate || '').match(/^(\d{4})-(\d{2})/)
  const now = new Date()
  const y = match ? match[1] : String(now.getUTCFullYear())
  const m = match ? match[2] : String(now.getUTCMonth() + 1).padStart(2, '0')
  return `INV-${y}${m}-${String(seq).padStart(4, '0')}`
}

async function allocateInvoiceNumber(db, userId, issueDate) {
  const seed = await readBillingSeed(db, userId)
  const sql = db.dialect === 'postgres'
    ? `INSERT INTO consultant_invoice_counters (user_id, last_number) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET last_number = consultant_invoice_counters.last_number + 1
       RETURNING last_number`
    : `INSERT INTO consultant_invoice_counters (user_id, last_number) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_number = last_number + 1
       RETURNING last_number`
  const row = await db.prepare(sql).get(String(userId), seed + 1)
  const seq = Number(row?.last_number) || seed + 1
  return formatInvoiceNumber(seq, issueDate)
}

export function createOrgScopedRecordsRouter(resourceKey) {
  const spec = ORG_SCOPED_RESOURCES[resourceKey]
  if (!spec) throw new Error(`unknown org-scoped resource: ${resourceKey}`)
  const router = express.Router()

  router.use(async (req, res, next) => {
    try {
      const user = requireAuthenticatedUser(req, res)
      if (!user) return
      next()
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: 'Authentication check failed' })
      else next(error)
    }
  })

  router.get('/', async (req, res) => {
    try {
      const { sort, order, limit, organization_id: orgId } = req.query
      const params = []
      let where = 'WHERE 1=1'

      if (orgId) {
        const ok = await ensureOrganizationAccess(req, res, String(orgId))
        if (!ok) return
        where += ' AND r.organization_id = ?'
        params.push(String(orgId))
      } else {
        const orgIds = await getAccessibleOrganizationIds(req.db, req.user)
        if (orgIds !== null) {
          const ids = Array.from(orgIds)
          if (ids.length === 0) return res.json([])
          where += ` AND r.organization_id IN (${ids.map(() => '?').join(',')})`
          params.push(...ids.map(String))
        }
      }

      for (const key of spec.columns) {
        if (key === 'organization_id') continue
        const value = req.query[key]
        if (value === undefined || value === '') continue
        where += ` AND r.${key} = ?`
        params.push(spec.booleanCols?.includes(key) ? coerceBool(value) : String(value))
      }

      const sortCol = resolveSortCol(spec, sort)
      const sortOrder = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC'
      const cappedLimit = Math.max(1, Math.min(500, Number(limit) || 500))
      params.push(cappedLimit)

      const rows = await req.db.prepare(
        // audit:allow unscoped-profile-query -- org-scoped via accessible-organization WHERE or ensureOrganizationAccess above
        `SELECT r.* FROM ${spec.table} r
          ${where}
          ORDER BY r.${sortCol} ${sortOrder}
          LIMIT ?`,
      ).all(...params)
      res.json((Array.isArray(rows) ? rows : []).map((row) => decodeRow(spec, row)))
    } catch (error) {
      log.error(`${resourceKey} list failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to list records' })
    }
  })

  router.get('/:id', async (req, res) => {
    try {
      const row = await ensureRowAccess(req, res, spec, req.params.id)
      if (!row) return
      res.json(decodeRow(spec, row))
    } catch (error) {
      log.error(`${resourceKey} get failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to read record' })
    }
  })

  router.post('/', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      for (const key of spec.required) {
        if (body[key] === undefined || body[key] === null || body[key] === '') {
          return res.status(400).json({ error: `${key} is required` })
        }
      }

      const parent = await loadParentOrg(req.db, spec, body)
      if (!parent?.organization_id) {
        return res.status(404).json({ error: spec.parent === 'organization' ? 'organization_id is required' : 'Parent record not found' })
      }
      const ok = await ensureOrganizationAccess(req, res, String(parent.organization_id))
      if (!ok) return

      if (body.grant_id) {
        const grant = await ensureGrantAccess(req, res, String(body.grant_id))
        if (!grant) return
      }

      const data = encodeFields(spec, pickAllowed(body, spec.columns))
      data.organization_id = String(parent.organization_id)

      if (resourceKey === 'invoices') {
        const userId = getAuthUserId(req.user)
        if (!userId) return res.status(401).json({ error: 'Authentication required' })
        data.invoice_number = await allocateInvoiceNumber(req.db, userId, data.issue_date)
      }

      const id = crypto.randomUUID()
      const cols = ['id', ...Object.keys(data)]
      await req.db.prepare(
        `INSERT INTO ${spec.table} (${cols.join(', ')})
         VALUES (${cols.map(() => '?').join(', ')})`,
      ).run(id, ...Object.values(data).map((v) => (v === undefined ? null : v)))

      const created = await req.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id)
      res.status(201).json(decodeRow(spec, created))
    } catch (error) {
      log.error(`${resourceKey} create failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to create record' })
    }
  })

  router.put('/:id', async (req, res) => {
    try {
      const row = await ensureRowAccess(req, res, spec, req.params.id)
      if (!row) return
      const data = encodeFields(spec, pickAllowed(req.body && typeof req.body === 'object' ? req.body : {}, spec.updatable))
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'No updatable fields supplied' })
      }
      if (data.grant_id) {
        const grant = await ensureGrantAccess(req, res, String(data.grant_id))
        if (!grant) return
      }
      const sets = Object.keys(data).map((k) => `${k} = ?`)
      await req.db.prepare(
        `UPDATE ${spec.table} SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(...Object.values(data).map((v) => (v === undefined ? null : v)), String(req.params.id))
      const updated = await req.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(String(req.params.id))
      res.json(decodeRow(spec, updated))
    } catch (error) {
      log.error(`${resourceKey} update failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to update record' })
    }
  })

  router.delete('/:id', async (req, res) => {
    try {
      const row = await ensureRowAccess(req, res, spec, req.params.id)
      if (!row) return
      await req.db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(String(req.params.id))
      res.json({ success: true })
    } catch (error) {
      log.error(`${resourceKey} delete failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to delete record' })
    }
  })

  return router
}

export default { createOrgScopedRecordsRouter, ORG_SCOPED_RESOURCES }
