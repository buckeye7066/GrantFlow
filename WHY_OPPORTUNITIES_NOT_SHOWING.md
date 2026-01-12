# Why Opportunities Aren't Showing & How to Fix

## The Issue

Funding opportunities are not appearing at https://app.axiombiolabs.org/grantflow/FundingOpportunities

## Root Cause

The funding opportunities are stored in a **SQLite database file** (`backend/data/grantflow.db`) that must exist on the **Railway production server**. 

The crawler scripts we created work correctly, but they created opportunities in a **local/CI environment database**, not on the production server.

## The Solution

You need to run the crawler on the **Railway production server** to populate its database.

### Quick Fix (Recommended)

Use Railway CLI to run the setup on production:

```bash
# 1. Install Railway CLI (if not installed)
npm install -g @railway/cli

# 2. Login
railway login

# 3. Link to your project
railway link

# 4. Run the setup script on production
railway run bash ./scripts/setup-production-db.sh
```

This will:
- Create the database with 11 profiles
- Run targeted crawler (450 ZIPs, ~10-15 minutes)
- Prepopulate profiles with matched grants
- Verify everything is working

### Alternative: Manual Setup

If Railway CLI doesn't work, run these commands on the production server:

```bash
npm run seed:db              # Create database
npm run crawl:targeted       # Run targeted crawler (faster)
npm run prepopulate:grants   # Match to profiles
```

Or for full nationwide coverage:

```bash
npm run seed:db              # Create database
npm run crawl:geo -- --state=CA   # Geo Crawl (admin; state scoped)
npm run ingest                    # Official APIs (Grants.gov + USASpending.gov)
npm run prepopulate:grants   # Match to profiles
```

## What Each Script Does

### `npm run seed:db`
Creates the database with 11 organization profiles.

### `npm run crawl:targeted`
Crawls 50 ZIPs per organization state (450 total ZIPs).
- **Time**: 10-15 minutes
- **Result**: ~1,350-2,250 opportunities
- **Coverage**: 9 states where organizations are located

### `npm run crawl:geo`
Crawls all 43,859 USA ZIP codes.
- **Time**: 20-30 minutes  
- **Result**: ~131,577+ opportunities
- **Coverage**: Complete USA coverage

### `npm run prepopulate:grants`
Matches opportunities to profiles (≥80% match score) and adds top 50 to each profile's pipeline.

## Verifying It Works

After running the setup, verify:

### 1. Check the API
```bash
# Via Railway CLI
railway run curl http://localhost:3000/api/opportunities

# Or visit in browser
https://grantflow-production.up.railway.app/api/opportunities
```

### 2. Check the Frontend
Visit: https://app.axiombiolabs.org/grantflow/FundingOpportunities

You should see a list of funding opportunities.

## Important: Database Persistence

**Railway needs persistent storage configured** or the database will be lost on restart.

### Configure Persistent Storage:

1. Go to Railway project dashboard
2. Navigate to your service settings
3. Add a **Volume** mount for `/app/backend/data`
4. This ensures the database persists across deployments

Without persistent storage, you'll need to re-run the crawler after each deployment.

## Deployment Integration

### Option 1: Post-Deploy Hook

Add to Railway environment or Dockerfile:

```bash
# Run after each deployment
npm run setup:production
```

### Option 2: Include in Build

Update `railway.json`:

```json
{
  "deploy": {
    "startCommand": "npm run setup:production && npm start"
  }
}
```

### Option 3: Seed from Backup

If you've already run the crawler locally:

1. Copy `backend/data/grantflow.db` to Railway server
2. Place at `/app/backend/data/grantflow.db`
3. Restart the service

## Architecture Note

This application uses:
- **Frontend**: Vite/React (deployed to Vercel at app.axiombiolabs.org)
- **Backend**: Express API (deployed to Railway at grantflow-production.up.railway.app)
- **Database**: SQLite file on Railway server

The frontend makes API calls to Railway, which reads from the local SQLite database. The database must exist and be populated on the Railway server.

## Summary

**Problem**: Database with opportunities exists locally, not on production Railway server.

**Solution**: Run `npm run setup:production` via Railway CLI to populate the production database.

**Prevention**: Configure persistent storage on Railway and/or include database setup in deployment process.

---

Need help? Check the full guide: [PRODUCTION_DEPLOYMENT_GUIDE.md](./PRODUCTION_DEPLOYMENT_GUIDE.md)
