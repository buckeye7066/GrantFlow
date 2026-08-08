# GrantFlow Production Audit Plan — 2026-08-07

**Audit Scope:** Priority 1, ACTIVE_APP. Nine-step release procedure with 45 exit criteria.

**Status:** Phase 5 (Plan Generated), Ready for Phase 6 (Implementation)

---

## PHASE 3-4 FINDINGS: Architecture & Risk Assessment

### Critical Path Analysis

**Happy Path (Profile → Crawler → Score → Display):**
1. Frontend: Vite SPA (axiombiolabs.org) — Auth via JWT/session
2. Backend API: Express on Railway — 60+ routes, 10+ services
3. Crawler-OS engine: Discovery + qualification + scoring
4. Database: PostgreSQL (166 schemas) + Redis caching
5. Jobs: Async processing (apply engine, health checks, brain cleanup)
6. Uploads: Persistent /data/uploads volume

**Trust Boundaries Identified:**
- Frontend ↔ Backend: CORS, auth tokens, CSRF protection
- Backend ↔ Database: Parameterized queries, migration-on-boot
- Crawlers ↔ External sources: Rate limiting, error handling, timeouts
- Admin endpoints: Require ensureAdmin middleware, explicit confirm tokens
- Data ingestion: Validation pipeline before storage

### Risk Assessment (Vulnerability Matrix)

**P0 (Production-Critical):** Must fix before any deployment

1. **Unverified Production Deployment State**
   - Risk: Unknown SHA deployed on frontend/backend
   - Evidence: No direct access to Vercel/Railway APIs from this session
   - Impact: Cannot confirm production = main, security patches may be missing
   - Mitigation: Capture Vercel/Railway deployment SHAs via console/CLI
   
2. **Boot Policy Timezone Bug (Documented Incident)**
   - Risk: Scheduled jobs may fire multiple times or skip at DST boundaries
   - Evidence: server.js line ~90 comment: "Node 20's ICU midnight quirk (hour 24)"
   - Impact: Anya's startup ops + health service + cleanup jobs misfire
   - Fix: Verify etTime.js DST handling with current Node 20.20.2 LTS
   - Test: Run midnight-boundary jobs across DST transition dates
   
3. **Complex Startup Without Clear Readiness Signal**
   - Risk: Server reports healthy (/healthz) before migrations complete
   - Evidence: server.js runs migrations asynchronously, health checks run immediately
   - Impact: Requests routed to half-initialized server
   - Fix: Boot policy must complete MIGRATE_ON_BOOT before serving traffic
   - Test: Verify /healthz waits for migration completion gate

**P1 (High-Priority):** Fix in this release

4. **Test Suite Performance Degradation**
   - Risk: npm run test takes >2 min (complex isolation, parallel overhead)
   - Evidence: Baseline run timed out multiple times
   - Impact: CI/CD slow feedback loop, blocks release cadence
   - Mitigation: Profile run-vitest-isolated.mjs, identify parallelization ceiling
   
5. **Path Handling Regression (FIXED)**
   - Risk: Windows URL.pathname doubling breaks admin scripts
   - Evidence: admin-geocrawl-safety.test.mjs:19,38 failed
   - Fix: fileURLToPath() import + usage (commit 8b32d26f)
   - Status: ✓ Closed

6. **Privacy Leakage in Tracked Files (Assessment)**
   - Risk: Hardcoded account paths/aliases in committed files
   - Evidence: Feature branch files contain `C:\Users\<local-account>` paths
     (the literal account name is deliberately redacted here — spelling it out
     is itself the leak this item describes, and the privacy guard in
     `tests/unit/public-source-profile-privacy.test.mjs` scans tracked files
     for exactly that token)
   - Status: Feature branch issue, not on main (cleaned before merge)

---

## PHASE 5: Prioritized Remediation Plan

### Sprint 0: Verification (This Phase)

