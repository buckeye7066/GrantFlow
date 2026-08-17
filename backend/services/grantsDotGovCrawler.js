/**
 * Grants.gov catalog crawler.
 *
 * Network/request shaping and source transformation live exclusively in the
 * shared Grants.gov client. This module only owns catalog iteration and writes.
 */

import { upsertFundingOpportunity } from './opportunityInserter.js';
import { createLogger } from '../utils/logger.js';
import {
  fetchGrantsGov,
  transformGrantsGovOpportunity,
} from './shared/grantsGovApiClient.js';

export { fetchGrantsGov, transformGrantsGovOpportunity } from './shared/grantsGovApiClient.js';

const log = createLogger('grantsDotGovCrawler');

/**
 * Crawl Grants.gov and populate database
 */
export async function crawlGrantsGov(db, options = {}) {
  if (!db) {
    throw new Error('Database connection required for crawlGrantsGov');
  }
  const { maxPages = 4, rowsPerPage = 25 } = options;
  
  log.info('[GrantsGov] Starting crawl...');
  
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalErrors = 0;
  let keywordErrors = 0;
  
  // Search categories to maximize coverage
  const searchTerms = [
    '', // All open grants
    'education',
    'health',
    'community',
    'housing',
    'environment',
    'arts',
    'science',
    'technology',
    'agriculture',
    'transportation',
    'economic development',
    'social services',
    'youth',
    'elderly',
    'disability',
    'veterans',
    'workforce',
    'infrastructure',
    'rural',
  ];
  
  for (const keyword of searchTerms) {
    log.info(`[GrantsGov] Searching: "${keyword || 'all open grants'}"...`);
    
    let keywordFailed = false;
    for (let page = 0; page < maxPages; page++) {
      const startRow = page * rowsPerPage;
      
      const data = await fetchGrantsGov({
        keyword,
        rows: rowsPerPage,
        startRow,
      });
      
      if (!data) {
        // fetchGrantsGov already logged the error; skip this keyword
        console.warn(`[GrantsGov] Skipping remaining pages for keyword "${keyword || 'all open grants'}" after fetch failure`);
        keywordFailed = true;
        break;
      }

      if (!data.oppHits || data.oppHits.length === 0) {
        break; // No more results for this keyword
      }
      
      for (const opp of data.oppHits) {
        const transformed = transformGrantsGovOpportunity(opp);
        // Pre-filter: skip obviously closed opportunities before touching the DB
const status = (opp?.oppStatus ?? '').toLowerCase();
if (status === 'closed' || status === 'archived') {
  log.info(`[GrantsGov] Skipping closed/archived opportunity ${transformed.id} (${opp?.oppStatus})`);
  continue;
}

const result = await upsertFundingOpportunity(db, {
  ...transformed,
  record_origin: 'funding_api',
  evidence_url: transformed.source_url ?? transformed.application_url ?? null,
});
        
        if (result.inserted) totalInserted++;
        else if (result.updated) totalUpdated++;
        else if (result.error) totalErrors++;
      }
      
      // Don't hammer the API
      await new Promise(r => setTimeout(r, 500));
      
      // If fewer results than requested, we've reached the end
      if (data.oppHits.length < rowsPerPage) {
        break;
      }
    }

    if (keywordFailed) keywordErrors++;
  }
  
  log.info(`[GrantsGov] Complete: ${totalInserted} inserted, ${totalUpdated} updated, ${totalErrors} errors, ${keywordErrors}/${searchTerms.length} keywords failed`);
  
  return {
    inserted: totalInserted,
    updated: totalUpdated,
    errors: totalErrors,
    keyword_errors: keywordErrors,
    keywords_total: searchTerms.length,
  };
}

export default { crawlGrantsGov, fetchGrantsGov, transformGrantsGovOpportunity };
