# Release Gates (GrantFlow)

This document is the **ship / no-ship checklist** for GrantFlow.

Principles:
- **Zero-results is a failure state** (when opportunities exist).
- **Counts shown in the UI must map 1:1 to backend response fields.**
- **No hidden failures**: if a gate fails, fix the underlying invariant (don’t “retry until it passes”).

Run all gates with:

```bash
npm run release:gates
```

---

## Gate 1 — Build + static quality

- **Goal**: ensure the app compiles and passes baseline quality checks.
- **Command**:

```bash
npm test
```

Expected:
- `lint`, `typecheck`, unit tests, and `vite build` all succeed.

---

## Gate 2 — Contrast / readability (WCAG AA invariant)

- **Goal**: no unreadable informational text on light backgrounds.
- **Commands**:

```bash
node --test tests/unit/ui-dashboard-contrast.test.mjs
node --test tests/unit/ui-geo-crawl-contrast.test.mjs
```

Expected:
- No forbidden low-contrast utility classes in key UI surfaces.

---

## Gate 3 — Auth invariant (downloads must be deterministic)

- **Goal**: authenticated downloads succeed; unauthenticated downloads fail with 401 (not 404/500).
- **Commands**:

```bash
node --test tests/unit/avatar-download-auth.test.mjs
node --test tests/unit/documents-download-auth.test.mjs
```

Expected:
- 401 for unauthenticated.
- 200 for authenticated.

---

## Gate 4 — Upload persistence invariant (avatar upload → fetchable)

- **Goal**: upload writes a file, DB points to it, and download streams it.
- **Command**:

```bash
node --test tests/unit/avatar-upload-and-download.test.mjs
```

Expected:
- Upload returns `avatar_url` under `/uploads/`.
- `avatar_download_url` returns 200 and an `image/*` content-type.

---

## Gate 5 — Discover Grants invariant (non-zero results + multiple sources)

- **Goal**: crawlers return multiple funding sources; directory-style resources survive filtering.
- **Command**:

```bash
node scripts/verify-discover-grants-local-funding.mjs
```

Expected:
- `total_found > 0`
- `count > 0`
- directory resources included

---

## Gate 6 — Pipeline invariant (no 500s during “Add to pipeline”)

- **Goal**: `/api/grants` and `/api/grants/from-opportunity` do not hard-fail under schema drift.
- **Command**:

```bash
node --test tests/unit/grants-add-to-pipeline-schema-drift.test.mjs
```

Expected:
- 200/201 from `/api/grants/from-opportunity`
- 200 from `/api/grants?...&url=...` (duplicate check)

---

## Gate 7 — End-to-end smoke (optional but recommended before deploying)

- **Goal**: “real user path” works (login → Discover Grants → results render → counts non-zero).
- **Commands**:

```bash
npm run smoke:install
npm run e2e
```

Expected:
- Discover Grants page renders results.
- “Included X of Y found” counts are non-zero when opportunities exist.