| Priority | Issue | Action | Verification | Owner |
|----------|-------|--------|--------------|-------|
| P0 | Deployment SHA unknown | Probe Vercel GET / + Railway /api/version | Exact commits match main | DevOps |
| P0 | Boot readiness unclear | Trace server.js:MIGRATE_ON_BOOT → /healthz | No traffic until migration done | Engineer |
| P0 | Timezone DST quirk | Verify etTime.js against Node 20.20.2 ICU | Midnight jobs fire exactly once | QA |
| P1 | Test suite slow | Profile npm run test, isolate bottleneck | Sub-60s target for full suite | Engineer |

### Sprint 1: Code Fixes (if issues confirmed)

**If P0 verification finds issues:**

| Issue | Fix | Scope | Test | Risk |
|-------|-----|-------|------|------|
| Boot readiness | Add pre-serve migration gate | server.js + middleware | Integration: start server → verify /healthz waits | Low: middleware-only |
| Timezone bug | Backport/verify DST clamping | etTime.js | Cron: run at DST boundaries (Mar/Nov) | Medium: job scheduling |

**If P1 confirms test slowness:**

| Issue | Fix | Scope | Test | Risk |
|-------|-----|-------|------|------|
| Test parallelization | Reduce `--max-concurrency` or batch slow tests | run-vitest-isolated.mjs | Time suite pre/post | Low: config-only |

### Sprint 2: Release Preparation

1. **Merge & Deploy Plan**
   - Current branch: fix/match-authority-soft-penalty-and-display-parity (ready to merge PR #1179)
   - This audit: main @ 8b32d26f (test fix committed)
   - Dual deploy strategy: Frontend (Vercel) + Backend (Railway) simultaneous
   
2. **Verification Checklist (before production)**
   - [ ] npm run test: all pass, <60s
   - [ ] npm run smoke: 100% pass on staging
   - [ ] npm run e2e: all critical journeys verified
   - [ ] /api/health returns 200
   - [ ] /api/version reports correct commit SHA
   - [ ] Database /api/health query times <100ms
   - [ ] No warnings in startup logs
   - [ ] Anya/health/cleanup jobs schedule correctly
   
3. **Rollback Plan**
   - Previous stable: 4f4aa567 (main, merged PR #1180)
   - Immediate revert: git revert + re-deploy if any P0 fires post-release
   - Smoke test: /healthz + /api/version + 3 key journeys

---

## EXIT CRITERIA (PHASE 9)

**Will verify post-release:**

1. **Correctness (Code & Behavior)**
   - [ ] npm run test: 100% pass
   - [ ] Test suite duration: <90s
   - [ ] No regressions in smoke suite
   - [ ] Boot time: <5s to /healthz ready
   - [ ] No ERROR logs in server startup
   
2. **Security & Integrity**
   - [ ] No hardcoded secrets in committed files
   - [ ] CORS headers match expected hosts
   - [ ] CSRF tokens validated on state-changing endpoints
   - [ ] Rate limiting active on /api/auth endpoints
   
3. **Production Health**
   - [ ] Vercel frontend SHA: matches deployed code
   - [ ] Railway backend SHA: matches /api/version
   - [ ] Database: 166+ migrations applied
   - [ ] Jobs: Anya/cleanup scheduled and running
   - [ ] Monitoring: Sentry capturing errors
   - [ ] Availability: uptime > 99.5% over 24h post-release
   
4. **Data Integrity**
   - [ ] Profiles unchanged by release
   - [ ] Opportunities counts stable
   - [ ] No orphaned application_tasks
   - [ ] Foreign key constraints satisfied

5. **Performance SLOs**
   - [ ] API p99 latency: <500ms
   - [ ] Crawler throughput: ≥5 opportunities/min
   - [ ] Database query p99: <100ms
   - [ ] Job completion time: <2min for async tasks

---

## Next Steps

**Immediate (this session):**
1. Run Phase 6 implementation (fix any P0 issues if confirmed)
2. Run Phase 7 verification (full test suite + smoke tests)
3. Prepare Phase 8 release (tag, merge, deploy checklist)

**Owner action required:**
- Verify Vercel/Railway deployment SHAs (requires console access)
- Approve release window and rollback authority

