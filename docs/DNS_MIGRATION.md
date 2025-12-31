# DNS Migration Guide: Pointing Root Domain to Vercel

## Overview

This guide provides step-by-step instructions for migrating your root domain (`axiombiolabs.org` and `www.axiombiolabs.org`) to point to your Vercel deployment. Currently, the app works at `app.axiombiolabs.org/grantflow` but the root domain still points to the old Digital Ocean hosting.

**Current State:**
- ✅ `app.axiombiolabs.org/grantflow` → Vercel (working)
- ⏳ `axiombiolabs.org/grantflow` → Old hosting (404 errors)
- ⏳ `www.axiombiolabs.org/grantflow` → Old hosting (404 errors)

**Target State:**
- ✅ `app.axiombiolabs.org/grantflow` → Vercel (working)
- ✅ `axiombiolabs.org/grantflow` → Vercel
- ✅ `www.axiombiolabs.org/grantflow` → Vercel

## Prerequisites

- Access to Vercel dashboard with deployment permissions
- Access to your DNS provider (GoDaddy or Cloudflare)
- Existing Vercel project serving `app.axiombiolabs.org`
- Railway backend running at `grantflow-production.up.railway.app`

---

## Part 1: Configure Custom Domain in Vercel

### Step 1: Access Vercel Project Settings

