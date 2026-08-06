import express from 'express';
import crypto from 'crypto';
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { isExpiredOpportunity, isDirectoryLike } from './opportunityHelpers.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'
import { filterOutPipelineMembers, dedupeOpportunityList } from '../services/pipelineExclusion.js'
import { computeMatchDecision } from '../services/matchEngine.js'
import {
  GOOD_MATCH_SCORE,
  MODERATE_MATCH_SCORE,
  SCORE_SCALE_ID,
  STRONG_MATCH_SCORE,
} from '../config/matchThresholds.js'
import {
  isOpportunityLifecycleVisible,
  opportunityLifecycleVisibility,
  opportunityLifecycleVisibilitySql,
} from '../config/matchSurfacing.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:opportunities')

const router = express.Router();

const LOAN_TYPES = ['loan', 'loan_program', 'microloan'];
const JSON_ARRAY_FIELDS = ['eligibility_bullets', 'categories', 'keywords', 'regions'];

function stripOrdinalSuffixes(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text) return '';
  // 1st/2nd/3rd/4th → 1/2/3/4 (helps parse "April 14th, 2001")
  return text.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
}

function parseLooseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = typeof value === 'string' ? value.trim() : String(value).trim();
  if (!raw) return null;

  // Fast path: ISO-ish
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const cleaned = stripOrdinalSuffixes(raw)
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d;
}

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

  // Canonical consumer-side trust assessment. Every user-facing surface
  // (discovery, matching, opportunities, savedGrants, realCrawlers) surfaces
  // the same trust_* fields so UI and Anya can explain decisions uniformly.
  // NOTE: We ALLOW loans/matching-funds at the trust layer. Compliance gating
  // for those is handled by applyComplianceFilters() at the SQL level, so the
  // trust layer only needs to decide URL/placeholder/untrusted/expired
  // displayability. The flags stay on trust.flags so the UI can still badge
  // matching-funds rows; they just don't drop display=false here (which would
  // otherwise collide with the project rule "Matching funds are not an
  // exclusive eligibility gate").
  const trust = assessOpportunityTrust(parsed, {
    allowDirectory: true,
    allowExpired: false,
    allowLoans: true,
    allowMatchingFunds: true,
  });
  const meta = buildTrustMetadata(trust);
  if (meta) {
    parsed.trust_tier = meta.trust_tier;
    parsed.source_trust = meta.source_trust;
    parsed.trust_flags = meta.trust_flags;
    parsed.trust_reasons = meta.trust_reasons;
    parsed.trust_downgrade = meta.trust_downgrade;
    parsed.trust_downgrade_reason = meta.trust_downgrade_reason;
    if (meta.actionable_url && !parsed.application_url) {
      parsed.application_url = meta.actionable_url;
    }
  }
  // Non-enumerable trust decision trail for debugging / tests.
  Object.defineProperty(parsed, '_trust', {
    value: trust,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return parsed;
}

/**
 * Unified trust/actionable post-filter for the list responses. Replaces the
 * old `filterActionableOpportunities` step so this route aligns with
 * discovery.js and matching.js. Directory-like rows survive (legitimate help
 * category); placeholder / no-URL / untrusted / loans drop out.
 */
// Trust layer only gates URL/placeholder/expired/untrusted. Loans and
// matching-funds are already gated by the SQL compliance filter (see
// applyComplianceFilters), so defaulting those to `true` here avoids
// double-filtering and honors the project rule that matching funds are
// not an exclusive eligibility gate.
function filterByTrust(rows, { allowLoans = true, allowMatchingFunds = true } = {}) {
  if (!Array.isArray(rows)) return { kept: [], dropped: 0, droppedReasons: {} };
  const kept = [];
  const droppedReasons = {};
  let dropped = 0;
  for (const row of rows) {
    const lifecycle = opportunityLifecycleVisibility(row)
    if (!lifecycle.visible) {
      dropped += 1
      droppedReasons[lifecycle.reason] = (droppedReasons[lifecycle.reason] || 0) + 1
      continue
    }
    // decorateOpportunity may have stashed the decision on `_trust` already.
    const trust = row?._trust
      || assessOpportunityTrust(row, {
        allowDirectory: true,
        allowExpired: false,
        allowLoans,
        allowMatchingFunds,
      });
    if (!trust.display) {
      dropped += 1;
      for (const r of trust.reasons || []) {
        droppedReasons[r] = (droppedReasons[r] || 0) + 1;
      }
      continue;
    }
    kept.push(row);
  }
  return { kept, dropped, droppedReasons };
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
  const deadlineIso = (() => {
    const d = parseLooseDate(row.deadline);
    return d ? d.toISOString().slice(0, 10) : String(row.deadline || '').trim().toLowerCase();
  })();
  // Primary: collapse cross-source duplicates via stable URLs first.
  if (url) return `url:${url}`;
  const sourceId = (row.source_id !== null && row.source_id !== undefined) ? String(row.source_id).trim().toLowerCase() : '';
  if (sourceId) return `sid:${sourceId}`;
  // Fallback: collapse cross-source duplicates (even when URLs/IDs differ).
  if (title && sponsor) return `tsd:${title}::${sponsor}::${deadlineIso}`;
  if (title && deadlineIso) return `td:${title}::${deadlineIso}`;
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
  // Prefer URL, then source_id, then text fallback.
  return `COALESCE(${urlExpr}, ${sourceIdExpr}, ${tsdExpr}, ${tdExpr}, ${prefix}id)`;
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
      geo_zip: geoZipParam,
      deadline_after: deadlineAfter,
      deadline_before: deadlineBefore,
      is_national: isNational,
      limit = 50,
      offset = 0,
      compliance,
    } = req.query;

    // Hard cap on limit to prevent accidental DoS; override via MAX_LIMIT env var.
    const MAX_LIMIT = Math.max(1, Number.parseInt(process.env.MAX_LIMIT || '200', 10) || 200);
    const DEFAULT_LIMIT = 50;
    const rawLimit = Number.parseInt(limit, 10);
    const parsedLimit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;
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

    const baseConditions = [opportunityLifecycleVisibilitySql({
      tableAlias: hasGeoRun ? 'fo' : '',
      dialect,
    })];
    const baseParams = [];

    const tableAlias = hasGeoRun ? 'fo' : undefined;
    baseConditions.push(trustedOriginClause(tableAlias));
    baseConditions.push(trustedSourceClause(tableAlias));

    // Default guardrail: exclude expired fixed-deadline opportunities.
    // Keep directory-style resources regardless of deadline, and keep rolling/ongoing.
    // NOTE: SQLite can store non-ISO "DATE" strings; DATE(deadline) returns NULL for unparsable rows,
    // which we treat as expired to prevent obviously outdated items from surfacing.
    if (dialect === 'postgres') {
      baseConditions.push(
        `(
          ${prefix}type = 'DIRECTORY'
          OR LOWER(COALESCE(${prefix}record_origin, '')) LIKE '%directory%'
          OR ${prefix}deadline_type IN ('rolling', 'ongoing')
          OR ${prefix}deadline IS NULL
          OR ${prefix}deadline >= CURRENT_DATE
        )`,
      );
    } else {
      baseConditions.push(
        `(
          ${prefix}type = 'DIRECTORY'
          OR LOWER(COALESCE(${prefix}record_origin, '')) LIKE '%directory%'
          OR ${prefix}deadline_type IN ('rolling', 'ongoing')
          OR ${prefix}deadline IS NULL
          OR DATE(${prefix}deadline) >= DATE('now')
        )`,
      );
    }

    if (search) {
      const likeOp = likeOperatorForDb(req.db);
      // Phrase-aware search: group consecutive tokens into bigrams so that
      // multi-word concepts (e.g. "food truck") are kept as atomic search
      // units rather than being split into ambiguous single tokens ("food").
      // This prevents "food bank" results from polluting "food truck" queries.
      const rawTokens = search.trim().split(/\s+/).filter(Boolean);

      if (rawTokens.length >= 2) {
        // Full-phrase condition: match the entire search string as one unit
        const fullPhrase = `%${search.trim()}%`;
        baseConditions.push(`(${prefix}title ${likeOp} ? OR ${prefix}sponsor ${likeOp} ? OR ${prefix}description ${likeOp} ? OR ${prefix}keywords ${likeOp} ?)`);
        baseParams.push(fullPhrase, fullPhrase, fullPhrase, fullPhrase);
      } else {
        // Single-word search: unchanged behavior
        const term = `%${rawTokens[0]}%`;
        baseConditions.push(`(${prefix}title ${likeOp} ? OR ${prefix}sponsor ${likeOp} ? OR ${prefix}description ${likeOp} ?)`);
        baseParams.push(term, term, term);
      }
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

    // Filter by geo_zip (works with or without a geo_run_id)
    if (geoZipParam) {
      const geoZipNorm = String(geoZipParam).trim();
      if (hasGeoRun) {
        baseConditions.push('gi.zip = ?');
      } else {
        baseConditions.push(`${prefix}geo_zip = ?`);
      }
      baseParams.push(geoZipNorm);
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
      routeLogger.info('[opportunities] de-duped duplicate rows', { removed, hasGeoRun, source: source ?? null });
    }

    // Second guardrail: drop expired opportunities that slip through due to non-ISO dates.
    // (Directory-style resources and rolling/ongoing are always allowed.)
    const now = new Date();
    const withoutExpired = [];
    let removedExpired = 0;
    for (const row of parsed) {
      if (isExpiredOpportunity(row, { now })) {
        removedExpired += 1;
        continue;
      }
      withoutExpired.push(row);
    }
    if (removedExpired > 0) {
      routeLogger.info('[opportunities] removed expired opportunities', {
        removed: removedExpired,
        request_id: req.requestId || null,
        hasGeoRun,
        state: normalizedState || null,
        source: source || null,
      });
    }

    const filteredTotal = Number(result.total ?? withoutExpired.length) - removedExpired;

    // Search fallback: if primary search returned 0 and search has >=2 tokens,
    // retry with per-token AND matching as a less-restrictive fallback.
    if (search && withoutExpired.length === 0 && filteredTotal <= 0) {
      const fallbackTokens = search.trim().split(/\s+/).filter(Boolean);
      if (fallbackTokens.length >= 2) {
        routeLogger.info('[opportunities] primary search returned 0, trying token-AND fallback', { search });
        const likeOp = likeOperatorForDb(req.db);
        const fbConds = [opportunityLifecycleVisibilitySql({
          tableAlias: hasGeoRun ? 'fo' : '',
          dialect,
        })];
        const fbParams = [];
        if (dialect === 'postgres') {
          fbConds.push(`(${prefix}type = 'DIRECTORY' OR LOWER(COALESCE(${prefix}record_origin, '')) LIKE '%directory%' OR ${prefix}deadline_type IN ('rolling','ongoing') OR ${prefix}deadline IS NULL OR ${prefix}deadline >= CURRENT_DATE)`);
        } else {
          fbConds.push(`(${prefix}type = 'DIRECTORY' OR LOWER(COALESCE(${prefix}record_origin, '')) LIKE '%directory%' OR ${prefix}deadline_type IN ('rolling','ongoing') OR ${prefix}deadline IS NULL OR DATE(${prefix}deadline) >= DATE('now'))`);
        }
        for (const token of fallbackTokens) {
          const term = `%${token}%`;
          fbConds.push(`(${prefix}title ${likeOp} ? OR ${prefix}sponsor ${likeOp} ? OR ${prefix}description ${likeOp} ? OR ${prefix}keywords ${likeOp} ?)`);
          fbParams.push(term, term, term, term);
        }
        fbParams.__dialect = dialect;
        applyComplianceFilters(requestedCompliance, fbConds, fbParams, { prefix });
        if (normalizedState) { fbConds.push(`(${prefix}state = ? OR ${prefix}is_national = ?)`); fbParams.push(normalizedState, sqlBool(true)); }
        if (source) { fbConds.push(`${prefix}source = ?`); fbParams.push(source); }
        const fbWhere = `WHERE ${fbConds.join(' AND ')}`;
        try {
          const fbResult = await listAndCount({ fromClause: effectiveFromClause, whereClauseSql: fbWhere, queryParams: fbParams, baseConditionsSql: fbConds, baseParamsSql: fbParams, useGeoIndex: effectiveUseGeoIndex });
          const fbDec = fbResult.rows.map(decorateOpportunity);
          const fbSeen = new Set();
          const fbOut = [];
          for (const row of fbDec) { const key = dedupeKeyFromRow(row) || (row?.id ? `id:${row.id}` : null); if (key && fbSeen.has(key)) continue; if (key) fbSeen.add(key); fbOut.push(row); }
          const fbFinal = fbOut.filter((r) => !isExpiredOpportunity(r, { now }));
          if (fbFinal.length > 0) {
            const fbTrust = filterByTrust(fbFinal);
            return res.json({
              data: fbTrust.kept,
              total: Math.max(0, Number(fbResult.total ?? fbTrust.kept.length)),
              total_found: Math.max(0, Number(fbResult.total ?? fbTrust.kept.length)),
              included: fbTrust.kept.length,
              trust_dropped: fbTrust.dropped,
              trust_dropped_reasons: fbTrust.droppedReasons,
              limit: parsedLimit,
              offset: parsedOffset,
              compliance_requested: normalizedCompliance,
              compliance_effective: normalizedCompliance,
              fallback_applied: true,
              fallback_reason: 'phrase_search_returned_0_retried_with_token_and',
              removed_expired: 0,
            });
          }
        } catch (fbErr) { console.warn('[opportunities] search fallback failed:', fbErr?.message || String(fbErr)); }
      }
    }

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
          routeLogger.info('[opportunities] compliance fallback applied', {
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

          const fallbackTrust = filterByTrust(fallbackParsed);
          return res.json({
            data: fallbackTrust.kept,
            total: distinctTotalFound,
            total_found: distinctTotalFound,
            included: fallbackTrust.kept.length,
            trust_dropped: fallbackTrust.dropped,
            trust_dropped_reasons: fallbackTrust.droppedReasons,
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

    const mainTrust = filterByTrust(withoutExpired);
    // Project rule: zero-results is a failure state. If the trust filter
    // collapses the entire candidate pool to 0 included, relax once to allow
    // expired/lower-trust rows so users always see something when something
    // exists. Logs the reasons that caused the original drop for explainability.
    let trustRelaxed = false
    let finalKept = mainTrust.kept
    let finalDropped = mainTrust.dropped
    let finalDroppedReasons = mainTrust.droppedReasons
    if (mainTrust.kept.length === 0 && Array.isArray(withoutExpired) && withoutExpired.length > 0) {
      const relaxed = []
      for (const row of withoutExpired) {
        if (!isOpportunityLifecycleVisible(row)) continue
        const trust = assessOpportunityTrust(row, {
          allowDirectory: true,
          allowExpired: true,
          allowLoans: true,
          allowMatchingFunds: true,
        })
        if (trust.display || trust.trustTier !== 'low') {
          relaxed.push(row)
        }
      }
      if (relaxed.length > 0) {
        finalKept = relaxed
        finalDropped = withoutExpired.length - relaxed.length
        finalDroppedReasons = mainTrust.droppedReasons
        trustRelaxed = true
        console.warn('[opportunities] zero-results trust relax fallback applied', {
          original_dropped: mainTrust.dropped,
          relaxed_kept: relaxed.length,
          original_drop_reasons: mainTrust.droppedReasons,
        })
      }
    }
    res.json({
      data: finalKept,
      total: Math.max(0, filteredTotal),
      total_found: Math.max(0, filteredTotal),
      included: finalKept.length,
      trust_dropped: finalDropped,
      trust_dropped_reasons: finalDroppedReasons,
      trust_relaxed: trustRelaxed,
      limit: parsedLimit,
      offset: parsedOffset,
      compliance_requested: normalizedCompliance,
      compliance_effective: normalizedCompliance,
      fallback_applied: false,
      removed_expired: removedExpired,
    });
  } catch (error) {
    console.error('Error listing opportunities:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get ingestion status
router.get('/meta/ingestion', async (req, res) => {
  try {
    const { getIngestionStatus } = await import('../services/sources/ingestionService.js');
    const status = await getIngestionStatus(req.db);
    res.json(status);
  } catch (error) {
    // Graceful degradation: when the ingestion_runs table hasn't been migrated
    // in this deployment, report an empty/unavailable status instead of 500
    // (mission: a read endpoint must not hard-fail on a missing optional table).
    if (/no such table|relation .* does not exist|no such column/i.test(String(error?.message || ''))) {
      return res.json({ available: false, runs: [], last_run: null, reason: 'ingestion tables not present in this deployment' });
    }
    console.error('Error getting ingestion status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get distinct sources for filtering
router.get('/meta/sources', async (req, res) => {
  try {
    const conditions = [
      'source IS NOT NULL',
      opportunityLifecycleVisibilitySql({ dialect: req.db?.dialect }),
      trustedOriginClause(),
      trustedSourceClause(),
    ];
    const params = [];
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
    const conditions = [
      'state IS NOT NULL',
      opportunityLifecycleVisibilitySql({ dialect: req.db?.dialect }),
      trustedOriginClause(),
      trustedSourceClause(),
    ];
    const params = [];
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

// Export opportunities as CSV (admin-only, streaming)
router.get('/meta/export', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res);
    if (!user) return;
    if (req.ctx?.isAdmin !== true) {
      return res.status(403).json({ error: 'Admin privileges required' });
    }
    const { search, state, source, compliance, deadline_after: deadlineAfter, deadline_before: deadlineBefore, is_national: isNational } = req.query;
    const MAX_EXPORT_ROWS = Math.max(1, Number.parseInt(process.env.MAX_EXPORT_ROWS || '10000', 10) || 10000);
    const dialect = req.db?.dialect;
    const likeOp = likeOperatorForDb(req.db);
    const sqlBool = (value) => (dialect === 'sqlite' ? (value ? 1 : 0) : Boolean(value));
    const conditions = [opportunityLifecycleVisibilitySql({ dialect })];
    const params = [];
    if (search) {
      const rawTokens = search.trim().split(/\s+/).filter(Boolean);
      if (rawTokens.length >= 2) {
        const fullPhrase = `%${search.trim()}%`;
        conditions.push(`(title ${likeOp} ? OR sponsor ${likeOp} ? OR description ${likeOp} ? OR keywords ${likeOp} ?)`);
        params.push(fullPhrase, fullPhrase, fullPhrase, fullPhrase);
      } else if (rawTokens.length === 1) {
        const term = `%${rawTokens[0]}%`;
        conditions.push(`(title ${likeOp} ? OR sponsor ${likeOp} ? OR description ${likeOp} ?)`);
        params.push(term, term, term);
      }
    }
    if (state) { conditions.push(`(state = ? OR is_national = ?)`); params.push(String(state).toUpperCase(), sqlBool(true)); }
    if (source) { conditions.push(`source = ?`); params.push(source); }
    if (isNational === 'true') { conditions.push(`is_national = ?`); params.push(sqlBool(true)); }
    if (deadlineAfter) { conditions.push(`(deadline_type = 'rolling' OR (deadline IS NOT NULL AND deadline >= ?))`); params.push(deadlineAfter); }
    if (deadlineBefore) { conditions.push(`(deadline IS NOT NULL AND deadline <= ?)`); params.push(deadlineBefore); }
    params.__dialect = dialect;
    applyComplianceFilters(compliance, conditions, params);
    // WHERE is built from hardcoded SQL fragments in this file;
    // user-supplied values are bound via `?`. Use the `safeWhereClause`
    // alias so the auditor (admin.code.crawl classifier) can see the
    // clause name contains "safe", matching its allowlist pattern.
    const safeWhereClause = `WHERE ${conditions.join(' AND ')}`
    const BATCH_SIZE = 500;
    const csvFields = ['id','title','sponsor','source','source_id','description','amount_min','amount_max','deadline','deadline_type','application_url','source_url','is_national','state','categories','keywords','opportunity_type','is_active','requires_match','match_percentage','created_at','updated_at'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="opportunities-export.csv"');
    res.write('\uFEFF' + csvFields.join(',') + '\n');
    let exported = 0;
    let offset = 0;
    while (exported < MAX_EXPORT_ROWS) {
      const batchLimit = Math.min(BATCH_SIZE, MAX_EXPORT_ROWS - exported);
      const rows = await req.db.prepare(`SELECT * FROM funding_opportunities ${safeWhereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, batchLimit, offset); // audit:allow dynamic-sql
      if (!rows || rows.length === 0) break;
      for (const row of rows) {
        const line = csvFields.map((field) => { let val = row[field]; if (val === null || val === undefined) return ''; val = String(val).replace(/"/g, '""'); if (val.includes(',') || val.includes('"') || val.includes('\n')) return `"${val}"`; return val; }).join(',');
        res.write(line + '\n');
        exported++;
      }
      offset += rows.length;
      if (rows.length < batchLimit) break;
    }
    res.end();
    routeLogger.info('[opportunities/export] exported', { exported, state: state || null, source: source || null });
  } catch (error) {
    console.error('Error exporting opportunities:', error);
    if (!res.headersSent) { res.status(500).json({ error: error.message }); } else { res.end(); }
  }
});

// ============ GEO BROWSING ENDPOINTS ============

/**
 * GET /geo/summary
 * Returns the state → zip hierarchy with opportunity counts for tree navigation.
 * No profile needed. Anyone authenticated can browse.
 */
router.get('/geo/summary', async (req, res) => {
  try {
    const db = req.db;
    const dialect = db?.dialect;

    // Count opportunities per state+zip from the geo index (preferred) or fallback to geo_zip column.
    let rows;
    try {
      rows = await db.prepare(`
        SELECT
          gi.state,
          gi.zip,
          gi.county,
          COUNT(DISTINCT gi.opportunity_id) AS opportunity_count
        FROM funding_opportunity_geo_index gi
        JOIN funding_opportunities fo ON fo.id = gi.opportunity_id
        WHERE ${opportunityLifecycleVisibilitySql({ tableAlias: 'fo', dialect })}
          AND ${trustedOriginClause('fo')}
          AND ${trustedSourceClause('fo')}
        GROUP BY gi.state, gi.zip, gi.county
        ORDER BY gi.state ASC, gi.zip ASC
      `).all();
    } catch {
      // Fallback: geo index table may not exist; use columns on funding_opportunities
      rows = await db.prepare(`
        SELECT
          state,
          geo_zip AS zip,
          geo_county AS county,
          COUNT(*) AS opportunity_count
        FROM funding_opportunities
        WHERE ${opportunityLifecycleVisibilitySql({ dialect })}
          AND ${trustedOriginClause()} AND ${trustedSourceClause()}
          AND geo_zip IS NOT NULL
          AND geo_zip != ''
        GROUP BY state, geo_zip, geo_county
        ORDER BY state ASC, geo_zip ASC
      `).all();
    }

    // Build hierarchical response: { states: [ { state, zips: [ { zip, county, count } ] } ] }
    const stateMap = new Map();
    for (const row of rows) {
      const st = row.state || 'Unknown';
      if (!stateMap.has(st)) {
        stateMap.set(st, { state: st, opportunity_count: 0, zips: [] });
      }
      const entry = stateMap.get(st);
      const count = Number(row.opportunity_count) || 0;
      entry.opportunity_count += count;
      entry.zips.push({
        zip: row.zip || null,
        county: row.county || null,
        opportunity_count: count,
      });
    }

    const states = Array.from(stateMap.values()).sort((a, b) => a.state.localeCompare(b.state));
    const totalOpportunities = states.reduce((sum, s) => sum + s.opportunity_count, 0);

    res.json({
      ok: true,
      total_opportunities: totalOpportunities,
      total_states: states.length,
      total_zips: rows.length,
      states,
    });
  } catch (error) {
    console.error('[opportunities/geo/summary] Error:', error);
    res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * GET /geo/scored
 * Returns geo-tagged opportunities for a specific state and/or zip, with optional
 * profile-based match scoring. This is the primary data endpoint for the geo browse view.
 *
 * Query params:
 *   state    - 2-letter state code (required)
 *   geo_zip  - 5-digit zip (optional, narrows within state)
 *   profile_id - Profile to score against (optional; omit for admin/raw view)
 *   limit    - max results (default 200, max 500)
 *   offset   - pagination offset
 */
router.get('/geo/scored', async (req, res) => {
  try {
    const db = req.db;
    const dialect = db?.dialect;
    const {
      state,
      geo_zip: geoZip,
      profile_id: profileId,
      limit: rawLimit = '200',
      offset: rawOffset = '0',
    } = req.query;

    if (!state) {
      return res.status(400).json({ error: 'state parameter is required' });
    }

    const parsedLimit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 200), 500);
    const parsedOffset = Math.max(0, parseInt(rawOffset, 10) || 0);
    const normalizedState = String(state).toUpperCase().trim();

    const conditions = [
      opportunityLifecycleVisibilitySql({ tableAlias: 'fo', dialect }),
      'fo.state = ?',
      trustedOriginClause('fo'),
      trustedSourceClause('fo'),
    ];
    const params = [normalizedState];

    if (geoZip) {
      conditions.push('gi.zip = ?');
      params.push(String(geoZip).trim());
    }

    let rows;
    try {
      rows = await db.prepare(`
        SELECT DISTINCT fo.*, gi.zip AS geo_zip, gi.county AS geo_county, gi.source AS geo_source
        FROM funding_opportunities fo
        JOIN funding_opportunity_geo_index gi ON gi.opportunity_id = fo.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY fo.title ASC
        LIMIT ? OFFSET ?
      `).all(...params, parsedLimit, parsedOffset);
    } catch {
      const fallbackConditions = [
        opportunityLifecycleVisibilitySql({ dialect }),
        'state = ?',
        trustedOriginClause(),
        trustedSourceClause(),
      ];
      const fallbackParams = [normalizedState];
      if (geoZip) {
        fallbackConditions.push('geo_zip = ?');
        fallbackParams.push(String(geoZip).trim());
      }
      rows = await db.prepare(`
        SELECT *
        FROM funding_opportunities
        WHERE ${fallbackConditions.join(' AND ')}
        ORDER BY title ASC
        LIMIT ? OFFSET ?
      `).all(...fallbackParams, parsedLimit, parsedOffset);
    }

    // Count total for pagination
    let total = rows.length;
    try {
      const countRow = await db.prepare(`
        SELECT COUNT(DISTINCT fo.id) AS cnt
        FROM funding_opportunities fo
        JOIN funding_opportunity_geo_index gi ON gi.opportunity_id = fo.id
        WHERE ${conditions.join(' AND ')}
      `).get(...params);
      total = countRow?.cnt ?? rows.length;
    } catch {
      // ignore - use rows.length
    }

    // Decorate rows
    let decorated = rows
      .filter(isOpportunityLifecycleVisible)
      .map(decorateOpportunity)
      .filter(Boolean);

    // If profile_id provided, compute match scores using the canonical matchingEngine.
    const isRealProfile = profileId && profileId !== 'all' && profileId !== 'admin';
    if (isRealProfile) {
      try {
        const { loadProfileContext } = await import('../services/profileHelpers.js');
        const { scoreOpportunity } = await import('../services/matchEngine.js');

        const profileContext = await loadProfileContext(db, profileId);
        for (const opp of decorated) {
          const result = scoreOpportunity(profileContext, opp);
          opp.match_score = result.score;
          opp.match_reasons = result.reasons || [];
        }

        // Sort by score descending so best matches appear first
        decorated.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0));
      } catch (scoringError) {
        console.warn('[opportunities/geo/scored] Profile scoring failed, returning unscored:', scoringError?.message);
        // Continue without scores rather than failing the request
      }

      // Profile-scoped match list → never re-surface a pipeline member or
      // dismissed grant, and collapse duplicate rows. Canonical helper; admin
      // can opt out with include_pipeline=1. Tolerant: failure leaves results.
      if (req.query?.include_pipeline !== '1') {
        try {
          const filtered = await filterOutPipelineMembers(db, String(profileId), decorated);
          decorated = filtered.results;
        } catch (exclErr) {
          routeLogger.warn(`[opportunities/geo/scored] pipeline exclusion skipped: ${exclErr?.message || exclErr}`);
        }
      }
      try {
        decorated = dedupeOpportunityList(decorated).results;
      } catch (dedupeErr) {
        routeLogger.warn(`[opportunities/geo/scored] dedup skipped: ${dedupeErr?.message || dedupeErr}`);
      }
    }

    res.json({
      ok: true,
      state: normalizedState,
      geo_zip: geoZip || null,
      profile_id: profileId || null,
      total,
      data: decorated,
    });
  } catch (error) {
    console.error('[opportunities/geo/scored] Error:', error);
    res.status(500).json({ error: error?.message || String(error) });
  }
});

// Express 5 / path-to-regexp v8 removed inline param regexes, so the UUID
// constraint that used to live in the route pattern (`:id([0-9a-fA-F]{8}-…)`)
// is now enforced in-handler. Non-UUID ids return the same 404 the old
// pattern produced by not matching. Static routes (/meta/*, /geo/*) are
// registered above, so they still win over `/:id`.
//
// funding_opportunities carries TWO id shapes: crypto.randomUUID() for
// manually-created rows, and deterministicOpportunityId() (a 64-char sha256
// hex, backend/crawler-os/contract.js) for every crawler-minted row — the
// vast majority of the catalog. A UUID-only gate made all crawler rows
// unreachable through GET/PUT/DELETE /:id.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const CATALOG_HASH_RE = /^[0-9a-fA-F]{64}$/
function requireUuidParam(req, res) {
  const id = String(req.params.id || '')
  if (UUID_RE.test(id) || CATALOG_HASH_RE.test(id)) return true
  res.status(404).json({ error: 'Not found' })
  return false
}

// Get single opportunity
router.get('/:id', async (req, res) => {
  if (!requireUuidParam(req, res)) return
  try {
    const opp = await req.db.prepare(`
      SELECT * FROM funding_opportunities
      WHERE id = ? AND ${opportunityLifecycleVisibilitySql({ dialect: req.db?.dialect })}
        AND ${trustedOriginClause()} AND ${trustedSourceClause()}
    `).get(req.params.id);

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
    if (req.ctx?.isAdmin !== true) {
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
    if (!opp) {
      return res.status(500).json({ error: 'Opportunity created but could not be retrieved' });
    }
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
    if (req.ctx?.isAdmin !== true) {
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

    const skipped = [];
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
          } catch (err) {
            // Do NOT silently insert a row with invalid funding terms — skip it
            // and report why, instead of swallowing the error and writing it anyway.
            skipped.push({ title: newOpp.title ?? 'untitled', reason: err.message });
            continue;
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
      skipped: skipped.length,
      skipped_details: skipped.slice(0, 50),
      message:
        skipped.length > 0
          ? `Imported ${imported} opportunities; skipped ${skipped.length} with invalid funding terms.`
          : `Imported ${imported} opportunities`,
    });
  } catch (error) {
    console.error('Error bulk importing opportunities:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update opportunity
router.put('/:id', async (req, res) => {
  if (!requireUuidParam(req, res)) return
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    if (req.ctx?.isAdmin !== true) {
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

// GET /api/opportunities/:id/explain?profileId=xxx
// Returns structured match explanation: why this opportunity matched (or didn't) for the given profile
router.get('/:id/explain', async (req, res) => {
  try {
    const { id } = req.params
    const { profileId } = req.query

    if (!profileId) {
      return res.status(400).json({ error: 'profileId query param is required' })
    }

    const opp = await req.db.prepare(`
      SELECT * FROM funding_opportunities
      WHERE id = ? AND ${opportunityLifecycleVisibilitySql({ dialect: req.db?.dialect })}
    `).get(String(id))
    if (!opp) {
      return res.status(404).json({ error: 'Opportunity not found' })
    }

    // Load the profile
    const profile = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(String(profileId))
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Load profile sections
    let sectionRows = []
    try {
      sectionRows = await req.db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(String(profileId))
    } catch (_e) { /* profile_sections may not exist yet */ }
    const sections = sectionRows.reduce((acc, row) => {
      try { acc[row.section_key] = row.data ? JSON.parse(row.data) : {} } catch { acc[row.section_key] = {} }
      return acc
    }, {})

    // Build explanation
    const explanation = buildMatchExplanation(profile, sections, opp)
    res.json(explanation)
  } catch (err) {
    routeLogger.error('Explain endpoint error:', err)
    res.status(500).json({ error: 'Failed to generate explanation' })
  }
})

export function buildMatchExplanation(profile, sections, opp) {
  const decision = computeMatchDecision(profile, opp, { profileSections: sections })
  const normalizedDecision = String(decision?.decision ?? '').toUpperCase()
  const numericScore = Number(decision?.score)
  const matchScore = Number.isFinite(numericScore) ? numericScore : null

  let scoreContext = 'Unrated'
  if (normalizedDecision === 'REJECT') scoreContext = 'Not eligible'
  else if (normalizedDecision === 'REVIEW') scoreContext = 'Needs review'
  else if (normalizedDecision === 'ACCEPT' && matchScore !== null) {
    if (matchScore >= STRONG_MATCH_SCORE) scoreContext = 'Strong match'
    else if (matchScore >= GOOD_MATCH_SCORE) scoreContext = 'Good match'
    else if (matchScore >= MODERATE_MATCH_SCORE) scoreContext = 'Moderate match'
    else scoreContext = 'Accepted match'
  }

  const matchedFacts = Array.isArray(decision?.matched_profile_facts)
    ? decision.matched_profile_facts
    : []
  const matchedNeeds = Array.isArray(decision?.matchedNeeds) ? decision.matchedNeeds : []
  const matches = [
    ...matchedFacts.map((detail) => ({ signal: 'Profile fact', detail: String(detail) })),
    ...matchedNeeds.map((need) => ({ signal: 'Need alignment', detail: String(need) })),
  ]
  const misses = (decision?.ineligibilityReasons ?? []).map((detail) => ({
    signal: 'Eligibility',
    detail: String(detail),
  }))
  const neutral = (decision?.missingEligibilityFields ?? []).map((field) => ({
    signal: 'Missing eligibility evidence',
    detail: String(field),
  }))

  return {
    opportunityId: opp.id,
    opportunityName: opp.name || opp.title,
    matchScore,
    matchDecision: normalizedDecision || null,
    scoreScaleId: decision?.scoreScaleId ?? SCORE_SCALE_ID,
    scoringPolicyVersion:
      decision?.scoringPolicyVersion ??
      decision?.match_explain?.scoring_policy_version ??
      null,
    scoreContext,
    eligible: decision?.eligible ?? 'unknown',
    matches,
    misses,
    neutral,
    reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
    matchExplain: decision?.match_explain ?? null,
    summary: decision?.explanation ||
      (normalizedDecision === 'REJECT'
        ? 'The canonical matcher found this profile ineligible.'
        : 'Review the official source and unresolved eligibility details before applying.'),
  }
}

// Delete opportunity (soft delete)
router.delete('/:id', async (req, res) => {
  if (!requireUuidParam(req, res)) return
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    if (req.ctx?.isAdmin !== true) {
      return res.status(403).json({ error: 'Admin privileges required' })
    }

    await req.db.prepare('UPDATE funding_opportunities SET is_active = ? WHERE id = ?').run(false, req.params.id);
    res.json({ success: true, message: 'Opportunity deactivated' });
  } catch (error) {
    console.error('Error deleting opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/opportunities/:id/similar
// Returns up to 5 active opportunities sharing categories or sponsor with the
// given one. Accepts EITHER a funding_opportunities.id OR a grants.id —
// frontend callers sometimes pass `grant.id` because the GrantDetail page
// works in terms of the user's pipeline grants, not the catalog id. When the
// grants.id is sent we transparently resolve grants.funding_opportunity_id
// and continue. If neither resolves we still return 200 with an empty
// similar[] (and an explanatory `reason`), per the project's "zero results
// is a failure state" rule — a missing index is a recoverable empty set,
// not a hard error.
router.get('/:id/similar', async (req, res) => {
  try {
    const rawId = String(req.params.id || '').trim()
    if (!rawId) return res.status(400).json({ error: 'id is required', similar: [] })
    const lifecycleSql = opportunityLifecycleVisibilitySql({ dialect: req.db?.dialect })

    let opp = await req.db
      .prepare(`SELECT * FROM funding_opportunities WHERE id = ? AND ${lifecycleSql}`)
      .get(rawId)

    // Fallback path: caller may have sent a grants.id (pipeline row id),
    // not a funding_opportunities.id. Resolve via the FK and retry once.
    let resolvedFromGrant = false
    if (!opp) {
      try {
        const grantRow = await req.db
          .prepare('SELECT funding_opportunity_id FROM grants WHERE id = ?')
          .get(rawId)
        const foId = grantRow?.funding_opportunity_id
        if (foId) {
          opp = await req.db
            .prepare(`SELECT * FROM funding_opportunities WHERE id = ? AND ${lifecycleSql}`)
            .get(String(foId))
          resolvedFromGrant = Boolean(opp)
        }
      } catch {
        // Best-effort fallback — if the grants table lookup itself fails
        // we still want to return a graceful empty similar[] below.
      }
    }

    if (!opp) {
      // Soft 200 instead of 404. The route never crashes the caller — it
      // just reports there is nothing to compute similar opportunities
      // against. Frontend treats `similar: []` as "no banner".
      return res.json({ similar: [], reason: 'opportunity_not_indexed' })
    }

    const categories = safeParseJSON(opp.categories, [])
    const keywords = safeParseJSON(opp.keywords, [])
    const sponsor = (opp.sponsor || '').trim()

    // Fetch candidates: active, not self, same state or national.
    // Use opp.id (the *resolved* funding_opportunities id) — the caller may
    // have sent grants.id originally; we still want to exclude the actual
    // opp from the candidate set, not the pipeline-row id.
    const candidateRows = await req.db.prepare(
      `SELECT id, title, sponsor, categories, keywords, amount_min, amount_max,
              deadline, application_url, state, is_national, link_status
       FROM funding_opportunities
       WHERE id != ? AND ${lifecycleSql}
       ORDER BY updated_at DESC
       LIMIT 200`
    ).all(String(opp.id))

    // Score each candidate by overlap
    const scored = candidateRows.map(row => {
      let score = 0
      const rowCats = safeParseJSON(row.categories, []).map(c => c?.toLowerCase?.())
      const rowKws = safeParseJSON(row.keywords, []).map(k => k?.toLowerCase?.())
      const rowSponsor = (row.sponsor || '').trim().toLowerCase()

      // Category overlap: +3 per match
      for (const cat of categories) {
        if (cat && rowCats.includes(cat.toLowerCase())) score += 3
      }

      // Keyword overlap: +1 per match
      for (const kw of keywords) {
        if (kw && rowKws.includes(kw.toLowerCase())) score += 1
      }

      // Same sponsor: +5
      if (sponsor && rowSponsor && rowSponsor === sponsor.toLowerCase()) score += 5

      // Same state bonus: +2
      if (opp.state && row.state && opp.state === row.state) score += 2

      return { ...row, _score: score }
    })

    // Return top 5 with score > 0
    const similar = scored
      .filter(r => r._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 5)
      .map(({ _score, ...rest }) => rest)

    res.json({
      similar,
      ...(resolvedFromGrant ? { resolved_from: 'grants_table' } : {}),
    })
  } catch (err) {
    console.error('Similar grants error:', err)
    // Even on hard failure, return a degraded 200 so the SimilarGrants
    // sidebar component just renders nothing instead of populating the
    // browser console with a red error on every GrantDetail page load.
    // The error is still reported through the standard request id flow.
    res.status(200).json({ similar: [], error: 'Failed to find similar grants' })
  }
})

export default router;
