# Vercel Domain Migration Checklist

This checklist guides you through the complete DNS migration process from old hosting (Digital Ocean) to Vercel + Railway. Follow each step in order to ensure a smooth transition.

---

## Pre-Migration Verification

### 1. Verify Current Deployment Status

**Vercel (Frontend):**
- [ ] Confirm app works at `https://app.axiombiolabs.org/grantflow/login`
- [ ] Test login functionality
- [ ] Test navigation between pages
- [ ] Check browser console for errors (should be minimal)
- [ ] Verify assets load correctly (CSS, JS, images)

**Railway (Backend):**
- [ ] Backend health check passes: `curl https://grantflow-production.up.railway.app/api/health`
- [ ] API endpoints respond correctly
- [ ] Check Railway logs for any errors
- [ ] Verify database connections (if applicable)

**Current Root Domain (Before Migration):**
- [ ] Document current behavior of `axiombiolabs.org/grantflow`
- [ ] Take screenshots of current site (for comparison)
- [ ] Note any error messages or issues

### 2. Access Verification

- [ ] Access to Vercel dashboard (account: _____________)
- [ ] Admin permissions on Vercel project
- [ ] Access to DNS provider (GoDaddy or Cloudflare)
- [ ] Admin permissions on DNS account
- [ ] Access to Railway dashboard
- [ ] Admin permissions on Railway backend service

### 3. Backup Critical Information

**Document Current DNS Settings:**
```
Date: _______________
Provider: _______________ (GoDaddy / Cloudflare)

Current DNS Records:
www.axiombiolabs.org → _______________________
axiombiolabs.org → _______________________
app.axiombiolabs.org → _______________________
```

**Document Current Railway CORS:**
```
Current CORS_ORIGIN value: _________________________________
```

**Save Vercel Project Details:**
```
Vercel Project Name: _______________________
Deployment URL: _______________________
Current Custom Domains: _______________________
```

### 4. Review Configuration Files

- [ ] Check `vercel.json` has correct rewrites:
  ```json
  {
    "rewrites": [
      {
        "source": "/grantflow/api/:path*",
        "destination": "https://grantflow-production.up.railway.app/api/:path*"
      },
      {
        "source": "/grantflow/:path*",
        "destination": "/index.html"
      }
    ]
  }
  ```
- [ ] Verify `vite.config.ts` has `base: '/grantflow/'`
- [ ] Confirm build output is in `dist/` directory

### 5. Communication Plan

- [ ] Notify team of planned migration
- [ ] Schedule migration during low-traffic period
- [ ] Prepare rollback communication
- [ ] Set up monitoring alerts (optional)

---

## Migration Execution

### Phase 1: Vercel Domain Configuration

- [ ] Log in to Vercel dashboard
- [ ] Navigate to project → Settings → Domains
- [ ] Add domain: `axiombiolabs.org`
- [ ] Add domain: `www.axiombiolabs.org`
- [ ] Note the DNS configuration Vercel provides:
  ```
  www CNAME: _______________________
  Root domain: _______________________
  ```

### Phase 2: DNS Provider Configuration

**Choose your provider:**

#### Option A: GoDaddy Configuration

- [ ] Log in to GoDaddy DNS management
- [ ] Add CNAME record:
  - Type: CNAME
  - Name: www
  - Value: `cname.vercel-dns.com`
  - TTL: 600 seconds
- [ ] Configure root domain (choose one):
  - [ ] **Method 1:** Set up domain forwarding to `https://www.axiombiolabs.org`
  - [ ] **Method 2:** Add A record(s) with Vercel IP address(es)
- [ ] Save all changes
- [ ] Record time of DNS change: _______________

#### Option B: Cloudflare Configuration

- [ ] Log in to Cloudflare dashboard
- [ ] Navigate to DNS → Records
- [ ] Add www CNAME record:
  - Type: CNAME
  - Name: www
  - Target: `cname.vercel-dns.com`
  - Proxy status: DNS only (gray cloud) ⚠️
  - TTL: Auto
- [ ] Add root CNAME record:
  - Type: CNAME
  - Name: @ (or blank)
  - Target: `cname.vercel-dns.com`
  - Proxy status: DNS only (gray cloud) ⚠️
  - TTL: Auto
- [ ] Verify SSL/TLS settings:
  - [ ] Mode: Full or Full (strict)
  - [ ] "Always Use HTTPS" enabled
- [ ] Save all changes
- [ ] Record time of DNS change: _______________

### Phase 3: Railway CORS Update

- [ ] Log in to Railway dashboard
- [ ] Navigate to GrantFlow backend service
- [ ] Go to Variables tab
- [ ] Update `CORS_ORIGIN` variable:
  ```
  CORS_ORIGIN=https://app.axiombiolabs.org,https://www.axiombiolabs.org,https://axiombiolabs.org
  ```
- [ ] Save changes
- [ ] Wait for automatic redeploy to complete
- [ ] Verify backend health: `curl https://grantflow-production.up.railway.app/api/health`

