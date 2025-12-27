import axios from 'axios';
import * as cheerio from 'cheerio';

// Constants
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Base crawler class that provides common functionality for all crawlers
 */
export class BaseCrawler {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this.headers = options.headers || {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };
  }

  /**
   * Fetch HTML content from a URL with retry logic
   * @param {string} url - The URL to fetch
   * @param {number} retryCount - Current retry attempt
   * @returns {Promise<string>} - The HTML content
   */
  async fetchHTML(url, retryCount = 0) {
    try {
      const response = await axios.get(url, {
        timeout: this.timeoutMs,
        headers: this.headers
      });
      return response.data;
    } catch (error) {
      if (retryCount < this.maxRetries) {
        console.log(`Retry ${retryCount + 1}/${this.maxRetries} for ${url}`);
        await this.sleep(1000 * (retryCount + 1)); // Exponential backoff
        return this.fetchHTML(url, retryCount + 1);
      }
      throw new Error(`Failed to fetch ${url}: ${error.message}`);
    }
  }

  /**
   * Parse HTML content using Cheerio
   * @param {string} html - The HTML content to parse
   * @returns {CheerioAPI} - Cheerio instance
   */
  parseHTML(html) {
    return cheerio.load(html);
  }

  /**
   * Sleep for a specified duration
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Extract text content and trim whitespace
   * @param {Cheerio} element - Cheerio element
   * @returns {string} - Trimmed text content
   */
  extractText(element) {
    return element.text().trim();
  }

  /**
   * Extract attribute value from element
   * @param {Cheerio} element - Cheerio element
   * @param {string} attr - Attribute name
   * @returns {string|undefined} - Attribute value
   */
  extractAttr(element, attr) {
    return element.attr(attr);
  }

  /**
   * Validate URL format
   * @param {string} url - URL to validate
   * @returns {boolean} - True if valid URL
   */
  isValidUrl(url) {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Normalize URL to absolute format
   * @param {string} url - URL to normalize
   * @param {string} baseUrl - Base URL for relative URLs
   * @returns {string} - Absolute URL
   */
  normalizeUrl(url, baseUrl) {
    if (!url) return '';
    if (this.isValidUrl(url)) return url;
    
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  }

  /**
   * Crawl method to be implemented by subclasses
   * @abstract
   * @returns {Promise<Array>} - Array of grant opportunities
   */
  async crawl() {
    throw new Error('crawl() method must be implemented by subclass');
  }
}
