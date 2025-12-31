# DNS Migration Guide: Vercel + Railway with GoDaddy/Cloudflare

This guide provides step-by-step instructions for migrating GrantFlow DNS from Digital Ocean to a modern Vercel (frontend) + Railway (backend) architecture using GoDaddy domain with Cloudflare DNS management.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Migration Strategy](#migration-strategy)
4. [Step 1: Setup Vercel for Frontend](#step-1-setup-vercel-for-frontend)
5. [Step 2: Setup Railway for Backend](#step-2-setup-railway-for-backend)
6. [Step 3: Configure Cloudflare DNS](#step-3-configure-cloudflare-dns)
7. [Step 4: Setup Origin Rules](#step-4-setup-origin-rules)
8. [Step 5: Verify Deployment](#step-5-verify-deployment)
9. [Rollback Plan](#rollback-plan)
10. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

### New Architecture (Vercel + Railway + Cloudflare)

```
GoDaddy Domain (axiombiolabs.org)
           ↓
   Cloudflare DNS + CDN
           ↓
   Origin Rules (Path-based routing)
   ├── /grantflow/* → Vercel (Frontend Static Files)
   └── /api/* → Railway (Backend API)
```

### Benefits of New Architecture

- **Vercel**: Optimized for React/Vite apps with automatic deployments and edge caching
- **Railway**: Modern backend hosting with automatic HTTPS and easy scaling
- **Cloudflare**: Free CDN, DDoS protection, and advanced routing capabilities
- **Reduced Maintenance**: No server management, automatic SSL, built-in monitoring
- **Better Performance**: Edge caching and global CDN distribution
- **Cost Efficiency**: Pay only for what you use, no idle server costs

### Legacy Architecture (Digital Ocean)

```
GoDaddy Domain → Cloudflare → Digital Ocean Droplet
                               ├── Nginx
                               ├── Frontend (Static Files)
                               └── Backend (Node.js)
```

**Note**: The Digital Ocean deployment is marked as legacy but will remain documented for reference.

---

## Prerequisites

Before starting the migration, ensure you have:

- [x] **GoDaddy Account** with access to `axiombiolabs.org` domain management
- [x] **Cloudflare Account** with the domain added
- [x] **Vercel Account** (free tier is sufficient)
- [x] **Railway Account** (free tier available)
- [x] **GitHub Repository** with GrantFlow code
- [x] **Environment Variables** documented (especially `ANYA_ADMIN_TOKEN`, API keys)
- [x] **Backup** of current configuration and data

---

## Migration Strategy

### Zero-Downtime Migration Approach

1. **Parallel Deployment**: Deploy to Vercel/Railway while keeping Digital Ocean running
2. **DNS Testing**: Test new deployment using Cloudflare origin rules with subdomain
3. **Gradual Cutover**: Switch DNS gradually using Cloudflare's routing
4. **Monitor**: Watch logs and metrics during migration
5. **Rollback Ready**: Keep Digital Ocean active for 48 hours post-migration

### Timeline

- **Day 1**: Deploy to Vercel and Railway (1-2 hours)
- **Day 2**: Configure Cloudflare and test (1-2 hours)
- **Day 3**: DNS cutover and monitoring (2-4 hours)
- **Day 4-5**: Verify stability and decommission Digital Ocean

---

## Step 1: Setup Vercel for Frontend

### 1.1 Connect GitHub Repository

1. Log in to [Vercel](https://vercel.com)
2. Click "Add New Project"
3. Import your GitHub repository: `buckeye7066/GrantFlow`
4. Select the repository and click "Import"

### 1.2 Configure Build Settings

```plaintext
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
Install Command: npm install
Root Directory: ./
Node.js Version: 18.x
```

### 1.3 Configure Environment Variables

Add the following environment variables in Vercel dashboard:

```env
NODE_ENV=production
VITE_API_BASE_URL=https://www.axiombiolabs.org/api
```

### 1.4 Configure Base Path

Verify `vite.config.ts` has the correct base path:

```javascript
export default defineConfig({
  base: '/grantflow/',
  // ... other config
});
```

### 1.5 Deploy Frontend

1. Click "Deploy" in Vercel
2. Wait for build to complete (2-5 minutes)
3. Note the deployment URL (e.g., `your-app.vercel.app`)
4. Test the deployment: `https://your-app.vercel.app/`

### 1.6 Custom Domain Configuration

Do NOT add custom domain in Vercel yet. We'll route traffic via Cloudflare Origin Rules.

---

## Step 2: Setup Railway for Backend

### 2.1 Create New Project

1. Log in to [Railway](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose `buckeye7066/GrantFlow`
5. Railway will auto-detect Node.js

### 2.2 Configure Service Settings

In Railway dashboard:

1. Click on your service
2. Go to "Settings" tab
3. Configure:
   - **Start Command**: `npm run start`
   - **Root Directory**: `./` (leave default)
   - **Watch Paths**: Leave empty (deploy on all changes)

### 2.3 Configure Environment Variables

Add the following environment variables:

```env
NODE_ENV=production
PORT=4000
ANYA_ADMIN_TOKEN=<your-secure-token>
CORS_ORIGIN=https://www.axiombiolabs.org,https://app.axiombiolabs.org
OPENAI_API_KEY=<your-openai-key>
DATABASE_PATH=./backend/data/grantflow.db
```

**Important**: Generate a secure `ANYA_ADMIN_TOKEN`:
```bash
openssl rand -hex 32
```

### 2.4 Configure Port

Railway automatically provides a `PORT` environment variable. Update `backend/server.js` if needed:

```javascript
const PORT = process.env.PORT || 4000;
```

### 2.5 Deploy Backend

1. Railway will automatically deploy after configuration
2. Wait for deployment (2-5 minutes)
3. Note the Railway domain (e.g., `your-app.up.railway.app`)
4. Test health endpoint: `https://your-app.up.railway.app/api/health`

### 2.6 Verify Backend Health

```bash
curl https://your-app.up.railway.app/api/health
# Expected: {"status":"ok","timestamp":"..."}

curl https://your-app.up.railway.app/api/opportunities
# Should return grant opportunities data
```

---

## Step 3: Configure Cloudflare DNS

### 3.1 Verify Cloudflare Nameservers

1. Log in to [GoDaddy](https://godaddy.com)
2. Go to "My Products" → "Domains"
3. Click on `axiombiolabs.org` → "Manage DNS"
4. Verify nameservers are set to Cloudflare:
   ```
   abe.ns.cloudflare.com
   joy.ns.cloudflare.com
   ```
   (Use the nameservers provided by Cloudflare for your account)

### 3.2 Configure DNS Records

Log in to [Cloudflare](https://cloudflare.com) and configure:

#### Existing Records (Keep These)
| Type | Name | Content | Proxy Status | TTL |
|------|------|---------|--------------|-----|
| A | app | `<Digital-Ocean-IP>` | Proxied | Auto |
| A | www | `<Digital-Ocean-IP>` | Proxied | Auto |
| A | @ | `<Digital-Ocean-IP>` | Proxied | Auto |

These will remain active during testing phase.

#### New Records (Add These)
| Type | Name | Content | Proxy Status | TTL |
|------|------|---------|--------------|-----|
| CNAME | vercel-test | `<your-vercel-app>.vercel.app` | DNS Only | Auto |
| CNAME | railway-test | `<your-railway-app>.up.railway.app` | DNS Only | Auto |

**Note**: Use "DNS Only" (gray cloud) for test domains to access origin directly.

### 3.3 SSL/TLS Configuration

1. Go to Cloudflare dashboard → SSL/TLS → Overview
2. Select **"Full (strict)"** encryption mode
3. Enable **"Always Use HTTPS"**
4. Enable **"Automatic HTTPS Rewrites"**

### 3.4 Additional Cloudflare Settings

**Speed Optimization:**
- Go to Speed → Optimization
- Enable "Auto Minify" for HTML, CSS, JS
- Enable "Rocket Loader" (optional, test first)

**Security:**
- Go to Security → Settings
- Set Security Level to "Medium"
- Enable "Browser Integrity Check"

**Network:**
- Go to Network
- Enable "HTTP/2"
- Enable "HTTP/3 (with QUIC)"
- Enable "WebSockets"

---

## Step 4: Setup Origin Rules

Cloudflare Origin Rules allow path-based routing to different origins.

### 4.1 Create API Origin Rule

1. Log in to Cloudflare
2. Go to **Rules** → **Origin Rules**
3. Click "Create Rule"

**Rule Configuration:**
- **Rule name**: `Route API to Railway`
- **If**: Custom filter expression
  - Field: `URI Path`
  - Operator: `starts with`
  - Value: `/api/`
- **Then**: Override origin
  - **Host Header**: Override
  - **Value**: `<your-railway-app>.up.railway.app`
  - **SNI**: Same as Host Header
  - **Port**: 443 (HTTPS)

**Priority**: Set to `1` (highest priority)

### 4.2 Create Frontend Origin Rule

1. Click "Create Rule" again

**Rule Configuration:**
- **Rule name**: `Route GrantFlow to Vercel`
- **If**: Custom filter expression
  - Field: `URI Path`
  - Operator: `starts with`
  - Value: `/grantflow/`
- **Then**: Override origin
  - **Host Header**: Override
  - **Value**: `<your-vercel-app>.vercel.app`
  - **SNI**: Same as Host Header
  - **Port**: 443 (HTTPS)

**Priority**: Set to `2`

### 4.3 Verify Origin Rules

1. Go to Rules → Origin Rules
2. Verify both rules are enabled
3. Order should be:
   1. Route API to Railway (Priority 1)
   2. Route GrantFlow to Vercel (Priority 2)

---

## Step 5: Verify Deployment

### 5.1 Test API Endpoints

```bash
# Test backend health
curl https://www.axiombiolabs.org/api/health
# Expected: {"status":"ok","timestamp":"..."}

# Test opportunities endpoint
curl https://www.axiombiolabs.org/api/opportunities
# Should return grant opportunities JSON

# Test ANYA status
curl https://www.axiombiolabs.org/api/anya/status
# Should return ANYA status
```

### 5.2 Test Frontend Routes

Open browser and test:

```
https://www.axiombiolabs.org/grantflow/
https://www.axiombiolabs.org/grantflow/about
https://www.axiombiolabs.org/grantflow/pricing
https://www.axiombiolabs.org/grantflow/dashboard
```

### 5.3 Test End-to-End Functionality

1. **Login Flow**: Test user authentication
2. **API Calls**: Verify frontend can call backend APIs
3. **Document Upload**: Test file upload functionality
4. **Grant Search**: Verify grant opportunity search
5. **ANYA Chat**: Test AI assistant functionality

### 5.4 Browser Developer Tools Check

Open DevTools (F12) and verify:

- [ ] No console errors
- [ ] No 404 errors in Network tab
- [ ] API calls succeed (200 status)
- [ ] CORS headers present
- [ ] HTTPS padlock shows secure connection

### 5.5 Performance Testing

Use [WebPageTest](https://www.webpagetest.org/) or [Lighthouse](https://developers.google.com/web/tools/lighthouse):

- Check load times
- Verify CDN is working (Cloudflare cache headers)
- Check for performance regressions

---

## Rollback Plan

If issues occur during migration, follow this rollback procedure:

### Quick Rollback (5 minutes)

1. **Disable Origin Rules**:
   - Go to Cloudflare → Rules → Origin Rules
   - Disable both rules (API and Frontend)
   - Traffic will route back to Digital Ocean

2. **Verify Rollback**:
   ```bash
   curl https://www.axiombiolabs.org/api/health
   curl https://www.axiombiolabs.org/grantflow/
   ```

### Full Rollback (15 minutes)

If you need to completely revert:

1. Delete Origin Rules in Cloudflare
2. Verify DNS points to Digital Ocean
3. Restart Digital Ocean services if needed:
   ```bash
   sudo systemctl restart grantflow-backend
   sudo systemctl restart nginx
   ```

### Post-Rollback Actions

1. Document what went wrong
2. Review logs from Vercel and Railway
3. Fix issues in staging environment
4. Plan retry migration

---

## Troubleshooting

### Issue: 502 Bad Gateway on API Calls

**Symptom**: API requests return 502 error

**Possible Causes:**
1. Railway backend not running
2. Wrong Railway domain in Origin Rule
3. CORS configuration issue

**Solutions:**
```bash
# Check Railway logs
# Go to Railway dashboard → Service → Logs

# Verify Railway domain is correct
curl https://<your-railway-app>.up.railway.app/api/health

# Check CORS_ORIGIN environment variable
# Should include: https://www.axiombiolabs.org
```

### Issue: Frontend Shows 404

**Symptom**: Navigating to `/grantflow/` shows 404

**Possible Causes:**
1. Vercel build failed
2. Wrong base path in Vite config
3. Origin Rule not active

**Solutions:**
```bash
# Check Vercel deployment logs
# Go to Vercel dashboard → Project → Deployments

# Verify Vercel domain
curl https://<your-vercel-app>.vercel.app/

# Check Origin Rule is enabled in Cloudflare
```

### Issue: CORS Errors in Browser

**Symptom**: Browser console shows CORS policy errors

**Solutions:**
1. Verify `CORS_ORIGIN` in Railway environment variables
2. Must include: `https://www.axiombiolabs.org,https://app.axiombiolabs.org`
3. Restart Railway service after changing env vars
4. Clear browser cache

### Issue: SSL Certificate Error

**Symptom**: Browser shows "Not Secure" or certificate errors

**Solutions:**
1. Verify Cloudflare SSL/TLS mode is "Full (strict)"
2. Check Vercel and Railway both have valid certificates
3. Clear browser SSL cache:
   - Chrome: `chrome://settings/clearBrowserData`
   - Firefox: `Options → Privacy & Security → Clear Data`

### Issue: Slow Load Times

**Symptom**: Pages load slower than expected

**Solutions:**
1. Verify Cloudflare proxy is enabled (orange cloud)
2. Check Cloudflare cache settings
3. Enable "Auto Minify" in Cloudflare
4. Review Vercel and Railway performance metrics

### Issue: Environment Variables Not Loading

**Symptom**: Application shows errors related to missing config

**Solutions:**
1. Verify all env vars are set in Railway dashboard
2. Redeploy Railway service after adding env vars
3. Check env var names match exactly (case-sensitive)
4. Review Railway deployment logs for errors

---

## Post-Migration Checklist

After successful migration, complete these tasks:

- [ ] Monitor application for 24-48 hours
- [ ] Check error rates in Vercel and Railway dashboards
- [ ] Verify all features work correctly
- [ ] Test from multiple geographic locations
- [ ] Update documentation with new URLs
- [ ] Update monitoring/alerting systems
- [ ] Plan Digital Ocean decommission (after 1 week of stability)
- [ ] Export any remaining data from Digital Ocean
- [ ] Cancel Digital Ocean droplet
- [ ] Update team on new deployment process

---

## Additional Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Railway Documentation](https://docs.railway.app/)
- [Cloudflare Origin Rules](https://developers.cloudflare.com/rules/origin-rules/)
- [Cloudflare DNS Documentation](https://developers.cloudflare.com/dns/)
- [Vite Base Path Configuration](https://vitejs.dev/config/shared-options.html#base)

---

## Support

For issues during migration:
- Check `docs/VERCEL_DOMAIN_CHECKLIST.md` for pre-flight checks
- Review Vercel deployment logs
- Check Railway service logs
- Contact Cloudflare support for DNS issues
- Open GitHub issue for application-specific problems
