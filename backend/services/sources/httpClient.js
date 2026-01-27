/**
 * HTTP Client with Retries and Exponential Backoff
 * Single HTTP client for all source connectors
 */

import axios from 'axios';

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
      console.log(`[httpClient] ${method} ${url} (attempt ${attempt + 1}/${maxRetries + 1})`);
      const response = await axios(config);
      
      if (attempt > 0) {
        console.log(`[httpClient] Success after ${attempt} retries`);
      }
      
      if (returnMeta) {
        return { status: response.status, data: response.data };
      }
      return response.data;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxRetries;
      
      // Don't retry on client errors (4xx)
      if (error.response && error.response.status >= 400 && error.response.status < 500) {
        console.error(`[httpClient] Client error ${error.response.status}, not retrying`);
        throw error;
      }
      
      if (!isLastAttempt) {
        // Calculate exponential backoff delay
        const backoffMs = DEFAULT_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`[httpClient] Request failed, retrying in ${backoffMs}ms...`);
        await sleep(backoffMs);
      }
    }
  }
  
  console.error(`[httpClient] All retry attempts failed for ${url}`);
  throw lastError;
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