### Phase 4: DNS Propagation Wait

**Initial Wait (5-15 minutes):**
- [ ] Wait 5 minutes after DNS changes
- [ ] Check DNS propagation: `dig axiombiolabs.org`
- [ ] Check DNS propagation: `dig www.axiombiolabs.org`
- [ ] Check status at: https://www.whatsmydns.net/

**Vercel Verification (10-20 minutes):**
- [ ] Check Vercel dashboard → Domains
- [ ] Wait for green checkmarks next to both domains
- [ ] If not verified after 15 minutes, click "Refresh"
- [ ] Check for SSL certificate issuance

**Full Propagation (up to 48 hours):**
- [ ] Note: Full global propagation can take up to 48 hours
- [ ] Most changes visible within 2-6 hours

---

## Post-Migration Verification

### 1. Basic Connectivity Tests

**Root Domain Tests:**
```bash
# HTTP redirect test
curl -I http://axiombiolabs.org/grantflow/login

# HTTPS test
curl -I https://axiombiolabs.org/grantflow/login

# Expected: 200 OK or redirect to HTTPS
```

- [ ] HTTP redirects to HTTPS (301/302)
- [ ] HTTPS loads without certificate errors
- [ ] Status code is 200 OK

**WWW Subdomain Tests:**
```bash
# HTTPS test
curl -I https://www.axiombiolabs.org/grantflow/login

# Expected: 200 OK
```

- [ ] HTTPS loads without certificate errors
- [ ] Status code is 200 OK

**App Subdomain (Should Still Work):**
```bash
# HTTPS test
curl -I https://app.axiombiolabs.org/grantflow/login

# Expected: 200 OK
```

- [ ] Still works as before
- [ ] No disruption to existing users

### 2. Frontend Application Tests

**Test on `https://axiombiolabs.org/grantflow/`:**
- [ ] Landing page loads correctly
- [ ] All assets load (CSS, JavaScript, images)
- [ ] No 404 errors in browser console
- [ ] Navigation works between routes
- [ ] React app hydrates properly
- [ ] No console errors or warnings (check browser DevTools)

**Test on `https://www.axiombiolabs.org/grantflow/`:**
- [ ] Landing page loads correctly
- [ ] All assets load (CSS, JavaScript, images)
- [ ] No 404 errors in browser console
- [ ] Navigation works between routes
- [ ] React app hydrates properly
- [ ] No console errors or warnings

**Test on `https://app.axiombiolabs.org/grantflow/`:**
- [ ] Still works as before (no regression)
- [ ] All functionality intact

### 3. Backend API Tests

**Health Endpoint:**
```bash
# Test from root domain
curl https://axiombiolabs.org/api/health

# Test from www
curl https://www.axiombiolabs.org/api/health

# Expected: {"status":"ok","timestamp":"..."}
```

- [ ] API health check passes from `axiombiolabs.org`
- [ ] API health check passes from `www.axiombiolabs.org`
- [ ] Response format is correct

**API Calls from Browser:**
- [ ] Open browser DevTools (F12) → Network tab
- [ ] Navigate to `https://axiombiolabs.org/grantflow/login`
- [ ] Observe API calls in Network tab
- [ ] Verify API requests are successful (200 status)
- [ ] Check for CORS errors (should be none)
- [ ] Verify requests go to correct backend

### 4. Authentication Flow Test

**Full User Journey:**
- [ ] Navigate to `https://axiombiolabs.org/grantflow/login`
- [ ] Enter credentials and attempt login
- [ ] Verify successful authentication
- [ ] Check that session persists
- [ ] Test protected routes/pages
- [ ] Test logout functionality
- [ ] Verify no authentication errors in logs

**Test All Domains:**
- [ ] Authentication works on `axiombiolabs.org`
- [ ] Authentication works on `www.axiombiolabs.org`
- [ ] Authentication works on `app.axiombiolabs.org`

### 5. Cross-Browser Testing

**Desktop Browsers:**
- [ ] Chrome/Edge (latest)
  - [ ] Login works
  - [ ] No console errors
  - [ ] All features functional
- [ ] Firefox (latest)
  - [ ] Login works
  - [ ] No console errors
  - [ ] All features functional
- [ ] Safari (latest)
  - [ ] Login works
  - [ ] No console errors
  - [ ] All features functional

**Mobile Browsers (if applicable):**
- [ ] Chrome Mobile
- [ ] Safari iOS
- [ ] Samsung Internet

**Incognito/Private Mode:**
- [ ] Test in incognito to verify no cache issues
- [ ] Verify fresh load works correctly

### 6. Performance Verification

- [ ] Test page load time on root domain (compare to app subdomain)
- [ ] Verify assets are served from CDN (Vercel Edge Network)
- [ ] Check Time to First Byte (TTFB) is acceptable
- [ ] Run Lighthouse audit (optional but recommended)

### 7. SSL/TLS Verification

