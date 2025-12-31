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

---

## Additional Resources

- [Vercel Custom Domains Documentation](https://vercel.com/docs/concepts/projects/domains)
- [GoDaddy DNS Management](https://www.godaddy.com/help/manage-dns-records-680)
- [Cloudflare DNS Documentation](https://developers.cloudflare.com/dns/)
- [DNS Propagation Checker](https://www.whatsmydns.net/)

---

## Support

If you encounter issues:
1. Check Vercel deployment logs: Dashboard → Project → Logs
2. Check Railway backend logs: Dashboard → Service → Logs
3. Review [DEPLOYMENT.md](DEPLOYMENT.md) for troubleshooting
4. GitHub Issues: https://github.com/buckeye7066/GrantFlow/issues
