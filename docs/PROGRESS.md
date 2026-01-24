# GrantFlow Hardening Progress

Branch: `fix/e2e-hardening-2026-01-23`

## Phase 0 — Boot + Baseline (make app run locally)
- [x] Create branch from default branch
- [x] Harden `.gitignore` (env/db/test artifacts) and push
- [x] Add `dev:all` + `test:all` scripts
- [x] Add deterministic DB seed (admin + 2 users + profiles + baseline directories; no OPPORTUNITY rows)
- [x] Generate `.env.example` + `backend/.env.example` from code references
- [x] Add `/docs/TESTING.md` (install/migrate/seed/start/tests)
- [x] Verify: `npm run db:setup`, `npm run dev:all`, `npm run test:all`
- [x] Commit + push: `chore: baseline boot, env examples, deterministic seed + docs`

## Phase 1 — Automation harness (E2E + API + crawler test mode)
- [ ] Playwright UI tests: login, profiles, admin, source directory, run crawler, pipeline, opportunities list, fail on console errors
- [ ] API tests: auth, profile CRUD, crawler jobs, opportunities list, admin settings (no real keys), `/health`
- [ ] Crawler test mode: adapters + fixtures
- [ ] Fix loop until consistently green
- [ ] Commit + push: `test: add e2e/api/crawler harness + fixes`

## Phase 2 — Profile dedupe (one profile per email) + access control
- [ ] Choose authoritative identity field
- [ ] DB constraint + migration to merge duplicates deterministically
- [ ] Enforce profile access (owner email or admin) across all profile-scoped endpoints
- [ ] Frontend cannot enumerate/switch to others
- [ ] Tests for merge + 403 + admin override + URL tampering
- [ ] Commit + push: `feat: profile dedupe + strict profile access control`

## Phase 3 — Anya tools stabilization
- [ ] Identify Anya endpoints/modules
- [ ] Define expected behavior via tests
- [ ] Add harness with mocks
- [ ] Fix until green
- [ ] Commit + push: `fix: stabilize Anya tools with test harness`

## Phase 4 — Source API stubs (integration-ready, no key scraping)
- [ ] Enumerate Admin source registry
- [ ] Client module per source (base URL, wrapper, backoff)
- [ ] Env placeholders + mocked tests
- [ ] UI shows missing vs configured (never prints secrets)
- [ ] Commit + push: `feat: source API client stubs + key validation + docs`

## Phase 5 — Per-profile crawler runs + pipeline persistence
- [ ] Ensure opportunity persistence is profile-scoped (or link table) + idempotent reruns
- [ ] Integration tests with two profiles running all crawlers in test mode
- [ ] Commit + push: `feat: per-profile crawler runs + pipeline persistence + idempotency`

## Phase 6 — Geo crawler full run + state indexing
- [ ] Geo rules tests
- [ ] Full runner (fixtures in test mode; throttles + retries in prod)
- [ ] Persist state + UI filter
- [ ] Summary endpoint/view
- [ ] Commit + push: `feat: geo crawler full run + state-indexed opportunities`

## Finalization — PR
- [ ] Full test run green on branch
- [ ] Open PR with required title/body/checklist

