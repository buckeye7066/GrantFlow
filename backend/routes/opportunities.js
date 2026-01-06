import express from 'express';
import crypto from 'crypto';

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
    result.requires_match = matchPercentage && matchPercentage > 0 ? 1 : 0;
  } else {
    result.requires_match = requiresMatch ? 1 : 0;
  }

  if (matchPercentage !== null) {
    result.match_percentage = matchPercentage;
  } else {
    result.match_percentage = null;
  }

  if (result.requires_match === 1 && result.match_percentage === null) {
    throw new Error('Match percentage is required when "requires_match" is true');
  }

  if (result.requires_match === 0 && result.match_percentage !== null && result.match_percentage > 0) {
    throw new Error('Match percentage must be zero when "requires_match" is false');
  }

  return result;
}

function deriveCompliance(opportunity) {
  const reasons = [];
  const type = typeof opportunity.opportunity_type === 'string'
    ? opportunity.opportunity_type.trim().toLowerCase()
    : '';
  const requiresMatch = Number(opportunity.requires_match) === 1;
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
  if (requiresMatch !== null) {
    parsed.requires_match = requiresMatch ? 1 : 0;
  } else if (parsed.requires_match !== undefined && parsed.requires_match !== null) {
    parsed.requires_match = Number(parsed.requires_match) === 1 ? 1 : 0;
  } else {
    parsed.requires_match = 0;
  }

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
    conditions.push('COALESCE(requires_match, 0) = 0');
    conditions.push('COALESCE(match_percentage, 0) = 0');
  }
  return normalized;
}

// Search/list funding opportunities
router.get('/', (req, res) => {
  try {
    const {
      search,
      state,
      source,
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

    const conditions = ['is_active = 1'];
    const filterParams = [];

    applyComplianceFilters(compliance, conditions, filterParams);

    if (search) {
      const searchTerm = `%${search}%`;
      conditions.push('(title LIKE ? OR sponsor LIKE ? OR description LIKE ?)');
      filterParams.push(searchTerm, searchTerm, searchTerm);
    }

    if (state) {
      conditions.push('(state = ? OR is_national = 1)');
      filterParams.push(state);
    }

    if (isNational === 'true') {
      conditions.push('is_national = 1');
    }

    if (source) {
      conditions.push('source = ?');
      filterParams.push(source);
    }

    if (deadlineAfter) {
      conditions.push('(deadline_type = "rolling" OR (deadline IS NOT NULL AND deadline >= ?))');
      filterParams.push(deadlineAfter);
    }

    if (deadlineBefore) {
      conditions.push('(deadline IS NOT NULL AND deadline <= ?)');
      filterParams.push(deadlineBefore);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderClause = `
      ORDER BY
        CASE WHEN deadline IS NULL OR deadline = '' THEN 1 ELSE 0 END,
        deadline ASC,
        created_at DESC
    `;

    const opportunities = req.db
      .prepare(
        `
          SELECT *
          FROM funding_opportunities
          ${whereClause}
          ${orderClause}
          LIMIT ?
          OFFSET ?
        `,
      )
      .all(...filterParams, parsedLimit, parsedOffset);

    const parsed = opportunities.map((opp) => decorateOpportunity(opp));

    const countRow = req.db
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM funding_opportunities
          ${whereClause}
        `,
      )
      .get(...filterParams);

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
router.get('/:id', (req, res) => {
  try {
    const opp = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(req.params.id);

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
router.post('/', (req, res) => {
  try {
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

    req.db.prepare(`
      INSERT INTO funding_opportunities (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);

    const opp = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(id);
    res.status(201).json(decorateOpportunity(opp));
  } catch (error) {
    console.error('Error creating opportunity:', error);
    const status = error.message?.toLowerCase().includes('match percentage') ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

// Bulk import opportunities
router.post('/bulk', (req, res) => {
  try {
    const { opportunities } = req.body;

    if (!Array.isArray(opportunities)) {
      return res.status(400).json({ error: 'opportunities must be an array' });
    }

    const insertStmt = req.db.prepare(`
      INSERT OR REPLACE INTO funding_opportunities (
        id, title, sponsor, source, source_id, description, 
        eligibility_bullets, amount_min, amount_max, deadline, 
        deadline_type, application_url, is_national, state, 
        categories, keywords, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const insertMany = req.db.transaction((opps) => {
      let count = 0;
      for (const opp of opps) {
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
        insertStmt.run(
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
          newOpp.is_national ? 1 : 0,
          newOpp.state || null,
          JSON.stringify(newOpp.categories || []),
          JSON.stringify(newOpp.keywords || [])
        );
        count += 1;
      }
      return count;
    });

    const imported = insertMany(opportunities);

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
router.put('/:id', (req, res) => {
  try {
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

    req.db.prepare(`
      UPDATE funding_opportunities 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);

    const opp = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(req.params.id);
    res.json(decorateOpportunity(opp));
  } catch (error) {
    console.error('Error updating opportunity:', error);
    const status = error.message?.toLowerCase().includes('match percentage') ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

// Delete opportunity (soft delete)
router.delete('/:id', (req, res) => {
  try {
    req.db.prepare('UPDATE funding_opportunities SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Opportunity deactivated' });
  } catch (error) {
    console.error('Error deleting opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get distinct sources for filtering
router.get('/meta/sources', (req, res) => {
  try {
    const conditions = ['source IS NOT NULL', 'is_active = 1'];
    const params = [];
    applyComplianceFilters(req.query.compliance, conditions, params);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sources = req.db.prepare(`
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
router.get('/meta/states', (req, res) => {
  try {
    const conditions = ['state IS NOT NULL', 'is_active = 1'];
    const params = [];
    applyComplianceFilters(req.query.compliance, conditions, params);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const states = req.db.prepare(`
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