**Certificate Check:**
```bash
# Check SSL certificate
openssl s_client -connect axiombiolabs.org:443 -servername axiombiolabs.org

# Should show valid Vercel certificate
```

- [ ] Valid SSL certificate from Vercel
- [ ] Certificate includes both domains (SAN)
- [ ] No browser security warnings
- [ ] Mixed content warnings absent

### 8. Monitoring and Logs

**Vercel Logs:**
- [ ] Check Vercel dashboard → Project → Logs
- [ ] Look for any errors in last 30 minutes
- [ ] Verify successful requests from new domains
- [ ] No unusual error patterns

**Railway Logs:**
- [ ] Check Railway dashboard → Service → Logs
- [ ] Verify CORS acceptance of new domains
- [ ] No authentication failures
- [ ] API requests processing correctly

### 9. DNS Propagation Check

**Global DNS Verification:**
- [ ] Use https://www.whatsmydns.net/
- [ ] Enter `axiombiolabs.org`
- [ ] Check multiple global locations
- [ ] Verify majority show correct IP/CNAME
- [ ] Repeat for `www.axiombiolabs.org`

**Local DNS Cache:**
```bash
# Flush local DNS (if needed)

# Windows
ipconfig /flushdns

# macOS
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder

# Linux
sudo systemd-resolve --flush-caches
```

- [ ] DNS cache cleared if old IPs still appear
- [ ] Retest after clearing cache

---

## Post-Migration Actions

### Documentation Updates

- [ ] Update internal documentation with new primary URL
- [ ] Update README.md with Vercel as primary deployment
- [ ] Update any API documentation
- [ ] Update onboarding guides (if applicable)

### User Communication

- [ ] Notify users of new URL (if applicable)
- [ ] Update bookmarks/favorites instructions
- [ ] Send announcement email (if applicable)
- [ ] Update social media links

### Cleanup Old Deployment (Wait 1-2 weeks)

- [ ] Monitor traffic to ensure all users migrated
- [ ] Verify no critical errors in logs
- [ ] Consider keeping old hosting for 2-4 weeks as backup
- [ ] Plan Digital Ocean server decommission
- [ ] Update any external links pointing to old domain

---

## Rollback Procedure (If Needed)

If critical issues arise:

### Immediate Rollback

1. **DNS Revert:**
   - [ ] Log in to DNS provider
   - [ ] Change records back to previous values:
     ```
     www.axiombiolabs.org → [old value]
     axiombiolabs.org → [old value]
     ```
   - [ ] Save changes
   - [ ] Wait 5-15 minutes for propagation

2. **Remove from Vercel:**
   - [ ] Go to Vercel → Settings → Domains
   - [ ] Remove `axiombiolabs.org`
   - [ ] Remove `www.axiombiolabs.org`

3. **Railway CORS:**
   - [ ] Revert `CORS_ORIGIN` to previous value
   - [ ] Save and redeploy

4. **Verify Rollback:**
   - [ ] Test old domain still works
   - [ ] Check `app.axiombiolabs.org` still works
   - [ ] Monitor logs for stability

### Document Rollback

- [ ] Record reason for rollback
- [ ] Document issues encountered
- [ ] Create action plan to address issues
- [ ] Schedule retry date

---

## Troubleshooting Quick Reference

| Issue | Solution |
|-------|----------|
| Domain not verified in Vercel | Wait 10 min, click Refresh, check DNS propagation |
| SSL certificate error | Wait 30 min for provisioning, check Cloudflare SSL mode |
| 404 errors | Clear cache, verify DNS propagation, check `vercel.json` |
| CORS errors | Update Railway `CORS_ORIGIN`, hard refresh browser |
| Old site showing | Clear browser cache, flush DNS cache |
| WWW works but root doesn't | Check bare domain DNS record, verify A/CNAME |
| API calls failing | Check Railway logs, verify CORS, test health endpoint |

For detailed troubleshooting, see [DNS_MIGRATION.md](DNS_MIGRATION.md).

---

## Sign-Off

**Migration Completed By:** _______________________

**Date:** _______________________

**Time:** _______________________

**All Tests Passed:** ☐ Yes ☐ No (document issues below)

**Issues Encountered:**
```
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
```

**Sign-off Approvals:**
- [ ] Technical lead verified
- [ ] Stakeholder notified
- [ ] Documentation updated

---

## Success Criteria Summary

✅ Migration is successful when:
- [ ] `https://axiombiolabs.org/grantflow/login` loads the application
- [ ] `https://www.axiombiolabs.org/grantflow/login` loads the application
- [ ] `https://app.axiombiolabs.org/grantflow/login` still works
- [ ] API calls to Railway backend work from all domains
- [ ] Authentication flow works end-to-end
- [ ] No CORS errors in browser console
- [ ] No SSL certificate warnings
- [ ] All DNS records verified in Vercel dashboard
- [ ] Logs show no critical errors
- [ ] Cross-browser testing passes

**Congratulations! Your DNS migration is complete! 🎉**
