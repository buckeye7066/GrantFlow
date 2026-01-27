import express from 'express';
import crypto from 'crypto';
import { isAdminUser, requireAuthenticatedUser } from '../utils/accessControl.js'

const router = express.Router();

const LOAN_TYPES = ['loan', 'loan_program', 'microloan'];
const JSON_ARRAY_FIELDS = ['eligibility_bullets', 'categories', 'keywords', 'regions'];

function safeParseJSON(value, fallback = []) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function coercePercentage(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeBoolean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', ''].includes(normalized)) return false;
  }
  return null;
}

function normalizePercentage(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Match percentage must be a number');
  }
  if (parsed < 0) {
    throw new Error('Match percentage cannot be negative');
  }
  if (parsed > 100) {
    throw new Error('Match percentage cannot exceed 100');
  }
  return parsed;
}

function validateFundingTerms(payload = {}) {
  const result = { ...payload };
  const requiresMatch = normalizeBoolean(result.requires_match);
  const matchPercentage = normalizePercentage(
    result.match_percentage !== undefined ? result.match_percentage : undefined,
  );

  if (requiresMatch === null) {
    result.requires_match = Boolean(matchPercentage && matchPercentage > 0);
  } else {
    result.requires_match = Boolean(requiresMatch);
  }

  if (matchPercentage !== null) {
    result.match_percentage = matchPercentage;
  } else {
    result.match_percentage = null;
  }

  if (result.requires_match === true && result.match_percentage === null) {
    throw new Error('Match percentage is required when "requires_match" is true');
  }

  if (result.requires_match === false && result.match_percentage !== null && result.match_percentage > 0) {
    throw new Error('Match percentage must be zero when "requires_match" is false');
  }

  return result;
}

function deriveCompliance(opportunity) {
  const reasons = [];
  const type = typeof opportunity.opportunity_type === 'string'
    ? opportunity.opportunity_type.trim().toLowerCase()
    : '';
  const requiresMatch = normalizeBoolean(opportunity.requires_match) === true;
  const matchPercentage = coercePercentage(opportunity.match_percentage);

  if (type && LOAN_TYPES.includes(type)) {
    reasons.push('Listed as a loan or repayment program');
  }
  if (requiresMatch) {
    reasons.push('Requires matching funds');
  }
  if (matchPercentage !== null && matchPercentage > 0) {
    reasons.push(`Match percentage ${matchPercentage}%`);
  }

  if (reasons.length === 0) {
    return {
      status: 'compliant',
      reasons: ['No repayment or match requirements detected.'],
    };
  }

  return {
    status: 'requires_review',
    reasons,
  };
}

function decorateOpportunity(row) {
  if (!row) return null;
  const parsed = { ...row };

  JSON_ARRAY_FIELDS.forEach((field) => {
    parsed[field] = safeParseJSON(parsed[field], []);
  });
  parsed.match_reasons = safeParseJSON(parsed.match_reasons, []);

  const requiresMatch = normalizeBoolean(parsed.requires_match);
  if (requiresMatch !== null) parsed.requires_match = requiresMatch;
  else parsed.requires_match = false;

  const matchPercentage = coercePercentage(parsed.match_percentage);
  parsed.match_percentage = matchPercentage;

  const compliance = deriveCompliance(parsed);
  parsed.compliance_status = compliance.status;
  parsed.compliance_reasons = compliance.reasons;

  return parsed;
}

function applyComplianceFilters(compliance, conditions, params) {
  const normalized = (compliance || 'grant_only').toLowerCase();
  if (normalized === 'grant_only') {
    conditions.push('(opportunity_type IS NULL OR LOWER(opportunity_type) NOT IN (?, ?, ?))');
    params.push(...LOAN_TYPES);

    if (params.__dialect === 'postgres') {
      conditions.push('(requires_match IS NULL OR requires_match = FALSE)');
    } else {
      // Explicitly allow NULL, 0, '0', false, 'false'
      conditions.push("(requires_match IS NULL OR requires_match = 0 OR requires_match = '0' OR requires_match = 'false')");
    }
    if (params.__dialect === 'postgres') {
      conditions.push('(match_percentage IS NULL OR match_percentage = 0)');
    } else {
      conditions.push("(match_percentage IS NULL OR match_percentage = 0 OR match_percentage = '0')");
    }
  }
  return normalized;
}

