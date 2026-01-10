#!/usr/bin/env node
/**
 * Ingest USASpending.gov Opportunities
 * Fetches and ingests funding opportunities from USASpending.gov API
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchUSASpending } from '../backend/services/sources/usaSpending.js';
import { ingestOpportunities } from '../backend/services/sources/ingestionService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get database path from env or use default
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../backend/data/grantflow.db');

console.log('=== USASpending.gov Ingestion ===\n');
console.log('Database:', DB_PATH);

async function main() {
  // Connect to database
  const db = new Database(DB_PATH);
  
  try {
    console.log('\nFetching opportunities from USASpending.gov...');
    
    // Fetch opportunities
    const { opportunities, metadata } = await fetchUSASpending({
      limit: 100, // Fetch first 100 opportunities
      page: 1,
    });
    
    console.log(`\nFetched ${opportunities.length} opportunities from USASpending.gov`);
    
    if (opportunities.length === 0) {
      console.log('No opportunities to ingest');
      return;
    }
    
    // Ingest into database
    console.log('\nIngesting into database...');
    const result = ingestOpportunities(db, opportunities, 'usaspending.gov');
    
    // Display results
    console.log('\n=== Ingestion Results ===');
    console.log(`Success: ${result.success}`);
    console.log(`Run ID: ${result.run_id}`);
    console.log(`Records fetched: ${result.records_fetched}`);
    console.log(`Records inserted: ${result.records_inserted}`);
    console.log(`Records updated: ${result.records_updated}`);
    console.log(`Errors: ${result.errors}`);
    
    if (result.error_messages && result.error_messages.length > 0) {
      console.log('\nError messages:');
      result.error_messages.forEach(msg => console.log(`  - ${msg}`));
    }
    
    if (result.success) {
      console.log('\n✓ Ingestion completed successfully');
    } else {
      console.error('\n✗ Ingestion failed:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ Error during ingestion:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
