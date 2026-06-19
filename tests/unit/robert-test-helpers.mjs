/**
 * robert-test-helpers.mjs
 *
 * Tiny in-memory SQLite shim for Robert unit tests. It implements the
 * narrow DB surface Robert touches (prepare → run/get/all). Each
 * statement is parsed once with hand-written matchers; this is
 * intentionally minimalist so the test suite never needs better-sqlite3.
 */

export function makeMemoryDb() {
  const tables = {
    robert_runs: [],
    robert_source_candidates: [],
    robert_opportunity_candidates: [],
    robert_profile_coverage: [],
    robert_profile_recommendations: [],
    robert_domain_rate_limits: [],
    profiles: [],
    funding_opportunities: [],
    grants: [],
  }

  function rowsCopy(arr) { return arr.map((r) => ({ ...r })) }

  function prepare(sql) {
    const sqlClean = String(sql).replace(/\s+/g, ' ').trim()
    return {
      run: (...params) => execute(sqlClean, params, 'run'),
      get: (...params) => execute(sqlClean, params, 'get'),
      all: (...params) => execute(sqlClean, params, 'all'),
    }
  }

  function execute(sql, paramsRaw, method) {
    const params = paramsRaw && paramsRaw.length === 1 && Array.isArray(paramsRaw[0]) ? paramsRaw[0] : paramsRaw
    // ---- robert_runs ----
    if (/^INSERT INTO robert_runs/i.test(sql)) {
      const [id, mode, trigger, status, started_at, _summary, created_by_user_id] = params
      tables.robert_runs.push({
        id, mode, trigger, status, started_at, completed_at: null,
        profiles_considered: 0, sources_considered: 0, urls_fetched: 0,
        candidates_found: 0, candidates_verified: 0, opportunities_ingested: 0,
        opportunities_matched: 0, recommendations_created: 0,
        recommendations_delivered: 0, recommendations_accepted: 0,
        recommendations_declined: 0, zero_result_profiles_helped: 0,
        summary_json: '{}', error: null, created_by_user_id,
      })
      return { changes: 1 }
    }
    if (/^UPDATE robert_runs SET status = \?, completed_at = \?,/i.test(sql)) {
      const [
        status, completed_at,
        profiles_considered, sources_considered, urls_fetched,
        candidates_found, candidates_verified, opportunities_ingested,
        opportunities_matched, recommendations_created,
        recommendations_delivered, recommendations_accepted,
        recommendations_declined, zero_result_profiles_helped,
        summary_json, error, id,
      ] = params
      const idx = tables.robert_runs.findIndex((r) => r.id === id)
      if (idx >= 0) {
        Object.assign(tables.robert_runs[idx], {
          status, completed_at, profiles_considered, sources_considered, urls_fetched,
          candidates_found, candidates_verified, opportunities_ingested,
          opportunities_matched, recommendations_created,
          recommendations_delivered, recommendations_accepted,
          recommendations_declined, zero_result_profiles_helped,
          summary_json, error,
        })
      }
      return { changes: 1 }
    }
    if (/^SELECT \* FROM robert_runs WHERE id = \?/i.test(sql)) {
      const [id] = params
      const row = tables.robert_runs.find((r) => r.id === id)
      return method === 'get' ? (row ? { ...row } : undefined) : (row ? [{ ...row }] : [])
    }
    if (/^SELECT \* FROM robert_runs ORDER BY started_at DESC LIMIT \?$/i.test(sql)) {
      const [limit] = params
      const rows = [...tables.robert_runs].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, Number(limit) || 25)
      return rowsCopy(rows)
    }
    if (/^SELECT \* FROM robert_runs ORDER BY started_at DESC LIMIT 1$/i.test(sql)) {
      const rows = [...tables.robert_runs].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      return rows[0] ? { ...rows[0] } : undefined
    }

    // ---- robert_source_candidates ----
    if (/^SELECT \* FROM robert_source_candidates WHERE source_url = \? LIMIT 1$/i.test(sql)) {
      const [u] = params
      const row = tables.robert_source_candidates.find((r) => r.source_url === u)
      return row ? { ...row } : undefined
    }
    if (/^INSERT INTO robert_source_candidates/i.test(sql)) {
      const [
        id, source_name, source_url, source_domain, source_type, source_scope,
        geography_state, geography_county, geography_city,
        applicant_types_json, need_categories_json, trust_score, discovered_by,
        discovered_at, status, evidence_json, robots_allowed, rate_limit_bucket,
      ] = params
      tables.robert_source_candidates.push({
        id, source_name, source_url, source_domain, source_type, source_scope,
        geography_state, geography_county, geography_city,
        applicant_types_json, need_categories_json, trust_score, discovered_by,
        discovered_at, last_checked_at: null, status,
        rejection_reason: null,
        evidence_json, robots_allowed, rate_limit_bucket,
      })
      return { changes: 1 }
    }
    if (/^UPDATE robert_source_candidates\s+SET source_name/i.test(sql)) {
      const [source_name, source_type, source_scope, trust_score, last_checked_at, evidence_json, id] = params
      const row = tables.robert_source_candidates.find((r) => r.id === id)
      if (row) Object.assign(row, {
        source_name: source_name || row.source_name,
        source_type: source_type ?? row.source_type,
        source_scope: source_scope ?? row.source_scope,
        trust_score: Number(trust_score),
        last_checked_at, evidence_json,
      })
      return { changes: row ? 1 : 0 }
    }
    if (/^UPDATE robert_source_candidates\s+SET status/i.test(sql)) {
      const [status, rejection_reason, last_checked_at, id] = params
      const row = tables.robert_source_candidates.find((r) => r.id === id)
      if (row) Object.assign(row, { status, rejection_reason, last_checked_at })
      return { changes: row ? 1 : 0 }
    }
    if (/^SELECT \* FROM robert_source_candidates WHERE status = \? ORDER BY/i.test(sql)) {
      const [status, limit] = params
      return rowsCopy(tables.robert_source_candidates.filter((r) => r.status === status).slice(0, Number(limit) || 100))
    }
    if (/^SELECT \* FROM robert_source_candidates ORDER BY/i.test(sql)) {
      const [limit] = params
      return rowsCopy(tables.robert_source_candidates.slice(0, Number(limit) || 100))
    }

    // ---- robert_opportunity_candidates ----
    if (/^INSERT INTO robert_opportunity_candidates/i.test(sql)) {
      const [
        id, run_id, source_candidate_id, title, sponsor, description,
        application_url, source_url, deadline, deadline_type,
        amount_min, amount_max, amount_description,
        geography_json, eligibility_json, categories_json, keywords_json,
        applicant_types_json, need_categories_json, raw_payload_json,
        extraction_method, confidence,
        verification_status, verification_reasons_json,
        created_at, updated_at,
      ] = params
      tables.robert_opportunity_candidates.push({
        id, run_id, source_candidate_id, title, sponsor, description,
        application_url, source_url, deadline, deadline_type,
        amount_min, amount_max, amount_description,
        geography_json, eligibility_json, categories_json, keywords_json,
        applicant_types_json, need_categories_json, raw_payload_json,
        extraction_method, confidence,
        verification_status, verification_reasons_json,
        policy_status: null, policy_rejection_reason: null,
        reality_status: null, reviewer_status: null,
        normalized_opportunity_json: null,
        existing_opportunity_id: null, ingested_opportunity_id: null,
        created_at, updated_at,
      })
      return { changes: 1 }
    }
    if (/^UPDATE robert_opportunity_candidates SET .* WHERE id = \?$/i.test(sql)) {
      // Use a generic update — match the SET fragment to figure out columns/order.
      const setMatch = sql.match(/SET (.+?) WHERE id = \?$/i)
      if (!setMatch) return { changes: 0 }
      const setParts = setMatch[1].split(',').map((p) => p.trim().split('=')[0].trim())
      const id = params[params.length - 1]
      const row = tables.robert_opportunity_candidates.find((r) => r.id === id)
      if (!row) return { changes: 0 }
      for (let i = 0; i < setParts.length; i += 1) {
        row[setParts[i]] = params[i]
      }
      return { changes: 1 }
    }
    if (/^SELECT \* FROM robert_opportunity_candidates WHERE/i.test(sql)) {
      const [run_id, verification_status, limit] = params.length === 3
        ? params
        : params.length === 2
          ? [null, params[0], params[1]]
          : [null, null, params[0]]
      let out = tables.robert_opportunity_candidates.slice()
      if (run_id) out = out.filter((r) => r.run_id === run_id)
      if (verification_status) out = out.filter((r) => r.verification_status === verification_status)
      return rowsCopy(out.slice(0, Number(limit) || 100))
    }

    // ---- robert_profile_coverage ----
    if (/^SELECT id FROM robert_profile_coverage WHERE profile_id = \?/i.test(sql)) {
      const [pid] = params
      const row = tables.robert_profile_coverage.find((r) => r.profile_id === pid)
      return row ? { id: row.id } : undefined
    }
    if (/^INSERT INTO robert_profile_coverage/i.test(sql)) {
      const [id, profile_id, coverage_score, known_matches_count, accepted_matches_count, review_matches_count, zero_result_risk, missing_need_categories_json, missing_geographies_json, recommended_search_queries_json, recommended_source_types_json, last_analyzed_at] = params
      tables.robert_profile_coverage.push({ id, profile_id, coverage_score, known_matches_count, accepted_matches_count, review_matches_count, zero_result_risk, missing_need_categories_json, missing_geographies_json, recommended_search_queries_json, recommended_source_types_json, last_analyzed_at })
      return { changes: 1 }
    }
    if (/^UPDATE robert_profile_coverage SET coverage_score/i.test(sql)) {
      const [coverage_score, known_matches_count, accepted_matches_count, review_matches_count, zero_result_risk, missing_need_categories_json, missing_geographies_json, recommended_search_queries_json, recommended_source_types_json, last_analyzed_at, id] = params
      const row = tables.robert_profile_coverage.find((r) => r.id === id)
      if (row) Object.assign(row, { coverage_score, known_matches_count, accepted_matches_count, review_matches_count, zero_result_risk, missing_need_categories_json, missing_geographies_json, recommended_search_queries_json, recommended_source_types_json, last_analyzed_at })
      return { changes: row ? 1 : 0 }
    }
    if (/^SELECT \* FROM robert_profile_coverage WHERE profile_id = \?/i.test(sql)) {
      const [pid] = params
      const row = tables.robert_profile_coverage.find((r) => r.profile_id === pid)
      return row ? { ...row } : undefined
    }

    // ---- robert_profile_recommendations ----
    if (/^SELECT \* FROM robert_profile_recommendations\s+WHERE profile_id = \? AND opportunity_id = \?\s+AND recommendation_status IN/i.test(sql)) {
      const [profile_id, opportunity_id] = params
      const active = ['pending', 'delivered', 'viewed']
      const row = tables.robert_profile_recommendations.find((r) =>
        r.profile_id === profile_id && r.opportunity_id === opportunity_id && active.includes(r.recommendation_status),
      )
      return row ? { ...row } : undefined
    }
    if (/^SELECT \* FROM robert_profile_recommendations\s+WHERE profile_id = \? AND opportunity_id = \? ORDER BY created_at DESC LIMIT 1$/i.test(sql)) {
      const [profile_id, opportunity_id] = params
      const candidates = tables.robert_profile_recommendations.filter((r) => r.profile_id === profile_id && r.opportunity_id === opportunity_id)
      candidates.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return candidates[0] ? { ...candidates[0] } : undefined
    }
    if (/^SELECT \* FROM robert_profile_recommendations\s+WHERE profile_id = \? AND opportunity_id = \?\s+AND recommendation_status NOT IN/i.test(sql)) {
      const [profile_id, opportunity_id] = params
      const skip = ['declined', 'expired']
      const row = tables.robert_profile_recommendations.find((r) =>
        r.profile_id === profile_id && r.opportunity_id === opportunity_id && !skip.includes(r.recommendation_status),
      )
      return row ? { ...row } : undefined
    }
    if (/^INSERT INTO robert_profile_recommendations/i.test(sql)) {
      const [
        id, profile_id, opportunity_id, robert_run_id,
        recommendation_status, delivery_status,
        match_score, match_decision, match_reasons_json, missing_profile_fields_json,
        why_found, search_query_used, source_candidate_id, opportunity_candidate_id,
        toast_title, toast_body, toast_priority, created_at, updated_at,
      ] = params
      tables.robert_profile_recommendations.push({
        id, profile_id, opportunity_id, robert_run_id,
        recommendation_status, delivery_status,
        match_score, match_decision, match_reasons_json, missing_profile_fields_json,
        why_found, search_query_used, source_candidate_id, opportunity_candidate_id,
        toast_title, toast_body, toast_priority,
        toast_shown_at: null, viewed_at: null, accepted_at: null, declined_at: null,
        last_delivered_at: null, delivery_attempts: 0, created_at, updated_at,
      })
      return { changes: 1 }
    }
    if (/^SELECT \* FROM robert_profile_recommendations\s+WHERE profile_id = \? AND recommendation_status IN \(/i.test(sql)) {
      const profile_id = params[0]
      const limit = params[params.length - 1]
      const statuses = params.slice(1, params.length - 1)
      const rows = tables.robert_profile_recommendations
        .filter((r) => r.profile_id === profile_id && statuses.includes(r.recommendation_status))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Number(limit) || 50)
      return rowsCopy(rows)
    }
    if (/^SELECT \* FROM robert_profile_recommendations WHERE id = \?/i.test(sql)) {
      const [id] = params
      const row = tables.robert_profile_recommendations.find((r) => r.id === id)
      return row ? { ...row } : undefined
    }
    if (/^UPDATE robert_profile_recommendations SET .* WHERE id = \?$/i.test(sql)) {
      const setMatch = sql.match(/SET (.+?) WHERE id = \?$/i)
      if (!setMatch) return { changes: 0 }
      const setParts = setMatch[1].split(',').map((p) => p.trim().split('=')[0].trim())
      const id = params[params.length - 1]
      const row = tables.robert_profile_recommendations.find((r) => r.id === id)
      if (!row) return { changes: 0 }
      for (let i = 0; i < setParts.length; i += 1) row[setParts[i]] = params[i]
      return { changes: 1 }
    }
    if (/^SELECT COUNT\(\*\) AS c FROM robert_profile_recommendations\s+WHERE profile_id = \? AND created_at >= \?$/i.test(sql)) {
      const [profile_id, since] = params
      const c = tables.robert_profile_recommendations.filter((r) => r.profile_id === profile_id && String(r.created_at) >= String(since)).length
      return { c }
    }
    if (/^SELECT \* FROM robert_profile_recommendations\s+WHERE profile_id = \?\s+AND created_at >= \?\s+AND recommendation_status NOT IN/i.test(sql)) {
      const [profile_id, since, limit] = params
      const skip = ['declined', 'expired', 'superseded']
      const rows = tables.robert_profile_recommendations
        .filter((r) => r.profile_id === profile_id && !skip.includes(r.recommendation_status) && String(r.created_at) >= String(since))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Number(limit) || 20)
      return rowsCopy(rows)
    }

    // ---- robert_domain_rate_limits ----
    if (/^SELECT \* FROM robert_domain_rate_limits WHERE domain = \?$/i.test(sql)) {
      const [domain] = params
      const row = tables.robert_domain_rate_limits.find((r) => r.domain === domain)
      return row ? { ...row } : undefined
    }
    if (/^INSERT INTO robert_domain_rate_limits/i.test(sql)) {
      const [domain, window_start, request_count, last_request_at, last_error] = params
      tables.robert_domain_rate_limits.push({ domain, window_start, request_count, last_request_at, blocked_until: null, last_error })
      return { changes: 1 }
    }
    if (/^UPDATE robert_domain_rate_limits\s+SET window_start = \?, request_count = \?, last_request_at = \?, last_error = \?\s+WHERE domain = \?$/i.test(sql)) {
      const [window_start, request_count, last_request_at, last_error, domain] = params
      const row = tables.robert_domain_rate_limits.find((r) => r.domain === domain)
      if (row) Object.assign(row, { window_start, request_count, last_request_at, last_error })
      return { changes: row ? 1 : 0 }
    }

    // ---- profiles + funding_opportunities + grants (best-effort) ----
    if (/^SELECT id FROM profiles/i.test(sql)) {
      const limit = Number(params[0]) || 50
      return tables.profiles.slice(0, limit).map((p) => ({ id: p.id }))
    }
    if (/^SELECT \* FROM funding_opportunities WHERE id IN/i.test(sql)) {
      return rowsCopy(tables.funding_opportunities.filter((o) => params.includes(o.id)))
    }
    // Fallback fetch used by Robert's match phase when no fresh ingests are
    // available. Mirror the SQL signature in robertAgent.fetchRecentActiveOpportunities.
    if (/^SELECT \*\s+FROM funding_opportunities\s+WHERE COALESCE\(is_active, 1\) IN \(1, TRUE, 'true'\)\s+AND COALESCE\(is_hidden, 0\) IN \(0, FALSE, 'false'\)\s+ORDER BY COALESCE\(updated_at, created_at\) DESC\s+LIMIT \?$/i.test(sql)) {
      const limit = Number(params[0]) || 50
      const truthy = (v, dflt) => {
        if (v === undefined || v === null) return dflt
        if (v === true || v === 1 || v === 'true') return true
        return false
      }
      const rows = tables.funding_opportunities
        .filter((o) => truthy(o.is_active, true) && !truthy(o.is_hidden, false))
        .map((o) => ({ ...o }))
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
        .slice(0, limit)
      return rowsCopy(rows)
    }
    if (/^SELECT COUNT\(\*\) AS c FROM grants WHERE profile_id = \?/i.test(sql)) {
      const [pid] = params
      return { c: tables.grants.filter((g) => g.profile_id === pid).length }
    }
    if (/^SELECT COUNT\(\*\) AS c FROM grants WHERE profile_id = \?\s+AND COALESCE/i.test(sql)) {
      const [pid] = params
      const acc = tables.grants.filter((g) => g.profile_id === pid && !['declined', 'archived', 'rejected'].includes(g.status || '')).length
      return { c: acc }
    }
    if (/^SELECT COUNT\(\*\) AS c FROM funding_opportunities/i.test(sql)) {
      return { c: tables.funding_opportunities.filter((o) => o.is_active !== 0 && o.is_hidden !== 1).length }
    }

    // Unknown SQL — return empty/no-op so tests get a deterministic shape.
    if (method === 'get') return undefined
    if (method === 'all') return []
    return { changes: 0 }
  }

  return {
    prepare,
    exec: () => {},
    tables,
    seed: (table, rows) => {
      if (Array.isArray(rows) && tables[table]) tables[table].push(...rows)
    },
  }
}
