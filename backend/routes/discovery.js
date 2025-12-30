import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { getDb } from '../db/index.js'

const router = Router()

const mapTemplate = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  query: row.query,
  filters: row.filters_json ? JSON.parse(row.filters_json) : {},
  owner_id: row.owner_id,
  is_default: Boolean(row.is_default),
  created_at: row.created_at,
  updated_at: row.updated_at,
})

const mapSavedSearch = (row) => ({
  id: row.id,
  template_id: row.template_id,
  profile_id: row.profile_id,
  name: row.name,
  description: row.description,
  filters: row.filters_json ? JSON.parse(row.filters_json) : {},
  schedule: row.schedule,
  last_run_at: row.last_run_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

const mapSource = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  type: row.type,
  region: row.region,
  status: row.status,
  schedule: row.schedule,
  last_run_at: row.last_run_at,
  last_success_at: row.last_success_at,
  success_count: row.success_count,
  failure_count: row.failure_count,
  metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
})

const mapOpportunity = (row) => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  description: row.description,
  amount_min: row.amount_min,
  amount_max: row.amount_max,
  currency: row.currency,
  deadline: row.deadline,
  geography: row.geography,
  category: row.category,
  tags: row.tags ? row.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
  eligibility: row.eligibility,
  source_id: row.source_id,
  contact_email: row.contact_email,
  contact_phone: row.contact_phone,
  source_url: row.source_url,
  last_synced_at: row.last_synced_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

const mapRun = (row) => ({
  id: row.id,
  template_id: row.template_id,
  profile_id: row.profile_id,
  query: row.query,
  filters: row.filters_json ? JSON.parse(row.filters_json) : {},
  executed_by: row.executed_by,
  result_count: row.result_count,
  created_at: row.created_at,
})

const mapActivity = (row) => ({
  id: row.id,
  source_id: row.source_id,
  type: row.type,
  message: row.message,
  metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
  created_at: row.created_at,
})

function getDbSafe(res) {
  try {
    return getDb()
  } catch (error) {
    res.status(error.status ?? 500).json({ error: error.message })
    return null
  }
}

router.get('/templates', (req, res) => {
  const db = getDbSafe(res)
  if (!db) return

  const ownerId = req.query.ownerId
  const rows = ownerId
    ? db
        .prepare(
          `SELECT * FROM discovery_templates
           WHERE owner_id IS NULL OR owner_id = @ownerId
           ORDER BY is_default DESC, updated_at DESC`,
        )
        .all({ ownerId })
    : db.prepare(`SELECT * FROM discovery_templates ORDER BY is_default DESC, updated_at DESC`).all()

  res.json({ data: rows.map(mapTemplate) })
})

