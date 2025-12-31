# GrantFlow Production Deployment Guide

## Pull Request: resolve-merge-conflicts → main

### Overview
This PR merges the `resolve-merge-conflicts` branch into `main`, bringing the production-ready implementation with all merge conflicts resolved.

### Branch Status
- **Source Branch**: `resolve-merge-conflicts`
- **Target Branch**: `main`
- **Base Commit**: `1f19d1f` (feat/production-readiness)
- **Merge Commit**: `ca566ff` (merged main with --allow-unrelated-histories)
- **Latest Commit**: `aa74cd1` (linter fixes)

### Pre-Merge Verification Results

#### ✅ Lint Check
```bash
npm run lint
```
**Result**: PASS - 0 errors, 0 warnings

All linting issues have been fixed:
- Fixed 23 regex escape character errors in parser files
- Removed 5 unused eslint-disable directives
- Suppressed 6 intentional react-refresh warnings for shadcn/ui patterns

#### ✅ Build Check
```bash
npm run build
```
**Result**: PASS - Build completed successfully

Build output:
- `dist/index.html` (0.46 kB)
- `dist/assets/index-B5up8E1v.css` (99.36 kB)
- `dist/assets/index-C_EI4-Bz.js` (1,980.91 kB)

#### ℹ️ Smoke Test
```bash
npm run smoke:login
```
**Note**: The smoke test is configured for Vercel deployment with `/grantflow` base path routing.

**Local Testing**: The app is accessible at `http://127.0.0.1:4173/login` (without `/grantflow` prefix)

**Production Testing**: After Vercel deployment, run:
```bash
SMOKE_BASE_URL=https://your-vercel-app.vercel.app npm run smoke:login
```

The test expects:
- Route: `/grantflow/login`
- Text: "GrantFlow Control Center"
- Element: `input[type="password"]`

### Files Changed
- **222 files changed**
- **59,067 insertions(+)**
- **3,204 deletions(-)**

### Key Changes
- ✅ All merge conflicts resolved (kept production-readiness versions)
- ✅ Integrated crawler, parser, and audit infrastructure from main
- ✅ Maintained complete production-readiness feature set
- ✅ Fixed all linting errors and warnings

---

## Vercel Deployment Configuration

### Environment Variables

Set the following environment variable in Vercel dashboard:

```bash
VITE_API_URL=https://grantflow-production.up.railway.app
```

Or your final backend URL. This tells the frontend where to send API requests.

### Verify vercel.json Configuration

The `vercel.json` file is already configured correctly for `/grantflow` routing:

```json
{
  "redirects": [
    {
      "source": "/",
      "destination": "/grantflow",
      "permanent": false
    }
  ],
  "rewrites": [
    {
      "source": "/grantflow",
      "destination": "/index.html"
    },
    {
      "source": "/grantflow/:path*",
      "destination": "/index.html"
    }
  ]
}
```

This configuration:
- Redirects root `/` to `/grantflow`
- Serves the SPA for all `/grantflow/*` routes
- Enables client-side routing for the React app

### API Proxy (if needed)

If you need to proxy API requests through Vercel (not recommended for production), you can add:

```json
{
  "rewrites": [
    {
      "source": "/grantflow/api/:path*",
      "destination": "https://grantflow-production.up.railway.app/api/:path*"
    }
  ]
}
```

However, the app is configured to use `VITE_API_URL` directly for API calls.

### Deployment Steps

1. **Merge this PR** into `main` branch
2. **Set environment variables** in Vercel:
   - Go to Project Settings → Environment Variables
   - Add: `VITE_API_URL` = `https://your-backend-url.railway.app`
3. **Deploy**: Vercel will auto-deploy on merge to main
4. **Verify**: Check the preview URL from Vercel dashboard

---

## Railway Backend Configuration

### Database Setup

The repository includes `grantflow-migration.zip` with the starter database.

#### Option 1: Use Pre-built Database (Recommended)

1. **Unzip the migration file**:
   ```bash
   unzip grantflow-migration.zip -d backend/data/
   ```

2. **Verify database exists**:
   ```bash
   ls -la backend/data/grantflow.db
   ```

3. **Set DATABASE_URL** (if needed):
   ```bash
   DATABASE_URL=./data/grantflow.db
   ```

#### Option 2: Import Data from JSON Export

If you have a Base44 export file:

1. **Place your export file**:
   ```bash
   # Copy your export file to the root
   cp your-export.json /path/to/backend/data-export.json
   ```

2. **Run the import script**:
   ```bash
   cd backend
   node import-data.js data-export.json
   ```

The script will:
- Initialize the database schema from `backend/db/schema.sql`
- Import organizations, grants, expenses, milestones, and documents
- Create proper relationships and indexes

### Backend Environment Variables

Set these in Railway:

```bash
# Database (SQLite is local, no URL needed unless using external DB)
DATABASE_URL=./data/grantflow.db

# Port (Railway provides this automatically)
PORT=8080

# Admin token for authentication
ADMIN_TOKEN=your-secure-admin-token-here

# OpenAI API key (if using AI features)
OPENAI_API_KEY=sk-...

# Allowed origins for CORS
ALLOWED_ORIGINS=https://your-vercel-app.vercel.app
```

### Deployment Verification

After both frontend and backend are deployed:

1. **Test the login page**:
   ```bash
   SMOKE_BASE_URL=https://your-vercel-app.vercel.app npm run smoke:login
   ```

2. **Test API connectivity**:
   ```bash
   curl https://your-backend-url.railway.app/api/health
   ```

3. **Test full flow**:
   - Open `https://your-vercel-app.vercel.app/grantflow/login`
   - Enter admin token
   - Verify dashboard loads
   - Check that API calls work (check browser console)

---

## Post-Deployment Checklist

- [ ] Verify Vercel build completed successfully
- [ ] Verify Railway backend is running
- [ ] Test login page loads (`/grantflow/login`)
- [ ] Test admin authentication works
- [ ] Test dashboard loads after login
- [ ] Test API calls to backend (check Network tab)
- [ ] Run smoke test against production URL
- [ ] Verify database is accessible
- [ ] Check logs for any errors

---

## Troubleshooting

### Issue: 404 on /grantflow routes

**Solution**: Ensure `vercel.json` is deployed and configured correctly. Vercel should rewrite all `/grantflow/*` paths to `/index.html`.

### Issue: API calls fail with CORS errors

**Solution**: 
1. Check `ALLOWED_ORIGINS` in Railway backend includes your Vercel URL
2. Verify `VITE_API_URL` in Vercel points to correct backend URL

### Issue: Database not found on Railway

**Solution**: 
1. Ensure `grantflow-migration.zip` was unzipped to `backend/data/`
2. Verify `DATABASE_URL` path is correct
3. Check file permissions on Railway

### Issue: Smoke test fails

**Solution**:
1. Verify Vercel deployment is complete
2. Check that `/grantflow/login` route is accessible
3. Ensure base path routing is configured correctly
4. Run with debug: `DEBUG=pw:api SMOKE_BASE_URL=... npm run smoke:login`

---

## Rollback Plan

If issues occur after deployment:

1. **Immediate**: Revert the merge in GitHub
2. **Vercel**: Will auto-deploy the previous version
3. **Railway**: No changes needed (database is backward compatible)

---

## Support

For issues or questions:
- Check the logs in Vercel dashboard
- Check the logs in Railway dashboard
- Review this deployment guide
- Check the `README.md` for application details
