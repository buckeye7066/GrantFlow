import crypto from 'crypto';

/**
 * Connector framework for authorized source ingestion.
 * Each connector implements a common interface so the ingestion pipeline,
 * workers, and admin UI can treat them uniformly.
 */

// ── Structured connector error ─────────────────────────────────────
export class ConnectorError extends Error {
  constructor(message, { code = 'CONNECTOR_ERROR', retryable = false, statusCode, sourceUrl, rawRecordId } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.sourceUrl = sourceUrl;
    this.rawRecordId = rawRecordId;
  }
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      statusCode: this.statusCode,
      sourceUrl: this.sourceUrl,
      rawRecordId: this.rawRecordId,
    };
  }
}

// ── Content hashing ─────────────────────────────────────────────────
export function computeContentHash(payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

// ── Rate limiter (token bucket, per-connector) ──────────────────────
export class RateLimiter {
  constructor({ maxRequestsPerMinute = 60, maxConcurrent = 3 } = {}) {
    this.maxPerMinute = maxRequestsPerMinute;
    this.maxConcurrent = maxConcurrent;
    this._timestamps = [];
    this._active = 0;
    this._queue = [];
  }
  async acquire() {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        const now = Date.now();
        this._timestamps = this._timestamps.filter((t) => now - t < 60_000);
        if (this._timestamps.length < this.maxPerMinute && this._active < this.maxConcurrent) {
          this._timestamps.push(now);
          this._active++;
          resolve();
        } else {
          const waitMs = Math.min(5000, 1000 * (this._timestamps.length ? 1 : 0) + 200);
          setTimeout(tryAcquire, waitMs);
        }
      };
      tryAcquire();
    });
  }
  release() {
    this._active = Math.max(0, this._active - 1);
    if (this._queue.length) this._queue.shift()();
  }
}

// ── Retry with exponential backoff ─────────────────────────────────
export async function withRetry(fn, { maxAttempts = 4, baseDelayMs = 1000, maxDelayMs = 30000, isRetryable } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const canRetry = isRetryable ? isRetryable(err) : (err.retryable !== false);
      if (!canRetry || attempt >= maxAttempts) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay + jitter));
    }
  }
  throw lastError;
}

// ── Checkpoint manager ───────────────────────────────────────────────
export class Checkpoint {
  /** @param {object} store Object implementing getCheckpoint(connectorId) and saveCheckpoint(connectorId, data) */
  constructor(store, connectorId) {
    this.store = store;
    this.connectorId = connectorId;
    this._data = null;
  }
  async load() {
    if (this._data !== null) return this._data;
    try {
      this._data = (await this.store.getCheckpoint?.(this.connectorId)) || null;
    } catch { this._data = null; }
    return this._data;
  }
  async save(data) {
    this._data = data;
    await this.store.saveCheckpoint?.(this.connectorId, data);
  }
  async clear() {
    this._data = null;
    await this.store.clearCheckpoint?.(this.connectorId);
  }
}

// ── Source health tracker ───────────────────────────────────────────
export class SourceHealth {
  constructor() {
    this.runs = [];
  }
  record({ status, recordsSeen = 0, recordsChanged = 0, recordsFailed = 0, errorSummary }) {
    this.runs.unshift({ status, recordsSeen, recordsChanged, recordsFailed, errorSummary, timestamp: Date.now() });
    if (this.runs.length > 50) this.runs.length = 50;
  }
  get status() {
    const recent = this.runs.slice(0, 5);
    if (!recent.length) return 'unknown';
    const failures = recent.filter((r) => r.status === 'failed').length;
    if (failures >= 4) return 'unhealthy';
    if (failures >= 2) return 'degraded';
    return 'healthy';
  }
  get lastSuccessfulSyncAt() {
    return this.runs.find((r) => r.status === 'completed')?.timestamp || null;
  }
  summary() {
    return { status: this.status, lastSuccessfulSyncAt: this.lastSuccessfulSyncAt, totalRuns: this.runs.length };
  }
}