router.post('/templates', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const body = req.body ?? {}
    const id = uuid()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return res.status(400).json({ error: 'name is required' })
    }
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO discovery_templates (
        id, name, description, query, filters_json, owner_id, is_default, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @query, @filters_json, @owner_id, @is_default, @created_at, @updated_at
      )`,
    ).run({
      id,
      name,
      description: body.description ?? null,
      query: body.query ?? '',
      filters_json: body.filters ? JSON.stringify(body.filters) : null,
      owner_id: body.owner_id ?? null,
      is_default: body.is_default ? 1 : 0,
      created_at: now,
      updated_at: now,
    })

    const created = db.prepare('SELECT * FROM discovery_templates WHERE id = ?').get(id)
    res.status(201).json({ data: mapTemplate(created) })
  } catch (error) {
    next(error)
  }
})

router.patch('/templates/:id', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const existing = db.prepare('SELECT * FROM discovery_templates WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Template not found' })
    }

    const body = req.body ?? {}
    const updates = {}
    if (Object.prototype.hasOwnProperty.call(body, 'name')) updates.name = body.name
    if (Object.prototype.hasOwnProperty.call(body, 'description')) updates.description = body.description
    if (Object.prototype.hasOwnProperty.call(body, 'query')) updates.query = body.query
    if (Object.prototype.hasOwnProperty.call(body, 'owner_id')) updates.owner_id = body.owner_id
    if (Object.prototype.hasOwnProperty.call(body, 'is_default')) updates.is_default = body.is_default ? 1 : 0
    if (Object.prototype.hasOwnProperty.call(body, 'filters')) {
      updates.filters_json = body.filters ? JSON.stringify(body.filters) : null
    }
    if (Object.keys(updates).length === 0) {
      return res.json({ data: mapTemplate(existing) })
    }
    updates.updated_at = new Date().toISOString()

    const assignments = Object.keys(updates)
      .map((field) => `${field} = @${field}`)
      .join(', ')

    db.prepare(`UPDATE discovery_templates SET ${assignments} WHERE id = @id`).run({ ...updates, id: req.params.id })

    const updated = db.prepare('SELECT * FROM discovery_templates WHERE id = ?').get(req.params.id)
    res.json({ data: mapTemplate(updated) })
  } catch (error) {
    next(error)
  }
})

router.delete('/templates/:id', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    db.prepare('DELETE FROM discovery_templates WHERE id = ? AND is_default = 0').run(req.params.id)
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

router.get('/saved-searches', (req, res) => {
  const db = getDbSafe(res)
  if (!db) return
  const profileId = req.query.profileId
  const rows = profileId
    ? db
        .prepare(
          `SELECT * FROM discovery_saved_searches
           WHERE profile_id = @profileId
           ORDER BY updated_at DESC`,
        )
        .all({ profileId })
    : db.prepare(`SELECT * FROM discovery_saved_searches ORDER BY updated_at DESC`).all()
  res.json({ data: rows.map(mapSavedSearch) })
})

router.post('/saved-searches', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const body = req.body ?? {}
    const id = uuid()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return res.status(400).json({ error: 'name is required' })
    }
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO discovery_saved_searches (
        id, template_id, profile_id, name, description, filters_json, schedule, last_run_at, created_at, updated_at
      ) VALUES (
        @id, @template_id, @profile_id, @name, @description, @filters_json, @schedule, @last_run_at, @created_at, @updated_at
      )`,
    ).run({
      id,
      template_id: body.template_id ?? null,
      profile_id: body.profile_id ?? null,
      name,
      description: body.description ?? null,
      filters_json: body.filters ? JSON.stringify(body.filters) : null,
      schedule: body.schedule ?? null,
      last_run_at: null,
      created_at: now,
      updated_at: now,
    })
    const created = db.prepare('SELECT * FROM discovery_saved_searches WHERE id = ?').get(id)
    res.status(201).json({ data: mapSavedSearch(created) })
  } catch (error) {
    next(error)
  }
})

router.patch('/saved-searches/:id', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const existing = db.prepare('SELECT * FROM discovery_saved_searches WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Saved search not found' })
    }

    const body = req.body ?? {}
    const updates = {}
    if (Object.prototype.hasOwnProperty.call(body, 'name')) updates.name = body.name
    if (Object.prototype.hasOwnProperty.call(body, 'description')) updates.description = body.description
    if (Object.prototype.hasOwnProperty.call(body, 'schedule')) updates.schedule = body.schedule
    if (Object.prototype.hasOwnProperty.call(body, 'last_run_at')) updates.last_run_at = body.last_run_at
    if (Object.prototype.hasOwnProperty.call(body, 'template_id')) updates.template_id = body.template_id
    if (Object.prototype.hasOwnProperty.call(body, 'profile_id')) updates.profile_id = body.profile_id
    if (Object.prototype.hasOwnProperty.call(body, 'filters')) {
      updates.filters_json = body.filters ? JSON.stringify(body.filters) : null
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ data: mapSavedSearch(existing) })
    }

    updates.updated_at = new Date().toISOString()

    const assignments = Object.keys(updates)
      .map((field) => `${field} = @${field}`)
      .join(', ')

    db.prepare(`UPDATE discovery_saved_searches SET ${assignments} WHERE id = @id`).run({
      ...updates,
      id: req.params.id,
    })

    const updated = db.prepare('SELECT * FROM discovery_saved_searches WHERE id = ?').get(req.params.id)
    res.json({ data: mapSavedSearch(updated) })
  } catch (error) {
    next(error)
  }
})

