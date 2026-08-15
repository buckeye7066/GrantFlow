import { BaseConnector, ConnectorError, computeContentHash, safeFetch, withRetry } from './framework.js';

/**
 * Simpler.Grants.gov API connector.
 * API base: https://simpler.grants.gov/api/v1
 * POST /opportunities/search returns paginated federal funding opportunities.
 * Supports API-key-based access; connector gracefully enters missing_credentials
 * when no key is provided and never exposes or logs the key.
 */
export class SimplerGrantsGovConnector extends BaseConnector {
  constructor(config = {}) {
    super({
      id: 'simpler_grants_gov',
      name: 'Simpler.Grants.gov',
      connectorType: 'api',
      sourceCategory: 'federal',
      baseUrl: 'https://simpler.grants.gov/api/v1',
      authorizationMode: config.apiKey ? 'api_key' : 'none',
      enabled: config.enabled ?? true,
      rateLimitPolicy: { maxRequestsPerMinute: config.maxRequestsPerMinute || 60, maxConcurrent: config.maxConcurrent || 3 },
      ...config,
    });
    this._apiKey = config.apiKey || null;
    this.configurationStatus = this._apiKey ? 'ready' : 'missing_credentials';
  }

  validateConfig() {
    if (!this.baseUrl) throw new ConnectorError('baseUrl is required', { code: 'MISSING_BASE_URL' });
    // Connector is usable in read-only mode without a key for public search,
    // but we expose the credential state so admins can configure it.
    if (!this._apiKey) this.configurationStatus = 'missing_credentials';
    return { valid: true, configurationStatus: this.configurationStatus };
  }

  _headers() {
    const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (this._apiKey) h['X-API-Key'] = this._apiKey; // never logged
    return h;
  }

  async planSync() {
    this.validateConfig();
    const checkpoint = this.config.checkpointStore ? new (await import('./framework.js')).Checkpoint(this.config.checkpointStore, this.id) : null;
    let cp = null;
    if (checkpoint) cp = await checkpoint.load();
    return {
      connectorId: this.id,
      mode: 'incremental',
      baseUrl: this.baseUrl,
      endpoint: '/opportunities/search',
      method: 'POST',
      checkpoint: cp,
      estimatedPages: 'unknown',
      configurationStatus: this.configurationStatus,
    };
  }

  async fetchPage(cursor, checkpoint) {
    this.validateConfig();
    await this.rateLimiter.acquire();
    try {
      const body = {
        pagination: {
          offset: cursor?.offset || 0,
          limit: cursor?.limit || 100,
          sort: 'updated_at',
          order: 'asc',
        },
      };
      // Incremental: if checkpoint exists, filter for records newer than last sync
      if (checkpoint?.lastUpdatedAt) {
        body.filters = { updated_at: { gte: checkpoint.lastUpdatedAt } };
      }
      const res = await withRetry(async () => {
        return safeFetch(`${this.baseUrl}/opportunities/search`, {
          method: 'POST',
          headers: this._headers(),
          body,
          timeoutMs: 30000,
          signal: this.config.signal,
        });
      }, { maxAttempts: 3, isRetryable: (e) => e.retryable });

      if (!res.ok) {
        throw new ConnectorError(`Simpler.Grants.gov returned ${res.status}`, { code: 'HTTP_ERROR', statusCode: res.status, retryable: res.status >= 500, sourceUrl: `${this.baseUrl}/opportunities/search` });
      }
      const json = await res.json();
      const records = json.data || json.opportunities || [];
      const pagination = json.pagination || {};
      const nextOffset = pagination.offset + records.length;
      const hasMore = nextOffset < (pagination.total || records.length + (pagination.offset || 0));
      return {
        records,
        nextCursor: hasMore ? { offset: nextOffset, limit: body.pagination.limit } : null,
        total: pagination.total,
        meta: { page: pagination } };
    } finally {
      this.rateLimiter.release();
    }
  }

