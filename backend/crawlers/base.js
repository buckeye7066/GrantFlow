const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 1;

/**
 * Base crawler that wraps crawl operations with retry/recovery logic.
 */
class BaseCrawler {
  constructor(options = {}) {
    const {
      items = [],
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxRetries = DEFAULT_MAX_RETRIES,
      logger = console,
    } = options;

    this.items = items;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxRetries =
      Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULT_MAX_RETRIES;
    this.logger = logger || console;

    this.errors = [];
    this.completed = 0;
    this.total = items.length;
    this.opportunitiesFound = 0;
  }

  /**
   * Implement in subclasses to perform actual crawl.
   * @param {*} item
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async crawl(item) {
    throw new Error('crawl(item) must be implemented by subclass');
  }

  /**
   * Update aggregated counters.
   * @param {number} count
   */
  incrementOpportunities(count = 1) {
    this.opportunitiesFound += count;
  }

  /**
   * Wrap crawl invocation with error recovery so the crawler never aborts
   * a full run because of a single failing item.
   * @param {*} item
   */
  async crawlWithRecovery(item) {
    try {
      await this.withRetry(() => this.crawl(item), { item });
    } catch (error) {
      const message = `[Crawler] Error on ${item}, skipping: ${error.message}`;
      this.logger.error(message);
      this.errors.push({ item, error: error.message });
      // Continue to next item, don't throw
    } finally {
      this.completed += 1;
      this.logProgress();
    }
  }

  /**
   * Retry helper with exponential backoff.
   */
  async withRetry(task, { item }) {
    let attempt = 0;
    let delay = 500;
    // Ensure we attempt task at least once plus configured retries
    while (attempt <= this.maxRetries) {
      try {
        return await this.withTimeout(task, this.timeoutMs);
      } catch (error) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, this.timeoutMs);
        this.logger.warn(
          `[Crawler] Retry ${attempt} for ${item} after error: ${error.message}`,
        );
      }
    }
    return null;
  }

  /**
   * Run task with explicit timeout protection.
   * @param {Function} task
   * @param {number} timeout
   */
  async withTimeout(task, timeout) {
    return Promise.race([
      task(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timed out')), timeout),
      ),
    ]);
  }

  /**
   * Log run progress in desired format.
   */
  logProgress() {
    const errorsCount = this.errors.length;
    this.logger.log(
      `[Crawler] Completed ${this.completed}/${this.total} states, ` +
        `${this.opportunitiesFound} opportunities found, ` +
        `${errorsCount} errors (skipped)`,
    );
  }

  /**
   * Kick off a full crawl run.
   */
  async run() {
    for (const item of this.items) {
      // eslint-disable-next-line no-await-in-loop
      await this.crawlWithRecovery(item);
    }
    return {
      completed: this.completed,
      total: this.total,
      opportunitiesFound: this.opportunitiesFound,
      errors: this.errors,
    };
  }
}

module.exports = {
  BaseCrawler,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
};

