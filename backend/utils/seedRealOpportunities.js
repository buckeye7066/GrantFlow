import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { upsertFundingOpportunity } from '../services/opportunityInserter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REAL_OPPS_PATH = join(__dirname, '../data/crawlers/real_funding_opportunities.json');
// Repo-tracked fallback fixtures (backend/data is often excluded in production images / ignored in some IDE setups).
const REAL_OPPS_FALLBACK_PATHS = [
  join(__dirname, '../fixtures/crawlers/real_funding_opportunities.json'),
]

const LOCAL_OPPS_PATH = join(__dirname, '../data/crawlers/local_opportunities.json');
const SCHOLARSHIP_OPPS_PATH = join(__dirname, '../data/crawlers/scholarship_opportunities.json');
const ITEM_OPPS_PATH = join(__dirname, '../data/crawlers/item_funding_sources.json');

const missingOnce = new Set();

function loadJSON(path, { required = false } = {}) {
  if (!existsSync(path)) {
    if (required) {
      if (!missingOnce.has(path)) {
        missingOnce.add(path)
        console.info(`[seedRealOpportunities] Seed file not found: ${path}`)
      }
    } else if (!missingOnce.has(path)) {
      missingOnce.add(path);
      console.info(
        `[seedRealOpportunities] Seed file not found; skipping: ${path} (run "npm run seed:demo" or "npm run ingest" to populate opportunities)`,
      );
    }
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // Missing seed files are expected in many environments (e.g. production images, fresh clones).
    // Only warn on non-ENOENT failures (e.g. invalid JSON).
    if (error?.code !== 'ENOENT') {
      console.warn('[seedRealOpportunities] Could not load ' + path + ':', error?.message || String(error));
    }
    return null;
  }
}
function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

export async function seedRealOpportunities(db) {
  const resolvedRealOppsPath = existsSync(REAL_OPPS_PATH)
    ? REAL_OPPS_PATH
    : (REAL_OPPS_FALLBACK_PATHS.find((p) => existsSync(p)) || null)

  const anySeedFileExists =
    Boolean(resolvedRealOppsPath) ||
    existsSync(LOCAL_OPPS_PATH) ||
    existsSync(SCHOLARSHIP_OPPS_PATH) ||
    existsSync(ITEM_OPPS_PATH);

  if (!anySeedFileExists) {
    console.info(
      '[seedRealOpportunities] No seed files found; skipping (run "npm run seed:demo" or "npm run ingest")',
    );
    return { totalLoaded: 0, skipped: true };
  }

  console.log('[seedRealOpportunities] Starting to seed real funding opportunities...');

  const realData = (resolvedRealOppsPath ? loadJSON(resolvedRealOppsPath, { required: true }) : null) || {};
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
    record_origin: 'curated_verified',
    eligibility_bullets: ensureArray(opp.eligibility_bullets),
    categories: ensureArray(opp.categories),
    keywords: ensureArray(opp.keywords),
    match_reasons: ensureArray(opp.match_reasons),
    requires_match: opp.requires_match === true ? 1 : 0,
    requires_501c3: opp.requires_501c3 === true ? 1 : 0,
    is_national: (opp.is_national === true || opp.state === 'nationwide') ? 1 : 0,
    opportunity_type: opp.opportunity_type || (opp.categories?.includes('scholarship') ? 'scholarship' : 'grant'),
    application_url: opp.application_url || opp.url,
    source_url: opp.source_url || opp.url,
  }));

  console.log(`[seedRealOpportunities] Loaded ${allRealOpportunities.length} real opportunities for seeding.`);

  let seeded = 0;
  for (const opp of allRealOpportunities) {
    try {
      // NOTE: upsertFundingOpportunity is async for sqlite/postgres parity.
      // Awaiting is safe even for sync DB adapters.
      await upsertFundingOpportunity(db, opp);
      seeded++;
    } catch (error) {
      console.warn(`[seedRealOpportunities] Failed to upsert opportunity ${opp.title}:`, error.message);
    }
  }

  console.log(`[seedRealOpportunities] Finished seeding ${seeded} real opportunities.`);
  return { totalLoaded: seeded, skipped: false };
}

export default seedRealOpportunities;
