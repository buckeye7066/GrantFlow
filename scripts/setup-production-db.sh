#!/bin/bash
# Production Database Setup Script
# 
# This script sets up the funding opportunities database for production
# Run this on the Railway production server or via Railway CLI

set -e  # Exit on error

echo "=========================================="
echo "GrantFlow Production Database Setup"
echo "=========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "Error: package.json not found. Please run from project root."
    exit 1
fi

# Step 1: Create database and seed profiles
echo "Step 1: Creating database and seeding profiles..."
npm run seed:db
echo "✓ Database created with 11 profiles"
echo ""

# Step 2: Run targeted crawler for organization states (faster, 10-15 minutes)
echo "Step 2: Running targeted state crawler..."
echo "This will crawl 50 ZIPs per organization state (~450 ZIPs total)"
echo "Estimated time: 10-15 minutes"
echo ""

if [ -f "scripts/extended-state-crawler.mjs" ]; then
    node scripts/extended-state-crawler.mjs
    echo "✓ Targeted crawler complete"
else
    echo "Warning: extended-state-crawler.mjs not found, skipping..."
fi

echo ""

# Step 3: Prepopulate profiles with matched grants
echo "Step 3: Matching opportunities to profiles..."
npm run prepopulate:grants
echo "✓ Profiles prepopulated with matched grants"
echo ""

# Step 4: Verify setup
echo "Step 4: Verifying setup..."
node -e "
const Database = require('better-sqlite3');
const db = new Database('./backend/data/grantflow.db');

const oppsCount = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get();
const grantsCount = db.prepare('SELECT COUNT(*) as count FROM grants').get();
const profilesCount = db.prepare('SELECT COUNT(*) as count FROM profiles').get();

console.log('Verification Results:');
console.log('  Profiles:', profilesCount.count);
console.log('  Opportunities:', oppsCount.count);
console.log('  Grants:', grantsCount.count);

if (oppsCount.count === 0) {
  console.log('\\n⚠️  WARNING: No opportunities found!');
  process.exit(1);
}

if (grantsCount.count === 0) {
  console.log('\\n⚠️  WARNING: No grants matched to profiles!');
  process.exit(1);
}

console.log('\\n✓ Setup verification passed!');
db.close();
"

echo ""
echo "=========================================="
echo "Production Database Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Restart your Railway service if needed"
echo "2. Visit https://app.axiombiolabs.org/grantflow/FundingOpportunities"
echo "3. Verify opportunities are showing"
echo ""
echo "Optional: Run full nationwide crawler for complete coverage:"
echo "  npm run crawl:geo -- --state=CA (Geo Crawl; repeat per-state as needed)"
echo "  npm run ingest (official APIs: Grants.gov + USASpending.gov)"
echo ""
