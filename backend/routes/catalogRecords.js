/**
 * Authenticated catalog records: PartnerSource, SearchJob, Taxonomy.
 *
 * These entities were declared stubs (entityResourceMapTotality) — writes
 * toasted success and vanished on reload. This module gives each a real REST
 * resource with the createEntityClient contract:
 *   GET    /            ?sort=&order=&limit=&<column filters>
 *   GET    /:id
 *   POST   /
 *   PUT    /:id
 *   DELETE /:id
 *
 * Taxonomy is shared read for any signed-in user (OrganizationForm); writes
 * are admin-only. Partner sources and search jobs are admin-only.
 * Columns are allowlisted. `group` is stored as group_name (Postgres reserved).
 */

import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:catalogRecords')

export const CATALOG_RESOURCES = Object.freeze({
  'partner-sources': Object.freeze({
    table: 'workspace_partner_sources',
    adminWrite: true,
    adminRead: false,
    columns: Object.freeze([
      'name', 'org_type', 'api_base_url', 'contact_email', 'auth_type',
      'auth_secret_name', 'status', 'last_success_at',
    ]),
    updatable: Object.freeze([
      'name', 'org_type', 'api_base_url', 'contact_email', 'auth_type',
      'auth_secret_name', 'status', 'last_success_at',
    ]),
    sortable: Object.freeze(['created_at', 'updated_at', 'name', 'status']),
    required: Object.freeze(['name']),
    booleanCols: Object.freeze([]),
    rename: Object.freeze({}),
  }),
  'search-jobs': Object.freeze({
    table: 'workspace_search_jobs',
    adminWrite: false,
    adminRead: false,
    columns: Object.freeze(['profile_id', 'status', 'progress', 'results', 'error']),
    updatable: Object.freeze(['profile_id', 'status', 'progress', 'results', 'error']),
    sortable: Object.freeze(['created_at', 'updated_at', 'status']),
    required: Object.freeze([]),
    booleanCols: Object.freeze([]),
    rename: Object.freeze({}),
  }),
  taxonomy: Object.freeze({
    table: 'workspace_taxonomy',
    adminWrite: true,
    adminRead: false,
    columns: Object.freeze(['group', 'label', 'slug', 'active', 'sort_order']),
    updatable: Object.freeze(['group', 'label', 'slug', 'active', 'sort_order']),
    sortable: Object.freeze(['sort_order', 'created_at', 'updated_at', 'label']),
    required: Object.freeze(['group', 'label']),
    booleanCols: Object.freeze(['active']),
    rename: Object.freeze({ group: 'group_name' }),
  }),
})

function isAdmin(req) {
  return req.ctx?.isAdmin === true
    || req.user?.role === 'admin'
    || req.user?.is_admin === true
    || req.user?.is_admin === 1
}

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

function apiToDb(spec, data) {
  const out = { ...data }
  for (const [api, db] of Object.entries(spec.rename || {})) {
    if (out[api] !== undefined) {
      out[db] = out[api]
      delete out[api]
    }
  }
  return out
}

function dbToApi(spec, row) {
  if (!row) return row
  const out = { ...row }
  for (const [api, db] of Object.entries(spec.rename || {})) {
    if (out[db] !== undefined) {
      out[api] = out[db]
      delete out[db]
    }
  }
  return out
}

function dbColumn(spec, apiKey) {
  return spec.rename?.[apiKey] || apiKey
}

function encodeFields(spec, data) {
  const out = { ...data }
  for (const key of spec.booleanCols || []) {
    if (out[key] !== undefined) out[key] = coerceBool(out[key])
  }
  return apiToDb(spec, out)
}

function decodeRow(spec, row) {
  return dbToApi(spec, row)
}

