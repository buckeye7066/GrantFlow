# Production Deployment Guide - Funding Opportunities

## Issue: Opportunities Not Showing on Production

The funding opportunities are stored in a SQLite database (`backend/data/grantflow.db`) that needs to exist on the **production server** (Railway deployment).

### Why Opportunities Aren't Showing

The nationwide crawler creates opportunities in the local database file. However, these opportunities need to be on the **production Railway server** to be visible at `https://app.axiombiolabs.org/grantflow/FundingOpportunities`.

## Solution Options

### Option 1: Run Crawler on Production Server (Recommended)

SSH into the Railway production server and run the crawler there:

```bash
# On Railway production server
cd /app
npm run seed:db           # Create database with profiles
npm run crawl:nationwide  # Run nationwide crawler (20-30 mins)
npm run prepopulate:grants # Match grants to profiles
```

### Option 2: Upload Database to Production

If you've already run the crawler locally:

1. Locate your local database: `backend/data/grantflow.db`
2. Upload it to Railway production server at `/app/backend/data/grantflow.db`
3. Restart the Railway service

### Option 3: Use Railway CLI

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login to Railway
railway login

# Link to your project
railway link

# Run commands on production
railway run npm run seed:db
railway run npm run crawl:nationwide
railway run npm run prepopulate:grants
```

### Option 4: Database Migration Script

Create a deployment script that runs automatically:

```bash
# Add to package.json scripts
"deploy:seed": "npm run seed:db && npm run crawl:nationwide && npm run prepopulate:grants"
```

Then configure Railway to run this on deployment.

## Verifying Opportunities Are Available

After running the crawler on production, verify:

1. **Check Database**: SSH to production and run:
   ```bash
   node -e "const db = require('better-sqlite3')('./backend/data/grantflow.db'); console.log('Opportunities:', db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get()); db.close();"
   ```

2. **Check API**: Visit `https://grantflow-production.up.railway.app/api/opportunities`

3. **Check Frontend**: Visit `https://app.axiombiolabs.org/grantflow/FundingOpportunities`

## Database Persistence on Railway

**Important**: Railway restarts can clear the database if not configured for persistence.

### Enable Persistent Storage on Railway:

1. Go to Railway project settings
2. Add a Volume mount for `/app/backend/data`
3. This ensures the database persists across deployments

## Current Status

- ✅ Crawler script created and tested
- ✅ Prepopulation script created and tested  
- ⚠️ Database needs to be created/populated on production Railway server
- ⚠️ Railway needs persistent storage configuration

## Quick Fix Commands

For immediate fix, run these commands on the Railway production server:

```bash
# Step 1: Create database
npm run seed:db

# Step 2: Crawl opportunities (takes 20-30 minutes)
npm run crawl:nationwide

# Step 3: Match to profiles
npm run prepopulate:grants

# Step 4: Verify
curl http://localhost:PORT/api/opportunities | jq '.data | length'
```

## Automated Solution

Add to your deployment workflow:

1. **Dockerfile**: Ensure database directory exists
   ```dockerfile
   RUN mkdir -p /app/backend/data
   ```

2. **Railway Build Command**: 
   ```bash
   npm install && npm run build && npm run seed:db
   ```

3. **Post-Deploy Hook**: Run crawler after deployment
   ```bash
   npm run crawl:nationwide && npm run prepopulate:grants
   ```

## Contact

If you need help running these commands on the production server, you'll need access to:
- Railway dashboard
- SSH/shell access to the running container
- Or Railway CLI configured with the project

---

**TL;DR**: The database with opportunities exists locally but needs to be on the Railway production server. Run `npm run seed:db && npm run crawl:nationwide && npm run prepopulate:grants` on the production server.
