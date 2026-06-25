/**
 * Domain crawler entrypoint.
 * Finds config by id in DOMAIN_CRAWLER_REGISTRY and runs the domain crawler engine.
 */

import { DOMAIN_CRAWLER_REGISTRY } from './domainCrawlerRegistry.js'
import { runDomainCrawler } from './domainCrawlerEngine.js'
import { createLogger } from '../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainCrawlers')

/**
 * Crawl using a domain crawler type.
 * @param {Object} profile - Profile with signals
 * @param {string} crawlerType - Crawler id from registry
 * @param {Object} options - Options (min_match_score, etc.)
 * @returns {Promise<Object[]>} Array of opportunity objects
 */
export async function crawlDomain(profile, crawlerType, options = {}) {
  if (!profile) {
    throw new Error('Profile is required for domain crawling')
  }
  if (!crawlerType) {
    throw new Error('Crawler type is required')
  }
  const config = DOMAIN_CRAWLER_REGISTRY.find((c) => c.id === crawlerType)
  if (!config) {
    console.warn(`[domainCrawlers] Unknown crawler type '${crawlerType}' — returning empty array`)
    return []
  }

  let results
  try {
    results = await runDomainCrawler({
      profile,
      config,
      options,
    })
  } catch (error) {
    qualityLog.error(`Domain crawler ${crawlerType} failed:`, error)
    return []
  }

  return results
}

export { DOMAIN_CRAWLER_REGISTRY }
