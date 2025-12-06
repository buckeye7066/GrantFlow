/**
 * Check if an opportunity is already in the pipeline
 */
export function isOpportunityInPipeline(url, grants, orgId) {
  return grants.some(g => g.url === url && g.organization_id === orgId);
}

/**
 * Check if a source is due for crawling
 */
export function getSourceDueStatus(source) {
  if (!source.active) return false;
  if (!source.last_crawled) return true;

  const now = new Date();
  const lastCrawled = new Date(source.last_crawled);
  const frequency = source.crawl_frequency || 'monthly';

  const intervals = {
    daily: 1,
    weekly: 7,
    monthly: 30,
    quarterly: 90,
    annually: 365,
  };

  const daysSinceLastCrawl = (now.getTime() - lastCrawled.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceLastCrawl >= (intervals[frequency] || 30);
}

/**
 * Format source type label for display
 */
export function formatSourceTypeLabel(type) {
  if (!type) return 'Unknown';
  return type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}