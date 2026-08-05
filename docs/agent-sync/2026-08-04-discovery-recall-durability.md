# Agent sync — 2026-08-04 — discovery recall durability

## Owner directives (this session)
- Implement Instrumentl-class discovery improvements from the GrantFlow-vs-leaders assessment.
- Push and merge to `buckeye7066/GrantFlow` `main`.

## Shipped (this branch / PR)
1. **Durable ACCEPT retention** — `crawlerOsPersistence.persistRun` snapshots awardable (non-pointer) `crawler-os` / `crawler-os-xmatch` ACCEPTs before reconcile and restores them after (`acceptsPreserved`). Explicit REJECT still clears. Locators stay on the resource path.
2. **Catalog rescore writes DEFAULT ON** — `isCatalogRescoreWriteEnabled` inverted; `ENFORCE_CATALOG_RESCORE=0` for count-only. Junk gate already in `passesFundabilityGate`.
3. **Structured `assistance_needs`** — `financial_information` field (`scored: false`) in `profileSchema` + `sectionMetadata`; wired into `DECLARED_NEED_FIELDS` (distinct from dollar-range `funding_needs`).
4. **Awardable-first UI** — already present in `ProfileFundingSourcesCard` (Best matches → Worth reviewing → Directories); no change required.
5. **CORE topical queries** — already CORE in `webQueries.js` (top 2 derived interests); no change required.

## Guard tests
- `backend/tests/crawlerOsResourceReconciliation.test.js` — ACCEPT durability + REJECT clears
- `backend/tests/catalogRescoreSweep.test.js` — default ON / count-only
- `backend/tests/crisisNeedRecall.test.js` — `assistance_needs` declaration

## Do not mix
- `docs/recovery/`, `scripts/recovery-file-audit.mjs` — unrelated recovery audit WIP
- Owner-authority Claude session hardwire lives in `~/.claude/` + gitignored `CLAUDE.local.md`

## Traps
- Do NOT let directories ACCEPT or drop locators from recommendations (locator rule).
- Do NOT loosen fundability gates when enabling catalog rescore writes.
- Rolling snapshot DELETE in `persistRunCore` is intentional; durability is the facade restore, not keeping rows through DELETE.
