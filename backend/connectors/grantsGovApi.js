import { BaseConnector, ConnectorError, computeContentHash, safeFetch, withRetry } from './framework.js';

/**
 * Grants.gov connector using the official API.
 * Base: https://api.grants.gov/v1/api
 * GET /opportunities/search and GET /opportunities/{oppnum}
 * Used as authorized fallback or parallel source to Simpler.Grants.gov.
 */
export class GrantsGovApiConnector extends BaseConnector {
  constructor(config = {}) {
    super({
      id: 'grants_gov',
      name: 'Grants.gov',
      connectorType: 'api',
      sourceCategory: 'federal',
      baseUrl: 'https://api.grants.gov/v1/api',
      authorizationMode: config.apiKey ? 'api_key' : 'none',
      enabled: config.enabled ?? true,
      rateLimitPolicy: { maxRequestsPerMinute: config.maxRequestsPerMinute || 60, maxConcurrent: config.maxConcurrent || 3 },
      ...config,
    });
    this._apiKey = config.apiKey || null;
    this.configurationStatus = this._apiKey ? 'ready' : 'ready'; // Grants.gov public API may not need a key for basic search
  }

  validateConfig() {
    if (!this.baseUrl) throw new ConnectorError('baseUrl is required', { code: 'MISSING_BASE_URL' });
    return { valid: true, configurationStatus: this.configurationStatus };
  }

  _headers() {
    const h = { 'Accept': 'application/json' };
    if (this._apiKey) h['X-API-Key'] = this._apiKey;
    return h;
  }

  async planSync() {
    this.validateConfig();
    return { connectorId: this.id, mode: 'incremental', baseUrl: this.baseUrl, endpoint: '/opportunities/search', configurationStatus: this.configurationStatus };
  }

  async fetchPage(cursor, checkpoint) {
    this.validateConfig();
    await this.rateLimiter.acquire();
    try {
      const params = new URLSearchParams({ rows: String(cursor?.limit || 100), offset: String(cursor?.offset || 0) });
      if (checkpoint?.lastModifiedDate) params.set('lastModifiedDateFrom', checkpoint.lastModifiedDate);
      const res = await withRetry(() => safeFetch(`${this.baseUrl}/opportunities/search?${params}`, {
        method: 'GET', headers: this._headers(), timeoutMs: 30000, signal: this.config.signal,
      }), { maxAttempts: 3, isRetryable: (e) => e.retryable });
      if (!res.ok) throw new ConnectorError(`Grants.gov returned ${res.status}`, { code: 'HTTP_ERROR', statusCode: res.status, retryable: res.status >= 500 });
      const json = await res.json();
      const records = json.opportunitySearchResult?.opportunities || json.opportunities || [];
      const total = json.opportunitySearchResult?.hits || json.total || 0;
      const nextOffset = (cursor?.offset || 0) + records.length;
      const hasMore = nextOffset < total;
      return { records, nextCursor: hasMore ? { offset: nextOffset, limit: cursor?.limit || 100 } : null, total };
    } finally {
      this.rateLimiter.release();
    }
  }

  parseRecord(raw) {
    const opp = raw.opportunity || raw;
    const oppNum = opp.oppNum || opp.opportunityNumber || null;
    return {
      sourceRecordId: oppNum || String(opp.id || ''),
      sourceUrl: `https://www.grants.gov/search-results/detail/${oppNum || opp.id}`,
      raw,
      contentHash: computeContentHash(opp),
      normalized: {
        title: opp.oppTitle || opp.title || null,
        opportunityNumber: oppNum,
        assistanceListingNumber: opp.cfdaNumber || opp.assistanceListingNumber || opp.aln || null,
        status: this.detectStatus(opp, raw),
        agency: opp.agencyCode || opp.agencyName || null,
        awardMinimum: opp.awardFloor ? Number(opp.awardFloor) : null,
        awardMaximum: opp.awardCeiling ? Number(opp.awardCeiling) : null,
        estimatedTotalFunding: opp.estimatedTotalFunding ? Number(opp.estimatedTotalFunding) : null,
        openingDate: opp.postDate || null,
        loiDate: opp.loiDeadlineDate || null,
        deadline: opp.closeDate || opp.deadline || null,
        expectedAwardDate: opp.expectedAwardDate || null,
        applicantTypes: this._parseApplicantTypes(opp.applicantTypes || opp.eligibleApplicants),
        geographicEligibility: opp.geographicEligibility || opp.eligibleLocations || null,
        subjectAreas: opp.fundingCategory || opp.category || [],
        description: opp.description || opp.synopsis || null,
        applicationUrl: opp.applyUrl || opp.applicationURL || null,
        contactSummary: opp.contactEmail || opp.grantorContact || null,
        requiredAttachments: opp.requiredAttachments || [],
        requiredRegistrations: opp.requiredRegistrations || [],
        // Amendment detection: compare revision + modification history
        amendmentInfo: opp.rev || opp.revisionNumber || null,
        isAmendment: opp.rev ? Number(opp.rev) > 1 : false,
      },
      provenance: { sourceName: 'Grants.gov', connectorId: this.id, contentType: 'application/json' },
    };
  }

  _parseApplicantTypes(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.map((a) => (typeof a === 'string' ? a : a.applicantTypeDescription || a.description || a.value));
    if (typeof input === 'string') {
      try { return JSON.parse(input); } catch { return input.split(',').map((s) => s.trim()).filter(Boolean); }
    }
    return [];
  }

  detectStatus(parsed, raw) {
    const status = (parsed.status || parsed.oppStatus || '').toString().toLowerCase();
    const statusMap = { posted: 'open', open: 'open', forecasted: 'forecasted', forecast: 'forecasted', closed: 'closed', archived: 'archived', canceled: 'canceled', cancelled: 'canceled' };
    let mapped = statusMap[status] || null;
    if (!mapped) {
      const deadline = parsed.closeDate || parsed.deadline;
      if (deadline && new Date(deadline).getTime() < Date.now()) mapped = 'closed';
      else mapped = 'open';
    }
    // Amendment detection
    const rev = parsed.rev || parsed.revisionNumber;
    if (rev && Number(rev) > 1 && mapped === 'open') mapped = 'amended';
    return mapped;
  }

  getCheckpoint(pageResult, prevCheckpoint) {
    const records = pageResult.records || [];
    if (!records.length) return prevCheckpoint;
    let latest = prevCheckpoint?.lastModifiedDate;
    for (const r of records) {
      const opp = r.opportunity || r;
      const updated = opp.lastModifiedDate || opp.updatedAt;
      if (updated && (!latest || new Date(updated) > new Date(latest))) latest = updated;
    }
    return { lastModifiedDate: latest, offset: pageResult.nextCursor?.offset || null };
  }
}
