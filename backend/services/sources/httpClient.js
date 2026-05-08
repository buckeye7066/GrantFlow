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