function likeOperatorForDb(db) {
  return db?.dialect === 'postgres' ? 'ILIKE' : 'LIKE';
}

// Search/list funding opportunities
router.get('/', async (req, res) => {
  try {
    const {
      search,
      state,
      source,
      geo_run_id: geoRunIdParam,
      run_id: runIdParam,
      deadline_after: deadlineAfter,
      deadline_before: deadlineBefore,
      is_national: isNational,
      limit = 50,
      offset = 0,
      compliance,
    } = req.query;

    // Allow fetching all opportunities - no arbitrary cap
    const parsedLimit = Number.parseInt(limit, 10) || 10000;
    const parsedOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);

    const geoRunId = geoRunIdParam ?? runIdParam ?? null

    // Geo-run filtering is performed via the geo index table so we can:
    // - preserve global de-dupe (one opportunity row)
    // - still show per-zip/per-state associations for a run
    //
    // Production safety: older DBs may not have the geo index table yet; we fall back to
    // filtering on funding_opportunities.geo_run_id if the join table is missing.
    const primaryFromClause = geoRunId
      ? `FROM funding_opportunities fo JOIN funding_opportunity_geo_index gi ON gi.opportunity_id = fo.id`
      : `FROM funding_opportunities`
    const fallbackFromClause = geoRunId ? `FROM funding_opportunities fo` : `FROM funding_opportunities`

    const baseConditions = geoRunId ? ['fo.is_active = ?'] : ['is_active = ?'];
    const baseParams = [true];

    // Pass dialect through params for applyComplianceFilters.
    baseParams.__dialect = req.db?.dialect;
    applyComplianceFilters(compliance, baseConditions, baseParams);

    if (search) {
      const searchTerm = `%${search}%`;
      const likeOp = likeOperatorForDb(req.db);
      baseConditions.push(
        geoRunId
          ? `(fo.title ${likeOp} ? OR fo.sponsor ${likeOp} ? OR fo.description ${likeOp} ?)`
          : `(title ${likeOp} ? OR sponsor ${likeOp} ? OR description ${likeOp} ?)`,
      );
      baseParams.push(searchTerm, searchTerm, searchTerm);
    }

    const normalizedState = state ? String(state).toUpperCase() : null;

    if (isNational === 'true') {
      baseConditions.push(geoRunId ? 'fo.is_national = ?' : 'is_national = ?');
      baseParams.push(true);
    }

    if (source) {
      baseConditions.push(geoRunId ? 'fo.source = ?' : 'source = ?');
      baseParams.push(source);
    }

    if (deadlineAfter) {
      baseConditions.push('(deadline_type = "rolling" OR (deadline IS NOT NULL AND deadline >= ?))');
      baseParams.push(deadlineAfter);
    }

    if (deadlineBefore) {
      baseConditions.push('(deadline IS NOT NULL AND deadline <= ?)');
      baseParams.push(deadlineBefore);
    }

    if (geoRunId) {
      baseConditions.push('gi.geo_run_id = ?')
      baseParams.push(String(geoRunId))
    }

    const conditions = [...baseConditions];
    const filterParams = [...baseParams];

    if (normalizedState) {
      // Default behavior includes both state + national.
      conditions.push(geoRunId ? '(fo.state = ? OR fo.is_national = ?)' : '(state = ? OR is_national = ?)');
      filterParams.push(normalizedState);
      filterParams.push(true);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderClause =
      req.db?.dialect === 'postgres'
        ? `
            ORDER BY
              CASE WHEN deadline IS NULL THEN 1 ELSE 0 END,
              deadline ASC,
              created_at DESC
          `
        : `
            ORDER BY
              CASE WHEN deadline IS NULL OR deadline = '' THEN 1 ELSE 0 END,
              deadline ASC,
              created_at DESC
          `;

    // If state-scoped and first page, guarantee >=3 national opportunities are included
    // (without changing total counts or hiding crawler failures).
    const minNationalVisible = Math.max(
      Number.parseInt(process.env.MIN_NATIONAL_VISIBLE || '3', 10) || 3,
      0,
    );

    async function runQuery({ fromClause, whereClauseSql, baseConditionsSql, useGeoIndex }) {
      let opportunities
      if (normalizedState && parsedOffset === 0 && isNational !== 'true' && parsedLimit > 0 && minNationalVisible > 0) {
      const commonWhere = baseConditions.length ? `WHERE ${baseConditions.join(' AND ')}` : 'WHERE 1=1';

      const nationals = req.db
        .prepare(
          `
            SELECT ${
              geoRunId && useGeoIndex
                ? 'fo.*, gi.geo_run_id as geo_run_id, gi.zip as geo_zip, gi.county as geo_county, gi.source as geo_source'
                : geoRunId
                  ? 'fo.*'
                  : '*'
            }
            ${fromClause}
            ${commonWhere}
              AND ${geoRunId ? 'fo.is_national' : 'is_national'} = ?
            ${orderClause}
            LIMIT ?
          `,
        )
        .all(...baseParams, true, minNationalVisible);

      const remaining = Math.max(parsedLimit - nationals.length, 0);
      const locals = remaining > 0
        ? req.db
            .prepare(
              `
                SELECT ${
                  geoRunId && useGeoIndex
                    ? 'fo.*, gi.geo_run_id as geo_run_id, gi.zip as geo_zip, gi.county as geo_county, gi.source as geo_source'
                    : geoRunId
                      ? 'fo.*'
                      : '*'
                }
                ${fromClause}
                ${commonWhere}
                  AND ${geoRunId ? 'fo.state' : 'state'} = ?
                  AND (${geoRunId ? 'fo.is_national' : 'is_national'} IS NULL OR ${geoRunId ? 'fo.is_national' : 'is_national'} = ?)
                ${orderClause}
                LIMIT ?
              `,
            )
            .all(...baseParams, normalizedState, false, remaining)
        : [];

      // Return locals first, then nationals to guarantee visibility in the response.
      opportunities = [...locals, ...nationals];
      } else {
        opportunities = await req.db
        .prepare(
          `
            SELECT ${
              geoRunId && useGeoIndex
                ? 'fo.*, gi.geo_run_id as geo_run_id, gi.zip as geo_zip, gi.county as geo_county, gi.source as geo_source'
                : geoRunId
                  ? 'fo.*'
                  : '*'
            }
            ${fromClause}
            ${whereClauseSql}
            ${orderClause}
            LIMIT ?
            OFFSET ?
          `,
        )
        .all(...filterParams, parsedLimit, parsedOffset);
      }
      return opportunities
    }

    let opportunities;
    try {
      opportunities = await runQuery({ fromClause: primaryFromClause, whereClauseSql: whereClause, baseConditionsSql: baseConditions, useGeoIndex: Boolean(geoRunId) })
    } catch (err) {
      const msg = String(err?.message || err)
      const missingGeoIndex =
        geoRunId &&
        (msg.includes('funding_opportunity_geo_index') || msg.includes('relation') || msg.includes('does not exist'))
      if (!missingGeoIndex) throw err

      // Fallback: older DB without geo index table
      const fallbackBaseConditions = baseConditions.map((c) => (c === 'gi.geo_run_id = ?' ? 'fo.geo_run_id = ?' : c))
      const fallbackConditions = conditions.map((c) => (c === 'gi.geo_run_id = ?' ? 'fo.geo_run_id = ?' : c))
      const fallbackWhere = fallbackConditions.length ? `WHERE ${fallbackConditions.join(' AND ')}` : ''

      // Replace the in-scope arrays used by runQuery
      baseConditions.length = 0
      baseConditions.push(...fallbackBaseConditions)
      conditions.length = 0
      conditions.push(...fallbackConditions)

      opportunities = await runQuery({ fromClause: fallbackFromClause, whereClauseSql: fallbackWhere, baseConditionsSql: fallbackBaseConditions, useGeoIndex: false })
    }

    const parsed = opportunities.map((opp) => decorateOpportunity(opp));

    let countRow = null
    try {
      countRow = await req.db
        .prepare(
          `
            SELECT COUNT(*) AS total
            ${primaryFromClause}
            ${whereClause}
          `,
        )
        .get(...filterParams);
    } catch (err) {
      const msg = String(err?.message || err)
      const missingGeoIndex =
        geoRunId &&
        (msg.includes('funding_opportunity_geo_index') || msg.includes('relation') || msg.includes('does not exist'))
      if (!missingGeoIndex) throw err
      countRow = await req.db
        .prepare(
          `
            SELECT COUNT(*) AS total
            ${fallbackFromClause}
            ${whereClause.replaceAll('gi.geo_run_id', 'fo.geo_run_id')}
          `,
        )
        .get(...filterParams);
    }

    res.json({
      data: parsed,
      total: countRow?.total ?? parsed.length,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  } catch (error) {
    console.error('Error listing opportunities:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single opportunity
router.get('/:id', async (req, res) => {
  try {
    const opp = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(req.params.id);

    if (!opp) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    res.json(decorateOpportunity(opp));
  } catch (error) {
    console.error('Error getting opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create opportunity (for manual entry or crawlers)
router.post('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    if (!isAdminUser(user)) {
      return res.status(403).json({ error: 'Admin privileges required' })
    }

    const id = crypto.randomUUID();
    let data = validateFundingTerms(req.body || {});
    const normalizedData = Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    );

    JSON_ARRAY_FIELDS.forEach((field) => {
      if (Array.isArray(normalizedData[field])) {
        normalizedData[field] = JSON.stringify(normalizedData[field]);
      }
    });
    if (Array.isArray(normalizedData.match_reasons)) {
      normalizedData.match_reasons = JSON.stringify(normalizedData.match_reasons);
    }

    const columns = ['id', ...Object.keys(normalizedData)];
    const placeholders = columns.map(() => '?').join(', ');
    const values = [id, ...Object.values(normalizedData)];

    await req.db.prepare(`
      INSERT INTO funding_opportunities (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);

    const opp = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(id);
    res.status(201).json(decorateOpportunity(opp));
  } catch (error) {
    console.error('Error creating opportunity:', error);
    const status = error.message?.toLowerCase().includes('match percentage') ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

// Bulk import opportunities
router.post('/bulk', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    if (!isAdminUser(user)) {
      return res.status(403).json({ error: 'Admin privileges required' })
    }

    const { opportunities } = req.body;

    if (!Array.isArray(opportunities)) {
      return res.status(400).json({ error: 'opportunities must be an array' });
    }

    const upsertSql = `
      INSERT INTO funding_opportunities (
        id, title, sponsor, source, source_id, description,
        eligibility_bullets, amount_min, amount_max, deadline,
        deadline_type, application_url, is_national, state,
        categories, keywords, is_active, requires_match, match_percentage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        sponsor = EXCLUDED.sponsor,
        source = EXCLUDED.source,
        source_id = EXCLUDED.source_id,
        description = EXCLUDED.description,
        eligibility_bullets = EXCLUDED.eligibility_bullets,
        amount_min = EXCLUDED.amount_min,
        amount_max = EXCLUDED.amount_max,
        deadline = EXCLUDED.deadline,
        deadline_type = EXCLUDED.deadline_type,
        application_url = EXCLUDED.application_url,
        is_national = EXCLUDED.is_national,
        state = EXCLUDED.state,
        categories = EXCLUDED.categories,
        keywords = EXCLUDED.keywords,
        is_active = EXCLUDED.is_active,
        requires_match = EXCLUDED.requires_match,
        match_percentage = EXCLUDED.match_percentage,
        updated_at = CURRENT_TIMESTAMP
    `;

    const imported = await req.db.withTransaction(async (tx) => {
      const insertStmt = tx.prepare(upsertSql);
      let count = 0;
      for (const opp of opportunities) {
        const newOpp = { ...opp };
        if (newOpp.requires_match !== undefined || newOpp.match_percentage !== undefined) {
          try {
            const validated = validateFundingTerms(newOpp);
            newOpp.requires_match = validated.requires_match;
            newOpp.match_percentage = validated.match_percentage;
          } catch {
            // Ignore validation errors for bulk import to avoid disruption; flagged via compliance status later.
          }
        }
        const id = newOpp.id || crypto.randomUUID();
        await insertStmt.run(
          id,
          newOpp.title,
          newOpp.sponsor || null,
          newOpp.source || null,
          newOpp.source_id || null,
          newOpp.description || null,
          JSON.stringify(newOpp.eligibility_bullets || []),
          newOpp.amount_min || null,
          newOpp.amount_max || null,
          newOpp.deadline || null,
          newOpp.deadline_type || 'unknown',
          newOpp.application_url || null,
          Boolean(newOpp.is_national),
          newOpp.state || null,
          JSON.stringify(newOpp.categories || []),
          JSON.stringify(newOpp.keywords || []),
          true,
          newOpp.requires_match === undefined ? false : Boolean(newOpp.requires_match),
          newOpp.match_percentage ?? null,
        );
        count += 1;
      }
      return count;
    });

    res.json({
      success: true,
      imported,
      message: `Imported ${imported} opportunities`,
    });
  } catch (error) {
    console.error('Error bulk importing opportunities:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update opportunity
router.put('/:id', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    if (!isAdminUser(user)) {
      return res.status(403).json({ error: 'Admin privileges required' })
    }

    let data = validateFundingTerms(req.body || {});
    const normalizedData = Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    );

    JSON_ARRAY_FIELDS.forEach((field) => {
      if (Array.isArray(normalizedData[field])) {
        normalizedData[field] = JSON.stringify(normalizedData[field]);
      }
    });
    if (Array.isArray(normalizedData.match_reasons)) {
      normalizedData.match_reasons = JSON.stringify(normalizedData.match_reasons);
    }

    const setClause = Object.keys(normalizedData).map((key) => `${key} = ?`).join(', ');
    const values = [...Object.values(normalizedData), req.params.id];

    await req.db.prepare(`
      UPDATE funding_opportunities 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);

    const opp = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(req.params.id);
    res.json(decorateOpportunity(opp));
  } catch (error) {
    console.error('Error updating opportunity:', error);
    const status = error.message?.toLowerCase().includes('match percentage') ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

// Delete opportunity (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    if (!isAdminUser(user)) {
      return res.status(403).json({ error: 'Admin privileges required' })
    }

    await req.db.prepare('UPDATE funding_opportunities SET is_active = ? WHERE id = ?').run(false, req.params.id);
    res.json({ success: true, message: 'Opportunity deactivated' });
  } catch (error) {
    console.error('Error deleting opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get ingestion status
router.get('/meta/ingestion', async (req, res) => {
  try {
    const { getIngestionStatus } = await import('../services/sources/ingestionService.js');
    const status = getIngestionStatus(req.db);
    res.json(status);
  } catch (error) {
    console.error('Error getting ingestion status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get distinct sources for filtering
router.get('/meta/sources', async (req, res) => {
  try {
    const conditions = ['source IS NOT NULL', 'is_active = ?'];
    const params = [];
    params.push(true);
    params.__dialect = req.db?.dialect;
    applyComplianceFilters(req.query.compliance, conditions, params);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sources = await req.db.prepare(`
      SELECT source, COUNT(*) as count 
      FROM funding_opportunities 
      ${whereClause}
      GROUP BY source 
      ORDER BY count DESC
    `).all(...params);

    res.json(sources);
  } catch (error) {
    console.error('Error getting sources:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get distinct states for filtering
router.get('/meta/states', async (req, res) => {
  try {
    const conditions = ['state IS NOT NULL', 'is_active = ?'];
    const params = [];
    params.push(true);
    params.__dialect = req.db?.dialect;
    applyComplianceFilters(req.query.compliance, conditions, params);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const states = await req.db.prepare(`
      SELECT state, COUNT(*) as count 
      FROM funding_opportunities 
      ${whereClause}
      GROUP BY state 
      ORDER BY state ASC
    `).all(...params);

    res.json(states);
  } catch (error) {
    console.error('Error getting states:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
