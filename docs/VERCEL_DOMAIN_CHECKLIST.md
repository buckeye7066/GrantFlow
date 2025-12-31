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
# Vercel Domain Configuration Checklist

This checklist ensures a smooth DNS migration from Digital Ocean to Vercel + Railway architecture for GrantFlow.

## Pre-Migration Checklist

### Documentation Review
- [ ] Read `docs/DNS_MIGRATION.md` in full
- [ ] Understand the new architecture (Vercel + Railway + Cloudflare)
- [ ] Review rollback procedures
- [ ] Identify team members for migration day

### Account Access Verification
- [ ] GoDaddy account access confirmed
- [ ] Cloudflare account access confirmed (with domain added)
- [ ] Vercel account created and repository access granted
- [ ] Railway account created and repository access granted
- [ ] GitHub repository access confirmed

### Environment Preparation
- [ ] Document all current environment variables
- [ ] Generate new `ANYA_ADMIN_TOKEN` (using `openssl rand -hex 32`)
- [ ] Verify `OPENAI_API_KEY` is available
- [ ] Document current `CORS_ORIGIN` values
- [ ] Back up existing `.env` files

### Current System Backup
- [ ] Export current database: `/opt/grantflow/backend/data/grantflow.db`
- [ ] Backup current configuration files
- [ ] Export Digital Ocean droplet configuration
- [ ] Document current Nginx configuration
- [ ] Backup user data and uploaded documents
- [ ] Take snapshot of Digital Ocean droplet (optional)

### Repository Preparation
- [ ] Latest code pushed to `main` branch
- [ ] All tests passing locally
- [ ] Build succeeds: `npm run build`
- [ ] Lint passes: `npm run lint`
- [ ] Backend starts successfully: `npm run backend`
- [ ] Frontend dev server works: `npm run dev`

### DNS Record Documentation
- [ ] Document current Cloudflare DNS records
- [ ] Note current TTL values (for rollback)
- [ ] Document current nameservers
- [ ] Screenshot current DNS configuration

---

## Vercel Configuration Checklist

### Initial Setup
- [ ] GitHub repository imported to Vercel
- [ ] Framework preset set to **Vite**
- [ ] Build command: `npm run build`
- [ ] Output directory: `dist`
- [ ] Install command: `npm install`
- [ ] Node.js version: **18.x**

### Environment Variables
- [ ] `NODE_ENV=production`
- [ ] `VITE_API_BASE_URL=https://www.axiombiolabs.org/api`
- [ ] Any other frontend-specific variables added

### Build Configuration
- [ ] `vite.config.ts` has `base: '/grantflow/'`
- [ ] Verify build output includes all assets
- [ ] Check build logs for warnings/errors
- [ ] Test build locally before deploying

### Deployment Verification
- [ ] Initial deployment successful
- [ ] Deployment URL accessible (e.g., `your-app.vercel.app`)
- [ ] Homepage loads correctly
- [ ] All routes accessible via Vercel domain
- [ ] Static assets loading (CSS, JS, images)
- [ ] No console errors in browser DevTools

---

## Railway Configuration Checklist

### Service Setup
- [ ] GitHub repository connected to Railway
- [ ] Service created with Node.js detected
- [ ] Start command set to: `npm run start`
- [ ] Root directory: `./` (default)

