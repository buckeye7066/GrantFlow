import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { upsertFundingOpportunity } from '../services/opportunityInserter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REAL_OPPS_PATH = join(__dirname, '../data/crawlers/real_funding_opportunities.json');
const LOCAL_OPPS_PATH = join(__dirname, '../data/crawlers/local_opportunities.json');
const SCHOLARSHIP_OPPS_PATH = join(__dirname, '../data/crawlers/scholarship_opportunities.json');
const ITEM_OPPS_PATH = join(__dirname, '../data/crawlers/item_funding_sources.json');

function loadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`[seedRealOpportunities] Could not load ${path}:`, error.message);
    return null;
  }
}

function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

export function seedRealOpportunities(db) {
  console.log('[seedRealOpportunities] Starting to seed real funding opportunities...');

  const realData = loadJSON(REAL_OPPS_PATH) || {};
  const realFederalGrants = realData.federal_grants || [];
  const realFoundationGrants = realData.foundation_grants || [];
  const realStateGrants = realData.state_programs || [];
  const realDisabilityGrants = realData.disability_assistance || [];
  const realVeteranGrants = realData.veteran_benefits || [];
  const realNonprofitGrants = realData.nonprofit_grants || [];
  const realScholarships = loadJSON(SCHOLARSHIP_OPPS_PATH) || [];
  const realLocalOpportunities = loadJSON(LOCAL_OPPS_PATH) || [];
  const realItemFunding = loadJSON(ITEM_OPPS_PATH) || [];

  const allRealOpportunities = [
    ...realFederalGrants,
    ...realFoundationGrants,
    ...realStateGrants,
    ...realDisabilityGrants,
    ...realVeteranGrants,
    ...realNonprofitGrants,
    ...(Array.isArray(realScholarships) ? realScholarships : []),
    ...(Array.isArray(realLocalOpportunities) ? realLocalOpportunities : []),
    ...(Array.isArray(realItemFunding) ? realItemFunding : [])
  ].map(opp => ({
    ...opp,
    id: opp.id || crypto.randomUUID(),
    source: opp.source || 'seeded_real_grant',
    source_id: opp.source_id || opp.id,
    eligibility_bullets: ensureArray(opp.eligibility_bullets),
    categories: ensureArray(opp.categories),
    keywords: ensureArray(opp.keywords),
    match_reasons: ensureArray(opp.match_reasons),
    requires_match: opp.requires_match === true ? 1 : 0,
    requires_501c3: opp.requires_501c3 === true ? 1 : 0,
    is_national: opp.state === 'nationwide' ? 1 : 0,
    opportunity_type: opp.opportunity_type || (opp.categories?.includes('scholarship') ? 'scholarship' : 'grant'),
    application_url: opp.application_url || opp.url,
    source_url: opp.source_url || opp.url,
  }));

  console.log(`[seedRealOpportunities] Loaded ${allRealOpportunities.length} real opportunities for seeding.`);

  let seeded = 0;
  for (const opp of allRealOpportunities) {
    try {
      upsertFundingOpportunity(db, opp);
      seeded++;
    } catch (error) {
      console.warn(`[seedRealOpportunities] Failed to upsert opportunity ${opp.title}:`, error.message);
    }
  }

  console.log(`[seedRealOpportunities] Finished seeding ${seeded} real opportunities.`);
  return { totalLoaded: seeded };
}

export default seedRealOpportunities;