router.delete('/saved-searches/:id', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    db.prepare('DELETE FROM discovery_saved_searches WHERE id = ?').run(req.params.id)
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

router.post('/run', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const body = req.body ?? {}
    const templateId = body.templateId ?? null
    const profileId = body.profileId ?? null
    const overrideFilters = body.filters ?? {}
    const overrideQuery = typeof body.query === 'string' ? body.query : null
    const executedBy = body.executedBy ?? null

    let baseTemplate = null
    if (templateId) {
      baseTemplate = db.prepare('SELECT * FROM discovery_templates WHERE id = ?').get(templateId)
    }

    const effectiveFilters = {
      ...(baseTemplate?.filters_json ? JSON.parse(baseTemplate.filters_json) : {}),
      ...(overrideFilters && typeof overrideFilters === 'object' ? overrideFilters : {}),
    }
    const effectiveQuery = overrideQuery ?? baseTemplate?.query ?? ''

    const clauses = []
    const params = {}

    if (effectiveQuery) {
      clauses.push('(title LIKE @query OR description LIKE @query OR summary LIKE @query)')
      params.query = `%${effectiveQuery}%`
    }
    if (effectiveFilters.category) {
      clauses.push('category = @category')
      params.category = effectiveFilters.category
    }
    if (effectiveFilters.geography) {
      clauses.push('geography = @geography')
      params.geography = effectiveFilters.geography
    }
    if (Array.isArray(effectiveFilters.tags) && effectiveFilters.tags.length > 0) {
      const tagClauses = effectiveFilters.tags.map((tag, index) => {
        const key = `tag_${index}`
        params[key] = `%${tag}%`
        return `tags LIKE @${key}`
      })
      clauses.push(`(${tagClauses.join(' OR ')})`)
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const results = db
      .prepare(
        `SELECT * FROM funding_sources
         ${where}
         ORDER BY datetime(updated_at) DESC
         LIMIT 50`,
      )
      .all(params)

    const runId = uuid()
    db.prepare(
      `INSERT INTO discovery_runs (
        id, template_id, profile_id, query, filters_json, executed_by, result_count, created_at
      ) VALUES (
        @id, @template_id, @profile_id, @query, @filters_json, @executed_by, @result_count, @created_at
      )`,
    ).run({
      id: runId,
      template_id: baseTemplate?.id ?? null,
      profile_id: profileId,
      query: effectiveQuery,
      filters_json: JSON.stringify(effectiveFilters),
      executed_by: executedBy,
      result_count: results.length,
      created_at: new Date().toISOString(),
    })

    db.prepare(
      `INSERT INTO discovery_activity_log (
        id, source_id, type, message, metadata_json, created_at
      ) VALUES (
        @id, @source_id, @type, @message, @metadata_json, @created_at
      )`,
    ).run({
      id: uuid(),
      source_id: null,
      type: 'search_run',
      message: `Discovery search executed${baseTemplate ? ` using template "${baseTemplate.name}"` : ''}.`,
      metadata_json: JSON.stringify({
        runId,
        templateId: baseTemplate?.id ?? null,
        profileId,
        filters: effectiveFilters,
        resultCount: results.length,
      }),
      created_at: new Date().toISOString(),
    })

    res.status(201).json({
      data: results.map(mapOpportunity),
      run: { id: runId, result_count: results.length, query: effectiveQuery, filters: effectiveFilters },
    })
  } catch (error) {
    next(error)
  }
})

