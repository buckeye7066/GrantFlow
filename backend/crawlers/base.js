const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;

class BaseCrawler {
  constructor(config = {}) {
    this.timeout = config.timeout || DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries || DEFAULT_MAX_RETRIES;
    this.headers = config.headers || {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
  }

  async fetch(url, retryCount = 0) {
    try {
      const response = await axios.get(url, {
        timeout: this.timeout,
        headers: this.headers
      });
      return response.data;
    } catch (error) {
      if (retryCount < this.maxRetries) {
        console.log(`Retry ${retryCount + 1}/${this.maxRetries} for ${url}`);
        await this.delay(1000 * (retryCount + 1));
        return this.fetch(url, retryCount + 1);
      }
      throw error;
    }
  }

  parseHTML(html) {
    return cheerio.load(html);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async crawl() {
    throw new Error('crawl() must be implemented by subclass');
  }
}

export const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const DEFAULT_MAX_RETRIES = DEFAULT_MAX_RETRIES;
export class BaseCrawler extends BaseCrawler {};
export default BaseCrawler;
