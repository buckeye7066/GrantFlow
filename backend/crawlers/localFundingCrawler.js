import path from 'path';
import { fileURLToPath } from 'url';
import BaseCrawler from './base.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// State constants
export const ALL_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
];

export const STATE_ZIP_MAP = {
  'AL': ['35000-36999'],
  'AK': ['99500-99999'],
  'AZ': ['85000-86599'],
  'AR': ['71600-72999', '75500-75599'],
  'CA': ['90000-96199'],
  'CO': ['80000-81699'],
  'CT': ['06000-06999'],
  'DE': ['19700-19999'],
  'FL': ['32000-34999'],
  'GA': ['30000-31999', '39800-39999'],
  'HI': ['96700-96899'],
  'ID': ['83200-83899'],
  'IL': ['60000-62999'],
  'IN': ['46000-47999'],
  'IA': ['50000-52899'],
  'KS': ['66000-67999'],
  'KY': ['40000-42799'],
  'LA': ['70000-71599'],
  'ME': ['03900-04999'],
  'MD': ['20600-21999'],
  'MA': ['01000-02799'],
  'MI': ['48000-49999'],
  'MN': ['55000-56799'],
  'MS': ['38600-39799'],
  'MO': ['63000-65899'],
  'MT': ['59000-59999'],
  'NE': ['68000-69399'],
  'NV': ['89000-89899'],
  'NH': ['03000-03899'],
  'NJ': ['07000-08999'],
  'NM': ['87000-88499'],
  'NY': ['10000-14999'],
  'NC': ['27000-28999'],
  'ND': ['58000-58899'],
  'OH': ['43000-45999'],
  'OK': ['73000-74999'],
  'OR': ['97000-97999'],
  'PA': ['15000-19699'],
  'RI': ['02800-02999'],
  'SC': ['29000-29999'],
  'SD': ['57000-57799'],
  'TN': ['37000-38599'],
  'TX': ['75000-79999', '88500-88599'],
  'UT': ['84000-84799'],
  'VT': ['05000-05999'],
  'VA': ['20100-20199', '22000-24699'],
  'WA': ['98000-99499'],
  'WV': ['24700-26899'],
  'WI': ['53000-54999'],
  'WY': ['82000-83199']
};

export class LocalFundingCrawler extends BaseCrawler {
  constructor(config = {}) {
    super('local-funding', config);
    this.Database = null;
  }

  async initialize() {
    // Dynamic import for Database
    const { default: Database } = await import('../database.js');
    this.Database = Database;
  }

  async crawl(options = {}) {
    await this.initialize();
    
    const { states = ALL_STATES, limit = 100 } = options;
    const results = [];

    this.log('info', `Starting local funding crawl for states: ${states.join(', ')}`);

    for (const state of states) {
      try {
        this.log('info', `Crawling local funding for ${state}`);
        const stateResults = await this.crawlState(state, limit);
        results.push(...stateResults);
      } catch (error) {
        this.log('error', `Error crawling ${state}: ${error.message}`);
      }
    }

    this.log('info', `Completed local funding crawl. Found ${results.length} opportunities`);
    return results;
  }

  async crawlState(state, limit) {
    const zipRanges = STATE_ZIP_MAP[state] || [];
    const results = [];

    for (const zipRange of zipRanges) {
      const [start, end] = zipRange.split('-').map(z => parseInt(z));
      
      // Sample some zip codes from the range
      const sampleSize = Math.min(5, Math.ceil((end - start + 1) / 1000));
      const step = Math.floor((end - start + 1) / sampleSize);

      for (let i = 0; i < sampleSize && results.length < limit; i++) {
        const zip = start + (i * step);
        try {
          const zipResults = await this.searchByZipCode(zip.toString().padStart(5, '0'));
          results.push(...zipResults);
        } catch (error) {
          this.log('error', `Error searching zip ${zip}: ${error.message}`);
        }
      }

      if (results.length >= limit) break;
    }

    return results.slice(0, limit);
  }

  async searchByZipCode(zipCode) {
    this.log('debug', `Searching for opportunities near zip code: ${zipCode}`);
    
    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Query local government databases
    // 2. Search municipal grant programs
    // 3. Check county-level funding opportunities
    // 4. Search for community foundation grants
    
    const mockResults = [
      {
        title: `Local Community Grant - ${zipCode}`,
        description: 'Funding for local community projects',
        amount: 50000,
        deadline: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'local-government',
        location: zipCode,
        url: `https://example.com/grants/${zipCode}`,
        eligibility: ['non-profit', 'community-organization'],
        categories: ['community-development', 'local-impact']
      }
    ];

    return mockResults;
  }

  async saveResults(results) {
    if (!this.Database) {
      await this.initialize();
    }

    const db = new this.Database();
    const saved = [];

    for (const result of results) {
      try {
        const saved_result = await db.saveOpportunity({
          ...result,
          source: 'local-funding',
          crawled_at: new Date().toISOString()
        });
        saved.push(saved_result);
      } catch (error) {
        this.log('error', `Error saving result: ${error.message}`);
      }
    }

    this.log('info', `Saved ${saved.length} opportunities to database`);
    return saved;
  }
}

export default LocalFundingCrawler;
