## Make app runnable end-to-end + add doctor/smoke suite

### Overview
This PR makes local/dev execution deterministic and adds a one-command **doctor** pipeline that:
- runs install checks, lint, typecheck, unit tests, production build
- starts backend + frontend dev servers
- runs Playwright smoke that exercises UI routes and discovered backend endpoints
- writes evidence logs/artifacts under `artifacts/YYYY-MM-DD/`

### How to run

- `npm run doctor`
- Smoke only: `npm run smoke`

### Artifacts produced (per run)
Written to: `artifacts/YYYY-MM-DD/` (e.g. `artifacts/2026-01-10/`)
- `lint.log`, `typecheck.log`, `test.log`, `build.log`
- `backend.log`, `frontend.log`, `smoke.log`
- `playwright-report/` + `playwright-output/` (traces/screenshots/videos on failure)
- `repro/` JSON: route list, UI clicks, console errors, api calls
- `doctor-success.txt` (or `doctor-failure.txt`)

### Key changes
- `scripts/doctor.mjs`: orchestrates the full pipeline and captures logs to artifacts
- `tests/smoke/`: Playwright smoke enumerates routes from `src/pages/index.jsx`, clicks visible controls safely, captures console errors, discovers backend routes and calls them with safe payloads
- `docs/ENV_VARS.md`: generated env inventory with required/optional + dev defaults + usage locations
- `docs/REPRO_MATRIX.md`: repo discovery + what doctor/smoke covers
- `docs/DEFECT_LEDGER.md`: evidence-based defects and fixes
- `.env.example` + `.env.development.local`: safe dev templates


