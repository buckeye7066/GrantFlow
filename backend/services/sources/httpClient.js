/**
 * HTTP Client with Retries and Exponential Backoff
 * Single HTTP client for all source connectors
 */

import axios from 'axios';
import { createLogger } from '../../utils/logger.js'
const log = createLogger('httpClient')

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;
const USER_AGENT = 'GrantFlow/1.0 (funding opportunity aggregator)';

/**
 * 4xx codes that are TRANSIENT by meaning, not stable facts about the URL.
 *
 * "Don't retry on 4xx" is correct for a stable fact (401/403 = wrong
 * credentials, 404/410 = dead resource) and WRONG for the two 4xx codes that
 * mean "ask me again later". Without this set, an official funder API that
 * rate-limited us threw straight to the caller on the first 429, and the caller
 * could only read that as an unreachable/dead source — a transient condition
 * burned as a fact about the source. It also contradicted this repo's own
 * transient classification used by the amount-enrichment sweeps, which counts
 * 5xx/429/408/statusless as transient and retryable.
 */
const TRANSIENT_HTTP_STATUSES = new Set([408, 429]);

/** Upper bound on an honoured Retry-After, so a hostile value cannot stall a crawl. */
const MAX_RETRY_AFTER_MS = 60000;

/**
 * Retry delay for a transient response: the server's own `Retry-After` when it
 * sends a usable one (delta-seconds or an HTTP-date), else exponential backoff.
 * Always clamped to [DEFAULT_BACKOFF_MS, MAX_RETRY_AFTER_MS].
 */
function resolveRetryDelayMs(responseHeaders, attempt) {
  const backoffMs = Math.min(DEFAULT_BACKOFF_MS * Math.pow(2, attempt), 30000);
  const raw = responseHeaders?.['retry-after'] ?? responseHeaders?.['Retry-After'];
  if (raw === undefined || raw === null || String(raw).trim() === '') return backoffMs;

  const seconds = Number(String(raw).trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, DEFAULT_BACKOFF_MS), MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(String(raw));
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), DEFAULT_BACKOFF_MS), MAX_RETRY_AFTER_MS);
  }
  return backoffMs;
}

/**
 * Make HTTP request with retry logic
 * @param {string} url - URL to fetch
 * @param {object} options - Request options
 * @param {number} options.timeout - Request timeout in ms
 * @param {number} options.maxRetries - Max number of retries
 * @param {object} options.headers - Additional headers
 * @param {string} options.method - HTTP method (GET, POST, etc)
 * @param {object} options.params - Query parameters
 * @param {object} options.data - Request body
 * @param {boolean} options.returnMeta - If true, return { status, data } instead of data
 * @returns {Promise<object>} Response data
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    headers = {},
    method = 'GET',
    params = {},
    data = null,
    returnMeta = false,
  } = options;

  const config = {
    url,
    method,
    timeout,
    headers: {
      'User-Agent': USER_AGENT,
      ...headers,
    },
    params,
    data,
  };

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      log.info(`[httpClient] ${method} ${url} (attempt ${attempt + 1}/${maxRetries + 1})`);
      const response = await axios(config);
      
      if (attempt > 0) {
        log.info(`[httpClient] Success after ${attempt} retries`);
      }
      
      if (returnMeta) {
        return { status: response.status, data: response.data };
      }
      return response.data;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxRetries;

      // Transient 4xx (408/429) must reach the backoff, NOT the stable-client-
      // error throw below. On the final attempt this `continue` exits the loop
      // so the request ends at the shared "all retries failed" throw, which
      // preserves httpStatus for the caller.
      if (TRANSIENT_HTTP_STATUSES.has(error.response?.status)) {
        if (!isLastAttempt) {
          const backoffMs = resolveRetryDelayMs(error.response?.headers, attempt);
          console.warn(`[httpClient] Transient ${error.response.status} for ${url}, retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
        }
        continue;
      }
      
      // Don't retry on client errors (4xx)
      if (error.response?.status >= 400 && error.response?.status < 500) {
        const status = error.response.status;
        if (status === 401 || status === 403) {
          console.error(`[httpClient] Auth error ${status} for ${url} â credentials may need rotation, not retrying`);
        } else if (status === 404 || status === 410) {
          console.warn(`[httpClient] Resource not found (${status}) for ${url} â URL may be stale or dead`);
        } else {
          console.error(`[httpClient] Client error ${status} for ${url}, not retrying`);
        }
        const clientErr = new Error(`HTTP ${status} for ${url}: ${error.message}`);
        clientErr.httpStatus = status;
        clientErr.url = url;
        throw clientErr;
      }
      
      if (!isLastAttempt) {
        // Calculate exponential backoff delay
        const backoffMs = Math.min(DEFAULT_BACKOFF_MS * Math.pow(2, attempt), 30000);
        console.warn(`[httpClient] Request failed, retrying in ${backoffMs}ms...`);
        await sleep(backoffMs);
      }
    }
  }
  
  console.error(`[httpClient] All retry attempts failed for ${url}`);
  const finalErr = new Error(`HTTP request failed after ${maxRetries + 1} attempts for ${url}: ${lastError.message}`);
finalErr.url = url;
finalErr.httpStatus = lastError.response?.status ?? null;
finalErr.cause = lastError;
throw finalErr;
}

/**
 * Sleep helper for backoff
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  fetchWithRetry,
};
