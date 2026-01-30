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
  // Internal query-only fields must never leak to API clients.
  if (Object.prototype.hasOwnProperty.call(parsed, '__rn')) delete parsed.__rn;

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

function applyComplianceFilters(compliance, conditions, params, options = {}) {
  const normalized = (compliance || 'grant_only').toLowerCase();
  const prefix = typeof options.prefix === 'string' ? options.prefix : '';
  if (normalized === 'grant_only') {
    conditions.push(`(${prefix}opportunity_type IS NULL OR LOWER(${prefix}opportunity_type) NOT IN (?, ?, ?))`);
    params.push(...LOAN_TYPES);
  }

  // Optional stricter mode: exclude matching-funds requirements.
  // IMPORTANT: matching funds are not an exclusive eligibility gate; default behavior should not filter them out.
  // Reversible via env var for deployments that still want the legacy behavior.
  const legacyGrantOnlyExcludesMatch =
    String(process.env.LEGACY_GRANT_ONLY_EXCLUDES_MATCHING ?? '').toLowerCase() === 'true'
  const wantsNoMatch =
    normalized === 'no_match' ||
    normalized === 'grant_no_match' ||
    (normalized === 'grant_only' && legacyGrantOnlyExcludesMatch)

  if (wantsNoMatch) {
    if (params.__dialect === 'postgres') {
      conditions.push(`(${prefix}requires_match IS NULL OR ${prefix}requires_match = FALSE)`);
      conditions.push(`(${prefix}match_percentage IS NULL OR ${prefix}match_percentage = 0)`);
    } else {
      // Explicitly allow NULL, 0, '0', false, 'false'
      conditions.push(
        `(${prefix}requires_match IS NULL OR ${prefix}requires_match = 0 OR ${prefix}requires_match = '0' OR ${prefix}requires_match = 'false')`,
      );
      conditions.push(
        `(${prefix}match_percentage IS NULL OR ${prefix}match_percentage = 0 OR ${prefix}match_percentage = '0')`,
      );
    }
  }
  return normalized;
}

function likeOperatorForDb(db) {
  return db?.dialect === 'postgres' ? 'ILIKE' : 'LIKE';
}

