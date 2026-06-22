#!/usr/bin/env node
/**
 * seed-all-opportunities.mjs
 *
 * Populates the funding_opportunities table with ALL curated programs
 * from the crawler data modules (federal, national, business, scholarships,
 * state programs for all 51 states). These appear on the Finding Opportunities page.
 *
 * Also optionally runs the geo crawl for deeper ZIP-level coverage.
 *
 * Usage:
 *   node scripts/seed-all-opportunities.mjs [--geo] [--state XX] [--offline]
 *
 * Flags:
 *   --geo       After seeding curated data, run the geo crawl
 *   --state XX  Only seed/crawl a single state (default: all 51)
 *   --offline   Geo crawl uses offline-only mode (no external API calls)
 *   --resume    Resume geo crawl from last checkpoint
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve backend root
const backendRoot = join(__dirname, '..', 'backend');

function imp(relPath) {
  return import(pathToFileURL(join(backendRoot, relPath)).href);
}

const ALL_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

async function main() {
  const args = process.argv.slice(2);
  const doGeo = args.includes('--geo');
  const offlineOnly = args.includes('--offline');
  const resume = args.includes('--resume');
  const stateIdx = args.indexOf('--state');
  const singleState = stateIdx !== -1 ? args[stateIdx + 1]?.toUpperCase() : null;

  console.log('='.repeat(70));
  console.log('  GrantFlow Opportunity Seeder');
  console.log('='.repeat(70));
  console.log(`  Mode: Curated seed${doGeo ? ' + Geo crawl' : ''}`);
  if (singleState) console.log(`  State filter: ${singleState}`);
  if (doGeo) console.log(`  Offline: ${offlineOnly}`);
  console.log();

  // Connect to DB
  const { getDb } = await imp('db/index.js');
  const db = getDb();

  // Phase A: Seed curated programs
  console.log('[Phase A] Seeding curated programs into funding_opportunities...');
  const seeded = await seedCuratedPrograms(db, singleState);
  console.log(`[Phase A] Done: ${seeded.total} programs seeded (${seeded.new} new, ${seeded.updated} updated)`);
  console.log(`  Federal: ${seeded.federal}, National: ${seeded.national}, Business: ${seeded.business}`);
  console.log(`  Scholarships: ${seeded.scholarships}, State: ${seeded.state}`);
  console.log();

  // Verify
  const countRow = await db.prepare('SELECT COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1').get();
  const urlRow = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1 AND (source_url IS NOT NULL AND source_url != '' OR application_url IS NOT NULL AND application_url != '')`
  ).get();
  console.log(`[Verify] Total active opportunities: ${countRow?.cnt || 0}`);
  console.log(`[Verify] With valid URL: ${urlRow?.cnt || 0} (${countRow?.cnt ? Math.round(urlRow.cnt / countRow.cnt * 100) : 0}%)`);
  console.log();

  // Phase B: Optional geo crawl
  if (doGeo) {
    console.log('[Phase B] Starting geo crawl...');
    await runGeoCrawl(db, { singleState, offlineOnly, resume });
  }

  // Final summary
  const finalCount = await db.prepare('SELECT COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1').get();
  const finalUrl = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1 AND (source_url IS NOT NULL AND source_url != '' OR application_url IS NOT NULL AND application_url != '')`
  ).get();
  console.log();
  console.log('='.repeat(70));
  console.log(`  FINAL: ${finalCount?.cnt || 0} active opportunities`);
  console.log(`  URL coverage: ${finalUrl?.cnt || 0} / ${finalCount?.cnt || 0} (${finalCount?.cnt ? Math.round(finalUrl.cnt / finalCount.cnt * 100) : 0}%)`);
  console.log('='.repeat(70));
}

async function seedCuratedPrograms(db, singleState) {
  const { upsertFundingOpportunity } = await imp('services/opportunityInserter.js');
  const { FEDERAL_BENEFITS } = await imp('services/shared/data/federalBenefits.js');
  const { NATIONAL_PROGRAMS } = await imp('services/shared/data/nationalPrograms.js');
  const { BUSINESS_PROGRAMS } = await imp('services/shared/data/businessPrograms.js');
  const { SCHOLARSHIPS } = await imp('services/shared/data/scholarships.js');
  const { generateStatePrograms, isStateInRegistry } = await imp('services/shared/data/stateBase.js');

  const stats = { total: 0, new: 0, updated: 0, federal: 0, national: 0, business: 0, scholarships: 0, state: 0 };

  async function upsert(program, source, sourceLabel) {
    const url = program.url || program.applicationUrl || null;
    if (!url) return;
    try {
      await upsertFundingOpportunity(db, {
        title: program.name,
        description: program.description,
        sponsor: program.stateRestriction
          ? `${program.stateRestriction} State Program`
          : program.id?.startsWith('fed-') ? 'Federal Program'
          : program.id?.startsWith('biz-') ? 'Business Program'
          : program.id?.startsWith('sch-') ? 'Scholarship Program'
          : 'National Program',
        source: source,
        source_url: url,
        url: url,
        application_url: program.applicationUrl || url,
        state: program.stateRestriction || 'nationwide',
        is_national: !program.stateRestriction,
        opportunity_type: program.type === 'portal' ? 'directory'
          : program.type === 'grant' ? 'grant'
          : program.fundingType?.includes('scholarship') ? 'scholarship'
          : 'program',
        type: program.type === 'portal' ? 'DIRECTORY' : 'OPPORTUNITY',
        deadline_type: 'rolling',
        amount_max: program.maxAmount || null,
        categories: JSON.stringify(program.categories || []),
        keywords: JSON.stringify(program.categories || []),
        funding_type: program.fundingType || null,
        record_origin: 'curated_verified',
        last_verified_at: new Date().toISOString(),
      });
      stats.total++;
      stats[sourceLabel]++;
    } catch (e) {
      // Ignore duplicates / constraint errors
    }
  }

  // Federal benefits
  for (const prog of FEDERAL_BENEFITS) {
    await upsert(prog, 'federal_benefits', 'federal');
  }
  console.log(`  [Federal] ${FEDERAL_BENEFITS.length} programs processed`);

  // National programs
  for (const prog of NATIONAL_PROGRAMS) {
    await upsert(prog, 'national_programs', 'national');
  }
  console.log(`  [National] ${NATIONAL_PROGRAMS.length} programs processed`);

  // Business programs
  for (const prog of BUSINESS_PROGRAMS) {
    await upsert(prog, 'business_programs', 'business');
  }
  console.log(`  [Business] ${BUSINESS_PROGRAMS.length} programs processed`);

  // Scholarships
  for (const prog of SCHOLARSHIPS) {
    await upsert(prog, 'scholarships', 'scholarships');
  }
  console.log(`  [Scholarships] ${SCHOLARSHIPS.length} programs processed`);

  // State programs (all 51 or single)
  const statesToSeed = singleState ? [singleState] : ALL_STATES;
  for (const st of statesToSeed) {
    // Try dedicated state file first
    let statePrograms = [];
    try {
      const mod = await import(pathToFileURL(join(backendRoot, 'services', 'shared', 'data', 'states', `${st}.js`)).href);
      statePrograms = (mod.STATE_BENEFITS || []).map(b => ({ ...b, stateRestriction: st }));
    } catch {
      // Fall back to generated
      if (isStateInRegistry(st)) {
        const gen = generateStatePrograms(st);
        statePrograms = (gen.benefits || []).map(b => ({ ...b, stateRestriction: st }));
      }
    }

    for (const prog of statePrograms) {
      await upsert(prog, `state_${st.toLowerCase()}`, 'state');
    }
  }
  console.log(`  [State] ${statesToSeed.length} states processed`);

  return stats;
}

async function runGeoCrawl(db, { singleState, offlineOnly, resume }) {
  const { runNationalZipCrawl } = await imp('services/crawlers/nationalZipCrawler.js');

  const statesToCrawl = singleState ? [singleState] : ALL_STATES;
  let totalProcessed = 0;
  let totalSources = 0;
  let totalFailed = 0;
  const failedStates = [];

  for (const st of statesToCrawl) {
    const t0 = Date.now();
    console.log(`  [GeoCrawl] ${st} starting...`);
    try {
      const result = await runNationalZipCrawl(db, {
        state: st,
        offline_only: offlineOnly,
        discover_local_resources: true,
        batch_size: 50,
        min_sources_per_zip: 3,
        rate_limit_ms: offlineOnly ? 0 : 250,
        resume: resume,
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      totalProcessed += Number(result?.processed || 0);
      totalSources += Number(result?.sources || 0);
      totalFailed += Number(result?.failed || 0);
      console.log(`  [GeoCrawl] ${st} done: ${result?.processed || 0} ZIPs, ${result?.sources || 0} sources (${elapsed}s)`);
    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`  [GeoCrawl] ${st} FAILED (${elapsed}s): ${e.message}`);
      failedStates.push(st);
    }
  }

  console.log();
  console.log(`[Phase B] Geo crawl complete:`);
  console.log(`  States: ${statesToCrawl.length}, ZIPs processed: ${totalProcessed}, Sources found: ${totalSources}`);
  if (failedStates.length > 0) {
    console.log(`  Failed states: ${failedStates.join(', ')}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
