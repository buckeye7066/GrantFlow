/**
 * Grant-scoped UI record routes: checklist items, award records, and
 * compliance reports.
 *
 * These three entities were referenced by the frontend generic entity client
 * (client.entities.ChecklistItem / GrantAward / ComplianceReport) but had no
 * backend resource, so the client silently fell through to its in-memory stub
 * store — the UI showed success toasts and every record vanished on reload
 * (epic slice 8/9 residual). This module gives each a real, tenant-scoped
 * REST resource with the exact HTTP contract createEntityClient speaks:
 *   GET    /            ?sort=&order=&limit=&<column filters>
 *   GET    /:id
 *   POST   /
 *   PUT    /:id
 *   DELETE /:id
 *
 * Access model mirrors backend/routes/milestones.js: every row belongs to a
 * grant; reads and writes require access to that grant's organization (or an
 * accessible orphan-profile grant), admins see everything. Columns are
 * allowlisted per resource — unknown keys are dropped, never persisted.
 */

import express from 'express'
import crypto from 'crypto'
import {
  ensureGrantAccess,
  getAccessibleOrganizationIds,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:grantScopedRecords')

/**
 * Per-resource contracts. `columns` is the full writable allowlist (create),
 * `updatable` the PUT allowlist; `sortable` bounds ?sort= so a caller can
 * never smuggle SQL through the order-by (safeSql posture: identifiers come
 * only from these frozen lists).
 */
export const GRANT_SCOPED_RESOURCES = Object.freeze({
  'checklist-items': Object.freeze({
    table: 'grant_checklist_items',
    columns: Object.freeze(['grant_id', 'organization_id', 'title', 'type', 'status', 'notes']),
    updatable: Object.freeze(['title', 'type', 'status', 'notes']),
    sortable: Object.freeze(['created_at', 'updated_at', 'title', 'status', 'type']),
    required: Object.freeze(['grant_id', 'title']),
    uniquePerGrant: false,
  }),
  'grant-awards': Object.freeze({
    table: 'grant_awards',
    columns: Object.freeze([
      'grant_id', 'organization_id', 'award_amount', 'funder_name',
      'start_date', 'end_date', 'policy_json', 'reporting_cadence',
    ]),
    updatable: Object.freeze([
      'award_amount', 'funder_name', 'start_date', 'end_date',
      'policy_json', 'reporting_cadence',
    ]),
    sortable: Object.freeze(['created_at', 'updated_at', 'start_date']),
    required: Object.freeze(['grant_id']),
    uniquePerGrant: true,
  }),
  'compliance-reports': Object.freeze({
    table: 'compliance_reports',
    columns: Object.freeze([
      'grant_id', 'organization_id', 'report_type', 'report_period_start',
      'report_period_end', 'due_date', 'status', 'submitted_date',
      'narrative', 'activities_summary', 'challenges_faced', 'next_steps',
    ]),
    updatable: Object.freeze([
      'report_type', 'report_period_start', 'report_period_end', 'due_date',
      'status', 'submitted_date', 'narrative', 'activities_summary',
      'challenges_faced', 'next_steps',
    ]),
    sortable: Object.freeze(['due_date', 'created_at', 'updated_at', 'status', 'report_type']),
    required: Object.freeze(['grant_id']),
    uniquePerGrant: false,
  }),
})

function pickAllowed(body, allowed) {
  const out = {}
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key]
  }
  return out
}

async function rowWithGrantOrg(db, table, id) {
  // Single-row PK lookup whose result is IMMEDIATELY adjudicated by
  // ensureRowAccess/ensureGrantAccess (org tenancy on the joined grant) before
  // anything is returned; the join reads only organization_id for that check.
  return db.prepare(
    // audit:allow unscoped-profile-query -- access adjudicated by ensureGrantAccess on the joined grant before any return
    `SELECT r.*, g.organization_id AS grant_organization_id
       FROM ${table} r
       LEFT JOIN grants g ON g.id = r.grant_id
      WHERE r.id = ?
      LIMIT 1`,
  ).get(String(id))
}

async function ensureRowAccess(req, res, spec, id) {
  const row = await rowWithGrantOrg(req.db, spec.table, id)
  if (!row) {
    res.status(404).json({ error: 'Not found' })
    return null
  }
  if (req.ctx?.isAdmin === true) return row
  // Access is the GRANT's access — the same authority create used.
  const grant = await ensureGrantAccess(req, res, String(row.grant_id))
  if (!grant) return null // ensureGrantAccess already responded
  return row
}

