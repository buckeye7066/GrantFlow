#!/usr/bin/env node
/**
 * Ingest All Sources
 * Runs all source connectors sequentially
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchGrantsGov } from '../backend/services/sources/grantsGov.js';
import { fetchUSASpending } from '../backend/services/sources/usaSpending.js';
import { ingestOpportunities } from '../backend/services/sources/ingestionService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get database path from env or use default
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../backend/data/grantflow.db');

console.log('=== Full Ingestion (All Sources) ===\n');
console.log('Database:', DB_PATH);

async function ingestSource(db, name, fetchFn, options) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Ingesting: ${name}`);
  console.log('='.repeat(50));
  
  try {
    console.log(`Fetching opportunities from ${name}...`);
    const { opportunities } = await fetchFn(options);
    
    console.log(`Fetched ${opportunities.length} opportunities`);
    
    if (opportunities.length === 0) {
      console.log(`No opportunities to ingest from ${name}`);
      return { success: true, records_inserted: 0, records_updated: 0 };
    }
    
    console.log('Ingesting into database...');
    const result = ingestOpportunities(db, opportunities, name);
    
    console.log(`\n${name} Results:`);
    console.log(`  Inserted: ${result.records_inserted}`);
    console.log(`  Updated: ${result.records_updated}`);
    console.log(`  Errors: ${result.errors}`);
    
    return result;
  } catch (error) {
    console.error(`\n✗ Error ingesting from ${name}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function main() {
  const db = new Database(DB_PATH);
  
  const results = [];
  
  try {
    // Ingest from Grants.gov
    const grantsGovResult = await ingestSource(
      db,
      'grants.gov',
      fetchGrantsGov,
      { limit: 100, offset: 0 }
    );
    results.push({ source: 'grants.gov', ...grantsGovResult });
    
    // Ingest from USASpending.gov
    const usaSpendingResult = await ingestSource(
      db,
      'usaspending.gov',
      fetchUSASpending,
      { limit: 100, page: 1 }
    );
    results.push({ source: 'usaspending.gov', ...usaSpendingResult });
    
    // Display summary
    console.log('\n' + '='.repeat(50));
    console.log('INGESTION SUMMARY');
    console.log('='.repeat(50));
    
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalErrors = 0;
    let failures = 0;
    
    for (const result of results) {
      console.log(`\n${result.source}:`);
      console.log(`  Success: ${result.success}`);
      if (result.success) {
        console.log(`  Inserted: ${result.records_inserted}`);
        console.log(`  Updated: ${result.records_updated}`);
        console.log(`  Errors: ${result.errors || 0}`);
        totalInserted += result.records_inserted || 0;
        totalUpdated += result.records_updated || 0;
        totalErrors += result.errors || 0;
      } else {
        console.log(`  Error: ${result.error}`);
        failures++;
      }
    }
    
    console.log('\nTotals:');
    console.log(`  Sources processed: ${results.length}`);
    console.log(`  Successes: ${results.length - failures}`);
    console.log(`  Failures: ${failures}`);
    console.log(`  Total inserted: ${totalInserted}`);
    console.log(`  Total updated: ${totalUpdated}`);
    console.log(`  Total errors: ${totalErrors}`);
    
    // Get total count in database
    const total = db.prepare(`
      SELECT COUNT(*) as count
      FROM funding_opportunities
      WHERE is_active = 1
    `).get();
    
    console.log(`\nTotal active opportunities in database: ${total.count}`);
    
    if (failures > 0) {
      console.log('\n⚠ Some sources failed to ingest');
      process.exit(1);
    } else {
      console.log('\n✓ All sources ingested successfully');
    }
  } catch (error) {
    console.error('\n✗ Fatal error during ingestion:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
