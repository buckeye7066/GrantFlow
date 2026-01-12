# PRODUCTION READINESS CHECKLIST

## Phase 1: Full Repo Audit
- [ ] Linting (Frontend & Backend)
- [ ] Typechecking
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Security scan (secrets, dependencies)

## Phase 2: Geo Crawl Replacement
- [ ] Remove "Comprehensive National" wording
- [ ] Canonicalize Geo Crawl (type='comprehensive', parameters.mode='geo')
- [ ] Remove login-triggered comprehensive jobs

## Phase 3: Admin & RBAC
- [ ] Fix frontend admin gating (Boolean/role-based)
- [ ] Server-side RBAC enforced
- [ ] Admin dashboard: System Health, Data Integrity, Profile Repair, Geo Control, Audit Log

## Phase 4: Profiles
- [ ] Canonical sections/keys enforcement (profileSections.js)
- [ ] Completeness API & Repair endpoints
- [ ] Import/Export profile JSON

## Phase 5: Crawlers & Matching
- [ ] Worker reliability (retries, backoff, circuit breaker)
- [ ] Crawler health endpoints
- [ ] Parser normalization & Deduplication
- [ ] Match scoring explainability

## Phase 6: Anya Intelligence
- [ ] Persistent state
- [ ] Profile Gap Analyst tool
- [ ] Next Best Action tool
- [ ] Safe fallback (no LLM)

## Phase 7: Product Improvements
- [ ] Multi-tenant scoping
- [ ] Rate limiting
- [ ] Audit logging
- [ ] Feature flags
- [ ] Accessibility (a11y)

## Phase 8: QA & Release
- [ ] E2E tests (Playwright)
- [ ] Deploy verification (Vercel/Railway)
- [ ] Release runbook