### Environment Variables
- [ ] `NODE_ENV=production`
- [ ] `PORT=4000` (or Railway's auto-assigned PORT)
- [ ] `ANYA_ADMIN_TOKEN=<secure-random-token>`
- [ ] `CORS_ORIGIN=https://www.axiombiolabs.org,https://app.axiombiolabs.org`
- [ ] `OPENAI_API_KEY=<your-api-key>`
- [ ] `DATABASE_PATH=./backend/data/grantflow.db`
- [ ] Any other backend-specific variables

### Backend Verification
- [ ] Railway deployment successful
- [ ] Railway domain noted (e.g., `your-app.up.railway.app`)
- [ ] Health endpoint accessible: `/api/health` returns 200 OK
- [ ] Opportunities endpoint works: `/api/opportunities` returns data
- [ ] ANYA status endpoint works: `/api/anya/status`
- [ ] Check Railway logs for errors
- [ ] Verify database initialized correctly

### Railway Port Configuration
- [ ] Backend listens on `process.env.PORT || 4000`
- [ ] Railway automatically assigns PORT variable
- [ ] Verify no hardcoded ports in backend code

---

## Cloudflare DNS Checklist

### Nameserver Configuration
- [ ] GoDaddy nameservers point to Cloudflare
- [ ] Cloudflare nameservers active (usually within 24 hours)
- [ ] DNS propagation complete (check with `nslookup` or `dig`)

### DNS Records
- [ ] Existing records documented
- [ ] Test CNAME records added:
  - [ ] `vercel-test.axiombiolabs.org` → `<vercel-domain>`
  - [ ] `railway-test.axiombiolabs.org` → `<railway-domain>`
- [ ] Test domains accessible before modifying production

### SSL/TLS Settings
- [ ] Encryption mode: **Full (strict)**
- [ ] "Always Use HTTPS" enabled
- [ ] "Automatic HTTPS Rewrites" enabled
- [ ] Edge certificates active and valid

### Cloudflare Origin Rules
- [ ] **Rule 1 - API to Railway**:
  - [ ] Rule name: "Route API to Railway"
  - [ ] Condition: URI Path starts with `/api/`
  - [ ] Origin override: Railway domain
  - [ ] Priority: 1
  - [ ] Status: Enabled
- [ ] **Rule 2 - Frontend to Vercel**:
  - [ ] Rule name: "Route GrantFlow to Vercel"
  - [ ] Condition: URI Path starts with `/grantflow/`
  - [ ] Origin override: Vercel domain
  - [ ] Priority: 2
  - [ ] Status: Enabled

### Performance Settings
- [ ] Auto Minify enabled (HTML, CSS, JS)
- [ ] Brotli compression enabled
- [ ] HTTP/2 enabled
- [ ] HTTP/3 (QUIC) enabled (optional)
- [ ] WebSockets enabled

### Security Settings
- [ ] Security Level: Medium
- [ ] Browser Integrity Check: Enabled
- [ ] Challenge Passage: 30 minutes
- [ ] Privacy Pass Support: Enabled

---

## Testing Checklist

### API Endpoint Testing
Test from command line:
```bash
# Health check
curl https://www.axiombiolabs.org/api/health

# Opportunities
curl https://www.axiombiolabs.org/api/opportunities

# ANYA status
curl https://www.axiombiolabs.org/api/anya/status
```

- [ ] `/api/health` returns 200 with JSON response
- [ ] `/api/opportunities` returns grant data
- [ ] `/api/anya/status` returns ANYA status
- [ ] Response time < 2 seconds
- [ ] No 502/503 errors

### Frontend Route Testing
Test in browser:
- [ ] `https://www.axiombiolabs.org/grantflow/` - Homepage loads
- [ ] `https://www.axiombiolabs.org/grantflow/about` - About page loads
- [ ] `https://www.axiombiolabs.org/grantflow/pricing` - Pricing page loads
- [ ] `https://www.axiombiolabs.org/grantflow/dashboard` - Dashboard loads
- [ ] All static assets load (CSS, JS, images)
- [ ] SPA routing works (no 404 on refresh)

### Browser DevTools Check
- [ ] No JavaScript errors in Console
- [ ] No 404 errors in Network tab
- [ ] API requests succeed (status 200)
- [ ] CORS headers present in responses
- [ ] HTTPS padlock shows secure connection
- [ ] No mixed content warnings

### Cross-Browser Testing
- [ ] Chrome/Edge (Chromium) - Latest version
- [ ] Firefox - Latest version
- [ ] Safari - Latest version (Mac/iOS)
- [ ] Mobile Chrome (Android)
- [ ] Mobile Safari (iOS)

### Functional Testing
- [ ] User authentication works
- [ ] Login/logout flow functional
- [ ] Grant search returns results
- [ ] Document upload succeeds
- [ ] ANYA chat interface responds
- [ ] Profile page loads user data
- [ ] Dashboard shows correct information

### Performance Testing
- [ ] Homepage load time < 3 seconds
- [ ] Time to Interactive (TTI) < 5 seconds
- [ ] First Contentful Paint (FCP) < 2 seconds
- [ ] Largest Contentful Paint (LCP) < 2.5 seconds
- [ ] Run Lighthouse audit (score > 90)
- [ ] Check WebPageTest results

### Geographic Testing
Test from multiple locations:
- [ ] US East Coast
- [ ] US West Coast
- [ ] Europe (if applicable)
- [ ] Asia (if applicable)

---

## Post-Migration Checklist

### Immediate (Day 1)
- [ ] All tests from Testing Checklist pass
- [ ] Monitor Vercel Analytics dashboard
- [ ] Monitor Railway Metrics dashboard
- [ ] Check Cloudflare Analytics
- [ ] Review error logs (Vercel, Railway, Cloudflare)
- [ ] Verify no spike in error rates
- [ ] Test from external network (not office/home)
- [ ] User acceptance testing with team

### Short-term (Week 1)
- [ ] Daily monitoring of application health
- [ ] Review Vercel and Railway usage/costs
- [ ] Check for any user-reported issues
- [ ] Monitor performance metrics
- [ ] Verify backups are working
- [ ] Update internal documentation
- [ ] Train team on new deployment process

### Long-term (Week 2+)
- [ ] Review analytics data (traffic, performance)
- [ ] Compare costs: New vs. Digital Ocean
- [ ] Optimize Cloudflare cache rules if needed
- [ ] Fine-tune Vercel build settings
- [ ] Consider Railway scaling if needed
- [ ] Plan Digital Ocean decommission
- [ ] Archive Digital Ocean configuration docs

### Digital Ocean Cleanup
- [ ] Verify new architecture stable for 7+ days
- [ ] Export any remaining data from Digital Ocean
- [ ] Download final backup of database and files
- [ ] Document lessons learned
- [ ] Cancel Digital Ocean droplet subscription
- [ ] Remove Digital Ocean DNS records (if any remain)
- [ ] Update monitoring/alerting to remove Digital Ocean checks

---

## Rollback Checklist

If issues occur and you need to rollback:

### Quick Rollback (< 5 minutes)
- [ ] Disable Cloudflare Origin Rules
- [ ] Verify traffic routes back to Digital Ocean
- [ ] Test health endpoints on Digital Ocean
- [ ] Notify team of rollback
- [ ] Document what triggered rollback

### Full Rollback (< 30 minutes)
- [ ] Delete Cloudflare Origin Rules
- [ ] Verify DNS records point to Digital Ocean
- [ ] Restart Digital Ocean services if needed:
  ```bash
  sudo systemctl restart grantflow-backend
  sudo systemctl restart nginx
  ```
- [ ] Clear Cloudflare cache
- [ ] Verify all functionality on Digital Ocean
- [ ] Update status page/communications
- [ ] Schedule postmortem meeting

### Post-Rollback Actions
- [ ] Review Vercel logs for errors
- [ ] Review Railway logs for errors
- [ ] Document root cause of failure
- [ ] Create GitHub issue with findings
- [ ] Fix identified issues in dev/staging
- [ ] Update migration plan based on lessons learned
- [ ] Schedule retry migration date

---

## Monitoring Setup

### Vercel Monitoring
- [ ] Enable Vercel Analytics
- [ ] Set up deployment notifications (email/Slack)
- [ ] Configure error tracking
- [ ] Review usage dashboard regularly

### Railway Monitoring
- [ ] Set up Railway notifications
- [ ] Configure log aggregation
- [ ] Monitor memory/CPU usage
- [ ] Set up usage alerts (if approaching limits)

### Cloudflare Monitoring
- [ ] Enable Email notifications for downtime
- [ ] Review Analytics dashboard daily (first week)
- [ ] Monitor cache hit rate
- [ ] Check firewall events for anomalies

### External Monitoring (Optional)
- [ ] Set up UptimeRobot or similar (free tier)
- [ ] Configure status page (e.g., status.io)
- [ ] Set up Sentry or similar for error tracking
- [ ] Configure Slack/email alerts for downtime

---

## Emergency Contacts

Document contact information:

### Service Providers
- **GoDaddy Support**: _______________
- **Cloudflare Support**: _______________
- **Vercel Support**: _______________
- **Railway Support**: _______________

### Internal Team
- **Primary Engineer**: _______________
- **Backup Engineer**: _______________
- **Product Owner**: _______________
- **DevOps Lead**: _______________

---

## Sign-Off

### Pre-Migration Sign-Off
- [ ] **Technical Lead**: ___________ Date: _____
- [ ] **DevOps Lead**: ___________ Date: _____
- [ ] **Product Owner**: ___________ Date: _____

### Post-Migration Sign-Off
- [ ] **Technical Lead**: ___________ Date: _____
- [ ] **DevOps Lead**: ___________ Date: _____
- [ ] **Product Owner**: ___________ Date: _____

### Migration Success Criteria
- [ ] All functionality working as expected
- [ ] No increase in error rates
- [ ] Performance equal or better than before
- [ ] All tests passing
- [ ] Team trained on new architecture
- [ ] Documentation updated

---

## Notes

Use this section to document any issues, decisions, or observations during migration:

```
Date: ___________
Notes:




```

---

## Additional Resources

- [DNS_MIGRATION.md](./DNS_MIGRATION.md) - Full migration guide
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Updated deployment documentation
- [Vercel Documentation](https://vercel.com/docs)
- [Railway Documentation](https://docs.railway.app/)
- [Cloudflare Origin Rules](https://developers.cloudflare.com/rules/origin-rules/)