router.get('/opportunities', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const { search, category, geography, tag } = req.query
    const clauses = []
    const params = {}
    if (search) {
      clauses.push('(title LIKE @search OR description LIKE @search OR summary LIKE @search)')
      params.search = `%${search}%`
    }
    if (category) {
      clauses.push('category = @category')
      params.category = category
    }
    if (geography) {
      clauses.push('geography = @geography')
      params.geography = geography
    }
    if (tag) {
      clauses.push('tags LIKE @tag')
      params.tag = `%${tag}%`
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT * FROM funding_sources
         ${where}
         ORDER BY datetime(updated_at) DESC
         LIMIT 100`,
      )
      .all(params)
    res.json({ data: rows.map(mapOpportunity) })
  } catch (error) {
    next(error)
  }
})

router.get('/sources', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const rows = db.prepare('SELECT * FROM discovery_sources ORDER BY name').all()
    res.json({ data: rows.map(mapSource) })
  } catch (error) {
    next(error)
  }
})

router.patch('/sources/:id', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const existing = db.prepare('SELECT * FROM discovery_sources WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Data source not found' })
    }

    const body = req.body ?? {}
    const updates = {}
    if (Object.prototype.hasOwnProperty.call(body, 'name')) updates.name = body.name
    if (Object.prototype.hasOwnProperty.call(body, 'description')) updates.description = body.description
    if (Object.prototype.hasOwnProperty.call(body, 'status')) updates.status = body.status
    if (Object.prototype.hasOwnProperty.call(body, 'schedule')) updates.schedule = body.schedule
    if (Object.prototype.hasOwnProperty.call(body, 'region')) updates.region = body.region
    if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
      updates.metadata_json = body.metadata ? JSON.stringify(body.metadata) : null
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ data: mapSource(existing) })
    }

    const assignments = Object.keys(updates)
      .map((key) => `${key} = @${key}`)
      .join(', ')

    db.prepare(`UPDATE discovery_sources SET ${assignments} WHERE id = @id`).run({
      ...updates,
      id: req.params.id,
    })

    const updated = db.prepare('SELECT * FROM discovery_sources WHERE id = ?').get(req.params.id)
    res.json({ data: mapSource(updated) })
  } catch (error) {
    next(error)
  }
})

router.post('/sources/:id/run', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const existing = db.prepare('SELECT * FROM discovery_sources WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Data source not found' })
    }
    const now = new Date().toISOString()
    const success = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'success') ? Boolean(req.body.success) : true
    db.prepare(
      `UPDATE discovery_sources
       SET last_run_at = @now,
           last_success_at = CASE WHEN @success = 1 THEN @now ELSE last_success_at END,
           success_count = CASE WHEN @success = 1 THEN COALESCE(success_count, 0) + 1 ELSE success_count END,
           failure_count = CASE WHEN @success = 0 THEN COALESCE(failure_count, 0) + 1 ELSE failure_count END
       WHERE id = @id`,
    ).run({ id: req.params.id, now, success: success ? 1 : 0 })

    db.prepare(
      `INSERT INTO discovery_activity_log (
        id, source_id, type, message, metadata_json, created_at
      ) VALUES (
        @id, @source_id, @type, @message, @metadata_json, @created_at
      )`,
    ).run({
      id: uuid(),
      source_id: req.params.id,
      type: success ? 'source_run' : 'source_run_failure',
      message: success
        ? `Manual run triggered for ${existing.name}`
        : `Run for ${existing.name} reported a failure`,
      metadata_json: JSON.stringify({ sourceId: req.params.id }),
      created_at: now,
    })

    const updated = db.prepare('SELECT * FROM discovery_sources WHERE id = ?').get(req.params.id)
    res.json({ data: mapSource(updated) })
  } catch (error) {
    next(error)
  }
})

router.get('/activity', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const sourceId = req.query.sourceId
    const rows = sourceId
      ? db
          .prepare(
            `SELECT * FROM discovery_activity_log
             WHERE source_id = @sourceId OR source_id IS NULL
             ORDER BY datetime(created_at) DESC
             LIMIT 100`,
          )
          .all({ sourceId })
      : db.prepare(`SELECT * FROM discovery_activity_log ORDER BY datetime(created_at) DESC LIMIT 100`).all()
    res.json({ data: rows.map(mapActivity) })
  } catch (error) {
    next(error)
  }
})

router.get('/runs', (req, res, next) => {
  const db = getDbSafe(res)
  if (!db) return
  try {
    const rows = db
      .prepare(`SELECT * FROM discovery_runs ORDER BY datetime(created_at) DESC LIMIT 50`)
      .all()
    res.json({ data: rows.map(mapRun) })
  } catch (error) {
    next(error)
  }
})

export default router