export function createGrantScopedRecordsRouter(resourceKey) {
  const spec = GRANT_SCOPED_RESOURCES[resourceKey]
  if (!spec) throw new Error(`unknown grant-scoped resource: ${resourceKey}`)
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
      const { sort, order, limit, grant_id: grantId } = req.query
      const params = []
      let where = 'WHERE 1=1'

      if (grantId) {
        const grant = await ensureGrantAccess(req, res, String(grantId))
        if (!grant) return
        where += ' AND r.grant_id = ?'
        params.push(String(grantId))
      } else {
        // null = admin (no narrowing); an empty Set = caller can reach nothing.
        const orgIds = await getAccessibleOrganizationIds(req.db, req.user)
        if (orgIds !== null) {
          const ids = Array.from(orgIds)
          if (ids.length === 0) return res.json([])
          where += ` AND g.organization_id IN (${ids.map(() => '?').join(',')})`
          params.push(...ids.map(String))
        }
      }

      // Column filters limited to the writable allowlist (e.g. ?status=done).
      for (const key of spec.columns) {
        if (key === 'grant_id') continue
        const value = req.query[key]
        if (value === undefined || value === '') continue
        where += ` AND r.${key} = ?`
        params.push(String(value))
      }

      // Identifiers resolve to ALLOWLIST MEMBERS (never the request string):
      // the sort column is the matched element of the frozen sortable list,
      // and the limit is a bound parameter — nothing request-derived is ever
      // interpolated into the SQL text.
      const sortCol = spec.sortable.find((c) => c === String(sort)) ?? 'created_at'
      const sortOrder = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC'
      const cappedLimit = Math.max(1, Math.min(500, Number(limit) || 500))
      params.push(cappedLimit)

      // Tenancy is enforced ABOVE this statement: ensureGrantAccess admitted
      // the requested grant_id, or the WHERE was narrowed to the caller's
      // accessible organization ids (admins exempt — the milestones posture).
      // Identifiers come only from the frozen registry/allowlists, never input.
      const rows = await req.db.prepare(
        // audit:allow unscoped-profile-query -- org-scoped via accessible-organization WHERE or ensureGrantAccess above
        `SELECT r.* FROM ${spec.table} r
           LEFT JOIN grants g ON g.id = r.grant_id
          ${where}
          ORDER BY r.${sortCol} ${sortOrder}
          LIMIT ?`,
      ).all(...params)
      res.json(Array.isArray(rows) ? rows : [])
    } catch (error) {
      log.error(`${resourceKey} list failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to list records' })
    }
  })

  router.get('/:id', async (req, res) => {
    try {
      const row = await ensureRowAccess(req, res, spec, req.params.id)
      if (!row) return
      const { grant_organization_id: _omit, ...clean } = row
      res.json(clean)
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
      const grant = await ensureGrantAccess(req, res, String(body.grant_id))
      if (!grant) return

      const data = pickAllowed(body, spec.columns)
      // The grant's own organization is the tenancy truth — never trust a
      // client-supplied organization_id over it.
      data.organization_id = grant.organization_id ?? data.organization_id ?? null

      if (spec.uniquePerGrant) {
        const existing = await req.db.prepare(
          `SELECT id FROM ${spec.table} WHERE grant_id = ? LIMIT 1`,
        ).get(String(body.grant_id))
        if (existing) {
          return res.status(409).json({ error: 'A record already exists for this grant', id: existing.id })
        }
      }

      const id = crypto.randomUUID()
      const cols = ['id', ...Object.keys(data)]
      await req.db.prepare(
        `INSERT INTO ${spec.table} (${cols.join(', ')})
         VALUES (${cols.map(() => '?').join(', ')})`,
      ).run(id, ...Object.values(data).map((v) => (v === undefined ? null : v)))

      const created = await req.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id)
      res.status(201).json(created)
    } catch (error) {
      log.error(`${resourceKey} create failed`, error?.message || error)
      res.status(500).json({ error: 'Failed to create record' })
    }
  })

  router.put('/:id', async (req, res) => {
    try {
      const row = await ensureRowAccess(req, res, spec, req.params.id)
      if (!row) return
      const data = pickAllowed(req.body && typeof req.body === 'object' ? req.body : {}, spec.updatable)
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'No updatable fields supplied' })
      }
      const sets = Object.keys(data).map((k) => `${k} = ?`)
      await req.db.prepare(
        `UPDATE ${spec.table} SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(...Object.values(data).map((v) => (v === undefined ? null : v)), String(req.params.id))
      const updated = await req.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(String(req.params.id))
      res.json(updated)
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

export default { createGrantScopedRecordsRouter, GRANT_SCOPED_RESOURCES }