  parseRecord(raw) {
    if (!raw || typeof raw !== 'object') throw new ConnectorError('Invalid raw record', { code: 'PARSE_ERROR', retryable: false });
    const opportunity = raw.opportunity || raw;
    return {
      sourceRecordId: String(opportunity.id || opportunity.opportunity_id || ''),
      sourceUrl: `https://simpler.grants.gov/opportunity/${opportunity.id || opportunity.opportunity_id}`,
      raw,
      contentHash: computeContentHash(opportunity),
      normalized: {
        title: opportunity.title || opportunity.opportunity_title || null,
        opportunityNumber: opportunity.opportunity_number || opportunity.opp_number || null,
        assistanceListingNumber: opportunity.assistance_listing_number || opportunity.aln || opportunity.cfda || null,
        status: this.detectStatus(opportunity, raw),
        agency: opportunity.agency || opportunity.agency_name || null,
        awardMinimum: opportunity.award_floor || opportunity.award_minimum || opportunity.estimated_award_min || null,
        awardMaximum: opportunity.award_ceiling || opportunity.award_maximum || opportunity.estimated_award_max || null,
        estimatedTotalFunding: opportunity.estimated_total_funding || opportunity.funding_instrument || null,
        openingDate: opportunity.post_date || opportunity.open_date || null,
        loiDate: opportunity.loi_deadline || null,
        deadline: opportunity.close_date || opportunity.deadline || null,
        expectedAwardDate: opportunity.expected_award_date || null,
        applicantTypes: opportunity.applicant_types || opportunity.eligible_applicants || [],
        geographicEligibility: opportunity.geographic_eligibility || opportunity.eligible_locations || null,
        subjectAreas: opportunity.subject_areas || opportunity.category || opportunity.funding_category || [],
        description: opportunity.description || opportunity.summary || null,
        applicationUrl: opportunity.apply_url || opportunity.application_url || null,
        contactSummary: opportunity.contact_info || null,
        requiredAttachments: opportunity.required_attachments || [],
        requiredRegistrations: opportunity.required_registrations || [],
      },
      provenance: {
        sourceName: 'Simpler.Grants.gov',
        connectorId: this.id,
        contentType: 'application/json',
      },
    };
  }

  detectStatus(parsed, raw) {
    const status = (parsed.status || parsed.opportunity_status || '').toString().toLowerCase();
    const deadline = parsed.close_date || parsed.deadline;
    // Map Simpler.Grants.gov statuses to canonical statuses
    const statusMap = {
      posted: 'open',
      open: 'open',
      forecasted: 'forecasted',
      forecast: 'forecasted',
      closed: 'closed',
      archived: 'archived',
      canceled: 'canceled',
      cancelled: 'canceled',
    };
    let mapped = statusMap[status] || null;
    if (!mapped) {
      // Derive from deadline if status is missing
      if (deadline) {
        const dl = new Date(deadline);
        if (dl && dl.getTime() < Date.now()) mapped = 'closed';
        else mapped = 'open';
      } else {
        mapped = 'open';
      }
    }
    // Detect rolling/recurring keywords in title
    const title = (parsed.title || parsed.opportunity_title || '').toString().toLowerCase();
    if (/rolling|continuous|open until filled/.test(title)) mapped = mapped === 'open' ? 'rolling' : mapped;
    if (/recurring|annual|yearly/.test(title)) mapped = mapped === 'open' ? 'recurring' : mapped;
    return mapped;
  }

  getCheckpoint(pageResult, prevCheckpoint) {
    const records = pageResult.records || [];
    if (!records.length) return prevCheckpoint;
    let latest = prevCheckpoint?.lastUpdatedAt;
    for (const r of records) {
      const updated = r.opportunity?.updated_at || r.updated_at;
      if (updated && (!latest || new Date(updated) > new Date(latest))) latest = updated;
    }
    return { lastUpdatedAt: latest, offset: pageResult.nextCursor?.offset || null };
  }
}
