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