1. Log in to [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to your GrantFlow project
3. Click on **Settings** in the top navigation
4. Select **Domains** from the left sidebar

### Step 2: Add Root Domain

1. In the "Add Domain" field, enter: `axiombiolabs.org`
2. Click **Add**
3. Vercel will detect that you need to configure DNS records
4. Keep this page open - you'll need the configuration details in the next steps

### Step 3: Add WWW Subdomain

1. In the same "Add Domain" field, enter: `www.axiombiolabs.org`
2. Click **Add**
3. Vercel will show you the required DNS configuration

### Expected Vercel Configuration

Vercel will provide you with DNS records similar to:

**For `www.axiombiolabs.org`:**
```
Type: CNAME
Name: www
Value: cname.vercel-dns.com
```

**For `axiombiolabs.org` (bare domain):**
You have two options:
- **Option A (Recommended):** ALIAS or ANAME record pointing to `cname.vercel-dns.com`
- **Option B:** A record pointing to Vercel's IP address(es)

> **Note:** The exact values may vary. Always use the values shown in your Vercel dashboard.

---

## Part 2: DNS Provider Configuration

Choose your DNS provider below:

### Option A: GoDaddy DNS Configuration

#### For WWW Subdomain (CNAME)

1. Log in to [GoDaddy Domain Manager](https://dcc.godaddy.com/)
2. Find `axiombiolabs.org` and click **DNS**
3. Scroll to the DNS Records section
4. Click **Add New Record**
5. Configure:
   - **Type:** CNAME
   - **Name:** www
   - **Value:** `cname.vercel-dns.com`
   - **TTL:** 600 seconds (or 1 hour)
6. Click **Save**

#### For Bare Domain (Root)

**Method 1: Domain Forwarding (Simplest)**

1. In GoDaddy DNS settings, look for **Forwarding** section
2. Click **Add Forwarding** under "Domain"
3. Configure:
   - Forward to: `https://www.axiombiolabs.org`
   - Forward type: Permanent (301)
   - Settings: Forward only
4. Click **Save**

**Method 2: A Records (Alternative)**

If GoDaddy doesn't support ALIAS/ANAME records:

1. In Vercel dashboard, note the IP addresses provided for the bare domain
2. In GoDaddy DNS Records:
   - Click **Add New Record**
   - **Type:** A
   - **Name:** @ (represents root domain)
   - **Value:** [Vercel IP address from dashboard]
   - **TTL:** 600 seconds
3. If Vercel provides multiple IP addresses, add separate A records for each
4. Click **Save**

#### Verification

After saving:
- GoDaddy changes typically propagate in 5-15 minutes
- Check status in Vercel dashboard (Domains page will show checkmarks when verified)

---

### Option B: Cloudflare DNS Configuration

#### Step 1: Ensure Cloudflare is Active

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your `axiombiolabs.org` domain
3. Ensure status shows "Active"

#### Step 2: Add WWW CNAME Record

1. Navigate to **DNS** → **Records**
2. Click **Add record**
3. Configure:
   - **Type:** CNAME
   - **Name:** www
   - **Target:** `cname.vercel-dns.com`
   - **Proxy status:** DNS only (gray cloud) ⚠️ **Important**
   - **TTL:** Auto
4. Click **Save**

> **Critical:** Set proxy status to "DNS only" (gray cloud icon). Cloudflare's proxy conflicts with Vercel's edge network.

#### Step 3: Configure Bare Domain

**Method 1: CNAME Flattening (Recommended for Cloudflare)**

1. Click **Add record**
2. Configure:
   - **Type:** CNAME
   - **Name:** @ (or leave blank for root)
   - **Target:** `cname.vercel-dns.com`
   - **Proxy status:** DNS only (gray cloud)
   - **TTL:** Auto
3. Click **Save**

Cloudflare automatically "flattens" CNAME records at the root level.

**Method 2: A Records (Alternative)**

1. Click **Add record**
2. Configure:
   - **Type:** A
   - **Name:** @ (or leave blank for root)
   - **IPv4 address:** [Vercel IP from dashboard]
   - **Proxy status:** DNS only (gray cloud)
   - **TTL:** Auto
3. Repeat for any additional IP addresses Vercel provides
4. Click **Save**

#### Step 4: SSL/TLS Settings

1. Navigate to **SSL/TLS** → **Overview**
2. Set encryption mode to: **Full** or **Full (strict)**
3. Enable "Always Use HTTPS" under **Edge Certificates**

#### Verification

- Cloudflare DNS changes are nearly instant
- Check Vercel dashboard for verification status

---

## Part 3: Update Railway CORS Configuration

After DNS migration, update your Railway backend to accept requests from the new domains:

1. Log in to [Railway Dashboard](https://railway.app/)
2. Navigate to your GrantFlow backend service
3. Go to **Variables** tab
4. Update `CORS_ORIGIN` to include all domains:
   ```
   CORS_ORIGIN=https://app.axiombiolabs.org,https://www.axiombiolabs.org,https://axiombiolabs.org
   ```
5. Click **Save** (Railway will automatically redeploy)

---

## Part 4: DNS Propagation and Testing

### DNS Propagation Timeline

- **GoDaddy:** 5-60 minutes (typically 15 minutes)
- **Cloudflare:** Near-instant to 5 minutes
- **Full global propagation:** Up to 48 hours (usually 2-6 hours)

### Testing DNS Changes

#### Check DNS Propagation

```bash
# Check if DNS is updated globally
dig axiombiolabs.org
dig www.axiombiolabs.org

# Use online tools
# https://www.whatsmydns.net/
# Enter: axiombiolabs.org
```

#### Test Root Domain

```bash
# Test HTTP redirect
curl -I http://axiombiolabs.org/grantflow/login

# Test HTTPS
curl -I https://axiombiolabs.org/grantflow/login

# Should return 200 OK or 301/302 redirect
```

#### Test WWW Subdomain

```bash
# Test HTTPS
curl -I https://www.axiombiolabs.org/grantflow/login

# Should return 200 OK
```

#### Browser Testing

Open in multiple browsers:
1. `https://axiombiolabs.org/grantflow/login`
2. `https://www.axiombiolabs.org/grantflow/login`
3. `https://app.axiombiolabs.org/grantflow/login`

All should load the application correctly.

#### Clear Browser Cache

If you see old content:
```
Chrome: Ctrl+Shift+Delete (clear cache)
Firefox: Ctrl+Shift+Delete
Safari: Cmd+Opt+E
```

Or use incognito/private browsing mode.

---

## Part 5: Verify Backend Connectivity

### Test API Endpoints

```bash
# Health check
curl https://axiombiolabs.org/api/health
curl https://www.axiombiolabs.org/api/health

# Should return: {"status":"ok"}
```

### Test from Browser

1. Open browser DevTools (F12)
2. Go to **Network** tab
3. Navigate to `https://axiombiolabs.org/grantflow/login`
4. Monitor API calls - should see requests to `/api/*`
5. Check for CORS errors (should be none)

---

## Troubleshooting

### Issue: "Domain Not Verified" in Vercel

**Solution:**
1. Wait 5-10 minutes after DNS changes
2. In Vercel dashboard, click **Refresh** next to the domain
3. Use `dig` command to verify DNS propagation
4. Ensure proxy is disabled if using Cloudflare (gray cloud)

### Issue: SSL Certificate Error

**Solution:**
1. In Vercel dashboard, navigate to Domains
2. Check if SSL certificate is being issued (may take 5-10 minutes)
3. For Cloudflare: Ensure SSL/TLS mode is "Full" not "Flexible"
4. Wait up to 30 minutes for certificate provisioning

### Issue: 404 Errors on Root Domain

**Possible Causes:**
- DNS not fully propagated → Wait longer
- Wrong CNAME target → Verify `cname.vercel-dns.com`
- Cache issues → Clear browser cache
- Vercel configuration issue → Check `vercel.json` rewrites

**Solution:**
```bash
# Test with curl to bypass cache
curl -H "Host: axiombiolabs.org" https://[vercel-deployment-url]/grantflow/

# Check Vercel logs
# Go to Vercel dashboard → Project → Logs
```

### Issue: CORS Errors

**Solution:**
1. Verify Railway `CORS_ORIGIN` includes new domain
2. Check Railway logs for CORS rejections
3. Ensure protocol matches (https://)
4. Hard refresh browser (Ctrl+Shift+R)

### Issue: WWW Works but Root Domain Doesn't

**Solution:**
- Check if bare domain DNS record exists
- For GoDaddy: Ensure A record or forwarding is configured
- For Cloudflare: Ensure CNAME flattening is working
- Test with: `dig axiombiolabs.org` (should show IP or CNAME)

### Issue: Old Site Still Showing

**Causes:**
- Browser cache
- DNS cache on local machine
- CDN cache (if using Cloudflare proxy)

**Solution:**
```bash
# Clear local DNS cache

# Windows
ipconfig /flushdns

# macOS
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder

# Linux
sudo systemd-resolve --flush-caches
```

---

## Rollback Plan

If issues occur, you can revert DNS changes:

### Rollback to Digital Ocean

1. In DNS provider, change records back to previous values:
   - **www:** CNAME pointing to Digital Ocean
   - **Root:** A record pointing to Digital Ocean IP
2. Remove domains from Vercel project (Settings → Domains)
3. DNS propagation will revert in 5-60 minutes

### Keep Both Active (Temporary)

- Keep `app.axiombiolabs.org` on Vercel
- Keep `axiombiolabs.org` on old hosting
- Migrate users gradually

---

## DNS Record Examples

### Successful GoDaddy Configuration

```
Type    Name    Value                    TTL
----------------------------------------------
CNAME   www     cname.vercel-dns.com    600
A       @       76.76.21.21             600
```

### Successful Cloudflare Configuration

```
Type    Name    Target/IP               Proxy   TTL
-----------------------------------------------------
CNAME   www     cname.vercel-dns.com    DNS only Auto
CNAME   @       cname.vercel-dns.com    DNS only Auto
```
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

Use the [VERCEL_DOMAIN_CHECKLIST.md](VERCEL_DOMAIN_CHECKLIST.md) for a complete pre/post migration verification checklist.

- [ ] DNS records added in provider
- [ ] Domains verified in Vercel dashboard (green checkmarks)
- [ ] SSL certificates issued (check Vercel dashboard)
- [ ] Railway CORS updated with new domains
- [ ] Test `https://axiombiolabs.org/grantflow/login` loads
- [ ] Test `https://www.axiombiolabs.org/grantflow/login` loads
- [ ] Test API calls work from new domains
- [ ] Test authentication flow end-to-end
- [ ] Monitor logs for errors (Vercel + Railway)
- [ ] Update any documentation with new URLs
- [ ] Notify users of new domain (if applicable)
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

- [Vercel Custom Domains Documentation](https://vercel.com/docs/concepts/projects/domains)
- [GoDaddy DNS Management](https://www.godaddy.com/help/manage-dns-records-680)
- [Cloudflare DNS Documentation](https://developers.cloudflare.com/dns/)
- [DNS Propagation Checker](https://www.whatsmydns.net/)
- [Vercel Documentation](https://vercel.com/docs)
- [Railway Documentation](https://docs.railway.app/)
- [Cloudflare Origin Rules](https://developers.cloudflare.com/rules/origin-rules/)
- [Cloudflare DNS Documentation](https://developers.cloudflare.com/dns/)
- [Vite Base Path Configuration](https://vitejs.dev/config/shared-options.html#base)

---

## Support

If you encounter issues:
1. Check Vercel deployment logs: Dashboard → Project → Logs
2. Check Railway backend logs: Dashboard → Service → Logs
3. Review [DEPLOYMENT.md](DEPLOYMENT.md) for troubleshooting
4. GitHub Issues: https://github.com/buckeye7066/GrantFlow/issues
For issues during migration:
- Check `docs/VERCEL_DOMAIN_CHECKLIST.md` for pre-flight checks
- Review Vercel deployment logs
- Check Railway service logs
- Contact Cloudflare support for DNS issues
- Open GitHub issue for application-specific problems