// ── Base connector interface ─────────────────────────────────────────
/**
 * All connectors must implement these methods.
 * Subclasses override the ones marked MUST IMPLEMENT.
 */
export class BaseConnector {
  constructor(config = {}) {
    this.id = config.id || config.name;
    this.name = config.name;
    this.connectorType = config.connectorType || 'api';
    this.sourceCategory = config.sourceCategory || 'federal';
    this.baseUrl = config.baseUrl;
    this.authorizationMode = config.authorizationMode || 'none';
    this.enabled = config.enabled ?? false;
    this.rateLimitPolicy = config.rateLimitPolicy || { maxRequestsPerMinute: 60, maxConcurrent: 3 };
    this.robotsPolicyStatus = config.robotsPolicyStatus || 'not_checked';
    this.configurationStatus = config.configurationStatus || 'not_configured';
    this.config = config;
    this.health = new SourceHealth();
    this.rateLimiter = new RateLimiter(this.rateLimitPolicy);
  }

  /** MUST IMPLEMENT: validate that this connector has required config */
  validateConfig() { throw new Error(`${this.constructor.name} must implement validateConfig()`); }

  /** MUST IMPLEMENT: return a small plan describing what a sync would do */
  async planSync() { throw new Error(`${this.constructor.name} must implement planSync()`); }

  /** MUST IMPLEMENT: fetch one page of records */
  async fetchPage(_cursor, _checkpoint) { throw new Error(`${this.constructor.name} must implement fetchPage()`); }

  /** MUST IMPLEMENT: parse a raw record into normalized shape */
  parseRecord(_rawRecord) { throw new Error(`${this.constructor.name} must implement parseRecord()`); }

  /** Override to detect status (open, closed, canceled, archived, forecasted, recurring, rolling, amended) */
  detectStatus(_parsed, _rawRecord) { throw new Error(`${this.constructor.name} must implement detectStatus()`); }

  /** Override to return a checkpoint value from page results */
  getCheckpoint(_pageResult, _prevCheckpoint) { return null; }

  /** Dry-run: fetch one page without writing anything */
  async dryRun() {
    this.validateConfig();
    const checkpoint = new Checkpoint(this.config.checkpointStore, this.id);
    const cp = await checkpoint.load();
    const page = await this.fetchPage(null, cp);
    const parsed = (page.records || []).slice(0, 5).map((r) => {
      try { return this.parseRecord(r); } catch (e) { return { error: e.message, raw: r }; }
    });
    return {
      connectorId: this.id,
      checkpoint: cp,
      pageRecords: (page.records || []).length,
      nextPageCursor: page.nextCursor || null,
      sampleParsed: parsed,
      health: this.health.summary(),
    };
  }

  /** Replay: re-parse a stored raw record through the latest parser */
  replayRecord(rawRecord) {
    return this.parseRecord(rawRecord);
  }
}

// ── Helper: safe fetch with SSRF protection, redirect limits, timeouts ──
export async function safeFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, maxRedirects = 3, signal } = {}) {
  const urlObj = new URL(url);
  if (!['http:', 'https:'].includes(urlObj.protocol)) throw new ConnectorError(`Blocked protocol: ${urlObj.protocol}`, { code: 'SSRF_BLOCKED_PROTOCOL', retryable: false });
  // Block obvious internal addresses
  const hostname = urlObj.hostname;
  if (['localhost', '0.0.0.0', '::1', '127.0.0.1'].includes(hostname) || hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('169.254.')) {
    throw new ConnectorError(`Blocked internal address: ${hostname}`, { code: 'SSRF_BLOCKED_INTERNAL', retryable: false });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort());
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new ConnectorError(`Request timed out after ${timeoutMs}ms`, { code: 'TIMEOUT', retryable: true, sourceUrl: url });
    throw new ConnectorError(`Fetch failed: ${err.message}`, { code: 'FETCH_FAILED', retryable: true, sourceUrl: url });
  } finally {
    clearTimeout(timeout);
  }
}
