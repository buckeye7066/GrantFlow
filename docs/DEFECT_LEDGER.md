# Defect Ledger

Rules:
- **No claim without evidence**: either failing output under `artifacts/YYYY-MM-DD/*` OR a provable static crash path.
- Each entry includes: **[ID] [Severity] [Component] [Repro] [Verbatim Trace] [Root Cause Snippet] [Fix] [Verification]**.

---

## [D-001] [High] [Doctor/Smoke] Playwright UI smoke missing (deleted)

### Repro

- `npm run smoke`

### Verbatim Trace

- Prior to restoration, `tests/smoke/smoke.spec.mjs` was missing.

### Root Cause Snippet

- Missing file: `tests/smoke/smoke.spec.mjs`

### Fix

- Restore Playwright config + smoke spec under `tests/smoke/`.

### Verification

- `npm run smoke` executes Playwright and produces `artifacts/YYYY-MM-DD/playwright-report/`.

---

## [D-002] [High] [Doctor] Doctor helpers deleted causing `ERR_MODULE_NOT_FOUND`

### Repro

- `npm run doctor`

### Verbatim Trace

Example (when helpers are missing):
- `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../scripts/_doctor/paths.mjs' imported from .../scripts/doctor.mjs`

### Root Cause Snippet

- Missing files: `scripts/_doctor/paths.mjs`, `scripts/_doctor/run.mjs`

### Fix

- Restore `scripts/_doctor/*` helper modules and keep `scripts/doctor.mjs` imports stable.

### Verification

- `npm run doctor` reaches lint/typecheck/build/smoke stages (logs in `artifacts/YYYY-MM-DD/`).

