/**
 * Domain crawler entrypoint.
 * Finds config by id in DOMAIN_CRAWLER_REGISTRY and runs the domain crawler engine.
 */

import { DOMAIN_CRAWLER_REGISTRY } from './domainCrawlerRegistry.js'
import { runDomainCrawler } from './domainCrawlerEngine.js'

/**
 * Crawl using a domain crawler type.
 * @param {Object} profile - Profile with signals
 * @param {string} crawlerType - Crawler id from registry
 * @param {Object} options - Options (min_match_score, etc.)
 * @returns {Promise<Object[]>} Array of opportunity objects
 */
export async function crawlDomain(profile, crawlerType, options = {}) {
  const config = DOMAIN_CRAWLER_REGISTRY.find((c) => c.id === crawlerType)
  if (!config) {
    return []
  }

  const results = await runDomainCrawler({
    profile,
    config,
    options,
  })

  return results
}

export { DOMAIN_CRAWLER_REGISTRY }