export function resolveSortCol(spec, sort) {
  const requested = String(sort || '')
  const aliased = requested === 'created_date' ? 'created_at'
    : requested === 'updated_date' ? 'updated_at'
      : requested
  const asDb = dbColumn(spec, aliased)
  // Return the MATCHED ELEMENT of the frozen sortable list, never the request
  // string — the same posture as grantScopedRecords/orgScopedRecords. Testing
  // membership with .includes() and then returning the caller's own string is
  // behaviourally equivalent but leaves a request-derived value flowing into
  // the ORDER BY identifier (js/sql-injection). Preference order is unchanged:
  // renamed db column first, then the api-side alias, then the spec default.
  const matched = spec.sortable.find((c) => c === asDb)
    ?? spec.sortable.find((c) => c === aliased)
  return matched ?? spec.sortable[0] ?? 'created_at'
}

export function createCatalogRecordsRouter(resourceKey) {
  const spec = CATALOG_RESOURCES[resourceKey]
  if (!spec) throw new Error(`unknown catalog resource: ${resourceKey}`)
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
      if (spec.adminRead && !isAdmin(req)) {
        return res.status(403).json({ error: 'Admin access required' })
      }
      const { sort, order, limit } = req.query
      const params = []
      let where = 'WHERE 1=1'

      for (const key of spec.columns) {
        const value = req.query[key]
        if (value === undefined || value === '') continue
        where += ` AND r.${dbColumn(spec, key)} = ?`
        params.push(spec.booleanCols?.includes(key) ? coerceBool(value) : String(value))
      }

      // Identifiers resolve to ALLOWLIST MEMBERS (never the request string):
      // the sort column is the matched element of the frozen sortable list,
      // and the limit is a bound parameter — nothing request-derived is ever
      // interpolated into the SQL text.
      const sortCol = resolveSortCol(spec, sort)
      const sortOrder = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC'
      const cappedLimit = Math.max(1, Math.min(500, Number(limit) || 500))
      params.push(cappedLimit)

      const rows = await req.db.prepare(
        // audit:allow unscoped-profile-query -- shared catalog; auth required above; writes admin-gated
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
      if (spec.adminRead && !isAdmin(req)) {
        return res.status(403).json({ error: 'Admin access required' })
      }
      const row = await req.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ? LIMIT 1`).get(String(req.params.id))
      if (!row) return res.status(404).json({ error: 'Not found' })
      res.json(decodeRow(spec, row))
    } catch (error) {
      log.error(`${resourceKey} get failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to read record' })
    }
  })

  router.post('/', async (req, res) => {
    try {
      if (spec.adminWrite && !isAdmin(req)) {
        return res.status(403).json({ error: 'Admin access required' })
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      for (const key of spec.required) {
        if (body[key] === undefined || body[key] === null || body[key] === '') {
          return res.status(400).json({ error: `${key} is required` })
        }
      }
      const data = encodeFields(spec, pickAllowed(body, spec.columns))
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
      if (spec.adminWrite && !isAdmin(req)) {
        return res.status(403).json({ error: 'Admin access required' })
      }
      const existing = await req.db.prepare(`SELECT id FROM ${spec.table} WHERE id = ? LIMIT 1`).get(String(req.params.id))
      if (!existing) return res.status(404).json({ error: 'Not found' })
      const data = encodeFields(spec, pickAllowed(req.body && typeof req.body === 'object' ? req.body : {}, spec.updatable))
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'No updatable fields supplied' })
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
      if (spec.adminWrite && !isAdmin(req)) {
        return res.status(403).json({ error: 'Admin access required' })
      }
      const existing = await req.db.prepare(`SELECT id FROM ${spec.table} WHERE id = ? LIMIT 1`).get(String(req.params.id))
      if (!existing) return res.status(404).json({ error: 'Not found' })
      await req.db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(String(req.params.id))
      res.json({ success: true })
    } catch (error) {
      log.error(`${resourceKey} delete failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to delete record' })
    }
  })

  return router
}

export default { createCatalogRecordsRouter, CATALOG_RESOURCES }