function normalizeUrlForDedupe(url) {
  if (!url || typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;
  try {
    // Normalize scheme/host/path; drop hash + common tracking params.
    const u = new URL(raw);
    u.hash = '';
    const drop = new Set([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'mc_cid',
      'mc_eid',
    ]);
    Array.from(u.searchParams.keys()).forEach((k) => {
      if (drop.has(String(k).toLowerCase())) u.searchParams.delete(k);
    });
    const normalized =
      `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/g, '').toLowerCase() +
      (u.search ? `?${u.searchParams.toString()}` : '');
    return normalized || null;
  } catch {
    // Best-effort for malformed URLs.
    return raw.replace(/\/+$/g, '').toLowerCase();
  }
}

function dedupeKeyFromRow(row) {
  if (!row) return null;
  const url = normalizeUrlForDedupe(row.application_url) || normalizeUrlForDedupe(row.source_url);
  const title = String(row.title || '').trim().toLowerCase();
  const sponsor = String(row.sponsor || '').trim().toLowerCase();
  const deadline = String(row.deadline || '').trim().toLowerCase();
  // Primary: collapse cross-source duplicates (even when URLs/IDs differ).
  if (title && sponsor) return `tsd:${title}::${sponsor}::${deadline}`;
  if (title && deadline) return `td:${title}::${deadline}`;
  const sourceId = row.source_id != null ? String(row.source_id).trim().toLowerCase() : '';
  if (sourceId) return `sid:${sourceId}`;
  if (url) return `url:${url}`;
  return row.id ? `id:${String(row.id)}` : null;
}

function dedupeKeySql(prefix, { useGeoIndex }) {
  // For geo runs, prevent duplicates from many geo_index rows per opportunity.
  if (useGeoIndex) return `${prefix}id`;
  // Otherwise, dedupe by strongest stable identifiers first:
  // - source_id (shared across crawlers for the same government opportunity)
  // - title+sponsor+deadline (collapses cross-source duplicates with different URLs)
  // - URL (best-effort)
  // - id (fallback)
  //
  // NOTE: we do not strip tracking params in SQL; we handle that in the JS guardrail below.
  const titleExpr = `NULLIF(LOWER(TRIM(${prefix}title)), '')`;
  const sponsorExpr = `COALESCE(LOWER(TRIM(${prefix}sponsor)), '')`;
  const deadlineExpr = `COALESCE(LOWER(TRIM(CAST(${prefix}deadline AS TEXT))), '')`;
  const tsdExpr = `CASE WHEN ${titleExpr} IS NOT NULL AND ${sponsorExpr} <> '' THEN (${titleExpr} || '::' || ${sponsorExpr} || '::' || ${deadlineExpr}) ELSE NULL END`;
  const tdExpr = `CASE WHEN ${titleExpr} IS NOT NULL AND ${deadlineExpr} <> '' THEN (${titleExpr} || '::' || ${deadlineExpr}) ELSE NULL END`;
  const sourceIdExpr = `NULLIF(LOWER(TRIM(${prefix}source_id)), '')`;
  const urlExpr = `COALESCE(NULLIF(LOWER(TRIM(${prefix}application_url)), ''), NULLIF(LOWER(TRIM(${prefix}source_url)), ''))`;
  return `COALESCE(${tsdExpr}, ${tdExpr}, ${sourceIdExpr}, ${urlExpr}, ${prefix}id)`;
}

function coerceBooleanToSqlite(value) {
  const normalized = normalizeBoolean(value);
  if (normalized === null) return null;
  return normalized ? 1 : 0;
}

function normalizeSqlitePayload(payload) {
  const result = { ...payload };
  // SQLite bindings cannot accept raw booleans.
  if (result.is_national !== undefined) {
    result.is_national = coerceBooleanToSqlite(result.is_national) ?? 0;
  }
  if (result.is_active !== undefined) {
    result.is_active = coerceBooleanToSqlite(result.is_active) ?? 0;
  }
  if (result.requires_501c3 !== undefined) {
    result.requires_501c3 = coerceBooleanToSqlite(result.requires_501c3) ?? 0;
  }
  return result;
}

function normalizePayloadForDb(payload, db) {
  if (db?.dialect === 'sqlite') return normalizeSqlitePayload(payload);
  return payload;
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

    const dialect = req.db?.dialect;
    const sqliteBool = (value) => (value ? 1 : 0)
    const sqlBool = (value) => (dialect === 'sqlite' ? sqliteBool(value) : Boolean(value))
    const requestedCompliance = (compliance || 'grant_only').toLowerCase();

    const geoRunId = geoRunIdParam ?? runIdParam ?? null;
    const hasGeoRun = Boolean(geoRunId);
    const prefix = hasGeoRun ? 'fo.' : '';

    // Geo-run filtering is performed via the geo index table so we can:
    // - preserve global de-dupe (one opportunity row)
    // - still show per-zip/per-state associations for a run
    //
    // Production safety: older DBs may not have the geo index table yet; we fall back to
    // filtering on funding_opportunities.geo_run_id if the join table is missing.
    const primaryFromClause = hasGeoRun
      ? `FROM funding_opportunities fo JOIN funding_opportunity_geo_index gi ON gi.opportunity_id = fo.id`
      : `FROM funding_opportunities`;
    const fallbackFromClause = hasGeoRun ? `FROM funding_opportunities fo` : `FROM funding_opportunities`;

    const baseConditions = [`${prefix}is_active = ?`];
    const baseParams = [sqlBool(true)];

    if (search) {
      const searchTerm = `%${search}%`;
      const likeOp = likeOperatorForDb(req.db);
      baseConditions.push(`(${prefix}title ${likeOp} ? OR ${prefix}sponsor ${likeOp} ? OR ${prefix}description ${likeOp} ?)`);
      baseParams.push(searchTerm, searchTerm, searchTerm);
    }

    const normalizedState = state ? String(state).toUpperCase() : null;

    if (isNational === 'true') {
      baseConditions.push(`${prefix}is_national = ?`);
      baseParams.push(sqlBool(true));
    }

    if (source) {
      baseConditions.push(`${prefix}source = ?`);
      baseParams.push(source);
    }

    if (deadlineAfter) {
      // SQLite treats double-quoted strings as identifiers, not string literals.
      // Use single quotes so deadline filters do not break Discover Grants.
      baseConditions.push(`(${prefix}deadline_type = 'rolling' OR (${prefix}deadline IS NOT NULL AND ${prefix}deadline >= ?))`);
      baseParams.push(deadlineAfter);
    }

    if (deadlineBefore) {
      baseConditions.push(`(${prefix}deadline IS NOT NULL AND ${prefix}deadline <= ?)`);
      baseParams.push(deadlineBefore);
    }

    if (hasGeoRun) {
      baseConditions.push('gi.geo_run_id = ?');
      baseParams.push(String(geoRunId));
    }

    // Apply compliance on a copy, preserving the base query for fallback behavior.
    const filteredConditions = [...baseConditions];
    const filteredParams = [...baseParams];
    filteredParams.__dialect = dialect;
    const normalizedCompliance = applyComplianceFilters(requestedCompliance, filteredConditions, filteredParams, { prefix });

    const stateCondition = normalizedState ? `(${prefix}state = ? OR ${prefix}is_national = ?)` : null;

    const baseWithStateConditions = [...baseConditions];
    const baseWithStateParams = [...baseParams];
    const filteredWithStateConditions = [...filteredConditions];
    const filteredWithStateParams = [...filteredParams];

    if (stateCondition) {
      baseWithStateConditions.push(stateCondition);
      baseWithStateParams.push(normalizedState, sqlBool(true));
      filteredWithStateConditions.push(stateCondition);
      filteredWithStateParams.push(normalizedState, sqlBool(true));
    }

    const whereClause = filteredWithStateConditions.length ? `WHERE ${filteredWithStateConditions.join(' AND ')}` : '';

    const orderClause =
      dialect === 'postgres'
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

    const deadlineColInner = hasGeoRun ? 'fo.deadline' : 'deadline';
    const createdColInner = hasGeoRun ? 'fo.created_at' : 'created_at';
    const orderColsInner =
      dialect === 'postgres'
        ? `
            CASE WHEN ${deadlineColInner} IS NULL THEN 1 ELSE 0 END,
            ${deadlineColInner} ASC,
            ${createdColInner} DESC
          `
        : `
            CASE WHEN ${deadlineColInner} IS NULL OR ${deadlineColInner} = '' THEN 1 ELSE 0 END,
            ${deadlineColInner} ASC,
            ${createdColInner} DESC
          `;

    // If state-scoped and first page, guarantee >=3 national opportunities are included
    // (without changing total counts or hiding crawler failures).
    const minNationalVisible = Math.max(
      Number.parseInt(process.env.MIN_NATIONAL_VISIBLE || '3', 10) || 3,
      0,
    );

    function selectFields(useGeoIndex) {
      if (hasGeoRun && useGeoIndex) {
        return 'fo.*, gi.geo_run_id as geo_run_id, gi.zip as geo_zip, gi.county as geo_county, gi.source as geo_source';
      }
      if (hasGeoRun) return 'fo.*';
      return '*';
    }

    async function runQuery({
      fromClause,
      whereClauseSql,
      queryParams,
      baseConditionsSql,
      baseParamsSql,
      useGeoIndex,
    }) {
      const keyExpr = dedupeKeySql(hasGeoRun ? 'fo.' : '', { useGeoIndex: Boolean(useGeoIndex && hasGeoRun) });

      async function runListQuery(whereSql, params, { limit: qLimit, offset: qOffset } = {}) {
        const effectiveLimit = Number.isFinite(Number(qLimit)) ? Number(qLimit) : parsedLimit;
        const effectiveOffset = Number.isFinite(Number(qOffset)) ? Number(qOffset) : parsedOffset;
        // Prefer deterministic de-dupe at the SQL layer (window functions), so pagination stays stable.
        // If a deployment uses an older SQLite build without window functions, we fall back to raw rows
        // and de-dupe in JS later.
        try {
          return await req.db
            .prepare(
              `
                SELECT t.*
                FROM (
                  SELECT
                    ${selectFields(useGeoIndex)},
                    ROW_NUMBER() OVER (PARTITION BY ${keyExpr} ORDER BY ${orderColsInner}) AS __rn
                  ${fromClause}
                  ${whereSql}
                ) t
                WHERE t.__rn = 1
                ${orderClause}
                LIMIT ?
                OFFSET ?
              `,
            )
            .all(...params, effectiveLimit, effectiveOffset);
        } catch (err) {
          const msg = String(err?.message || err);
          const isWindowMissing =
            msg.toLowerCase().includes('row_number') ||
            msg.toLowerCase().includes('over') ||
            msg.toLowerCase().includes('window') ||
            msg.toLowerCase().includes('syntax error');
          if (!isWindowMissing) throw err;
          // Fallback: no SQL de-dupe.
          return await req.db
            .prepare(
              `
                SELECT ${selectFields(useGeoIndex)}
                ${fromClause}
                ${whereSql}
                ${orderClause}
                LIMIT ?
                OFFSET ?
              `,
            )
            .all(...params, effectiveLimit, effectiveOffset);
        }
      }

      if (normalizedState && parsedOffset === 0 && isNational !== 'true' && parsedLimit > 0 && minNationalVisible > 0) {
        const commonWhere = baseConditionsSql.length ? `WHERE ${baseConditionsSql.join(' AND ')}` : 'WHERE 1=1';

        const nationals = await runListQuery(
          `${commonWhere} AND ${hasGeoRun ? 'fo.is_national' : 'is_national'} = ?`,
          [...baseParamsSql, sqlBool(true)],
          { limit: minNationalVisible, offset: 0 },
        );

        const remaining = Math.max(parsedLimit - nationals.length, 0);
        const locals = remaining > 0
          ? await (async () => {
              const whereSql =
                `${commonWhere}` +
                ` AND ${hasGeoRun ? 'fo.state' : 'state'} = ?` +
                ` AND (${hasGeoRun ? 'fo.is_national' : 'is_national'} IS NULL OR ${hasGeoRun ? 'fo.is_national' : 'is_national'} = ?)`;
              return await runListQuery(whereSql, [...baseParamsSql, normalizedState, sqlBool(false)], { limit: remaining, offset: 0 });
            })()
          : [];

        // Return locals first, then nationals to guarantee visibility in the response.
        return [...locals, ...nationals];
      }

      return await runListQuery(whereClauseSql, queryParams);
    }

    function isMissingGeoIndexError(err) {
      if (!hasGeoRun) return false;
      const msg = String(err?.message || err);
      return (
        msg.includes('funding_opportunity_geo_index') ||
        msg.includes('relation') ||
        msg.includes('does not exist')
      );
    }

    function replaceGeoIndexCondition(conds) {
      return conds.map((c) => (c === 'gi.geo_run_id = ?' ? 'fo.geo_run_id = ?' : c));
    }

    async function listAndCount({
      fromClause,
      whereClauseSql,
      queryParams,
      baseConditionsSql,
      baseParamsSql,
      useGeoIndex,
    }) {
      const rows = await runQuery({
        fromClause,
        whereClauseSql,
        queryParams,
        baseConditionsSql,
        baseParamsSql,
        useGeoIndex,
      });

      const keyExpr = dedupeKeySql(hasGeoRun ? 'fo.' : '', { useGeoIndex: Boolean(useGeoIndex && hasGeoRun) });
      const countRow = await req.db
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM (
              SELECT 1
              ${fromClause}
              ${whereClauseSql}
              GROUP BY ${keyExpr}
            ) t
          `,
        )
        .get(...queryParams);

      return { rows, total: countRow?.total ?? rows.length };
    }

    let effectiveFromClause = primaryFromClause;
    let effectiveUseGeoIndex = hasGeoRun;

    let result;
    try {
      result = await listAndCount({
        fromClause: effectiveFromClause,
        whereClauseSql: whereClause,
        queryParams: filteredWithStateParams,
        baseConditionsSql: filteredConditions,
        baseParamsSql: filteredParams,
        useGeoIndex: effectiveUseGeoIndex,
      });
    } catch (err) {
      if (!isMissingGeoIndexError(err)) throw err;

      effectiveFromClause = fallbackFromClause;
      effectiveUseGeoIndex = false;

      const fallbackBaseConditions = replaceGeoIndexCondition(baseConditions);
      const fallbackFilteredConditions = replaceGeoIndexCondition(filteredConditions);
      const fallbackFilteredWithStateConditions = replaceGeoIndexCondition(filteredWithStateConditions);
      const fallbackBaseWithStateConditions = replaceGeoIndexCondition(baseWithStateConditions);

      const fallbackWhere = fallbackFilteredWithStateConditions.length
        ? `WHERE ${fallbackFilteredWithStateConditions.join(' AND ')}`
        : '';

      result = await listAndCount({
        fromClause: effectiveFromClause,
        whereClauseSql: fallbackWhere,
        queryParams: filteredWithStateParams,
        baseConditionsSql: fallbackFilteredConditions,
        baseParamsSql: filteredParams,
        useGeoIndex: false,
      });

      // Swap in the fallback conditions for any later fallback queries.
      baseConditions.length = 0;
      baseConditions.push(...fallbackBaseConditions);
      filteredConditions.length = 0;
      filteredConditions.push(...fallbackFilteredConditions);
      filteredWithStateConditions.length = 0;
      filteredWithStateConditions.push(...fallbackFilteredWithStateConditions);
      baseWithStateConditions.length = 0;
      baseWithStateConditions.push(...fallbackBaseWithStateConditions);
    }

    // Final guardrail: dedupe in JS as well (handles tracking-param variants and older DBs).
    const decorated = result.rows.map((opp) => decorateOpportunity(opp));
    const seen = new Set();
    const parsed = [];
    let removed = 0;
    for (const row of decorated) {
      const key = dedupeKeyFromRow(row) || (row?.id ? `id:${String(row.id)}` : null);
      if (!key) {
        parsed.push(row);
        continue;
      }
      if (seen.has(key)) {
        removed += 1;
        continue;
      }
      seen.add(key);
      parsed.push(row);
    }
    if (removed > 0) {
      console.info('[opportunities] de-duped duplicate rows', { removed, hasGeoRun, source: source ?? null });
    }

    const filteredTotal = Number(result.total ?? parsed.length);

    // Guardrail: if the user requested grant-only compliance but this filter eliminates everything,
    // fall back to returning review-required opportunities instead of an empty result set.
    if (normalizedCompliance === 'grant_only' && filteredTotal === 0) {
      const baseWhere = baseWithStateConditions.length ? `WHERE ${baseWithStateConditions.join(' AND ')}` : '';

      try {
        const baseCountRow = await req.db
          .prepare(
            `
              SELECT COUNT(*) AS total
              ${effectiveFromClause}
              ${baseWhere}
            `,
          )
          .get(...baseWithStateParams);
        const totalFound = Number(baseCountRow?.total ?? 0);

        if (totalFound > 0) {
          console.info('[opportunities] compliance fallback applied', {
            request_id: req.requestId || null,
            compliance_requested: normalizedCompliance,
            geo_run_id: geoRunId ? String(geoRunId) : null,
            state: normalizedState || null,
            source: source || null,
            is_national: isNational || null,
            total_found: totalFound,
          });

          // Use the same FROM clause & ordering, but without compliance constraints.
          const fallbackRows = await runQuery({
            fromClause: effectiveFromClause,
            whereClauseSql: baseWhere,
            queryParams: baseWithStateParams,
            baseConditionsSql: baseConditions,
            baseParamsSql: baseParams,
            useGeoIndex: effectiveUseGeoIndex,
          });

          const fallbackDecorated = fallbackRows.map((opp) => decorateOpportunity(opp));
          const fallbackSeen = new Set();
          const fallbackParsed = [];
          for (const row of fallbackDecorated) {
            const key = dedupeKeyFromRow(row) || (row?.id ? `id:${String(row.id)}` : null);
            if (key && fallbackSeen.has(key)) continue;
            if (key) fallbackSeen.add(key);
            fallbackParsed.push(row);
          }

          // Compute a distinct total that matches the de-dupe semantics (not raw row count).
          let distinctTotalFound = fallbackParsed.length;
          try {
            const keyExpr = dedupeKeySql(hasGeoRun ? 'fo.' : '', { useGeoIndex: Boolean(effectiveUseGeoIndex && hasGeoRun) });
            const distinctCountRow = await req.db
              .prepare(
                `
                  SELECT COUNT(*) AS total
                  FROM (
                    SELECT 1
                    ${effectiveFromClause}
                    ${baseWhere}
                    GROUP BY ${keyExpr}
                  ) t
                `,
              )
              .get(...baseWithStateParams);
            distinctTotalFound = Number(distinctCountRow?.total ?? distinctTotalFound);
          } catch {
            // ignore (best-effort)
          }

          return res.json({
            data: fallbackParsed,
            total: distinctTotalFound,
            total_found: distinctTotalFound,
            included: fallbackParsed.length,
            limit: parsedLimit,
            offset: parsedOffset,
            compliance_requested: normalizedCompliance,
            compliance_effective: 'all',
            fallback_applied: true,
            fallback_reason: 'compliance_filter_eliminated_all_results',
            removed_by_compliance: Math.max(0, distinctTotalFound),
          });
        }
      } catch (err) {
        console.warn('[opportunities] compliance fallback failed:', err?.message || String(err));
      }
    }

    res.json({
      data: parsed,
      total: filteredTotal,
      total_found: filteredTotal,
      included: parsed.length,
      limit: parsedLimit,
      offset: parsedOffset,
      compliance_requested: normalizedCompliance,
      compliance_effective: normalizedCompliance,
      fallback_applied: false,
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
    let data = normalizePayloadForDb(validateFundingTerms(req.body || {}), req.db);
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

    let data = normalizePayloadForDb(validateFundingTerms(req.body || {}), req.db);
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
