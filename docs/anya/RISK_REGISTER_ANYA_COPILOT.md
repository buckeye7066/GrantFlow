# Risk Register: Anya Copilot UX (flagged rollout)

## Phase 0 — Baseline & CI

### CI pipeline (package.json)
- **`npm test`**: lint → typecheck → unit → build
- **`npm run release:gates`** (CI): rollup-native, quality+build (npm test), ui-contrast, auth/downloads, uploads, discover-local-funding, pipeline-add
- **GitHub Actions** (`.github/workflows/ci.yml`): checkout, Node 20.20.2, npm ci, audit (high+), release:gates
- **Smoke**: `npm run smoke` — Playwright, backend on 8080, basePath /grantflow
- **E2E**: `npm run e2e` — full Playwright suite

### Current risks (what could break)
| Area | Risk | Mitigation |
|------|------|------------|
| **Routing** | New code reads `location.pathname`/search; typo could break basePath | Use same `createPageUrl` / basePath as rest of app; no hardcoded paths |
| **Sidebar** | Layout wraps with AnyaContextProvider; extra provider could affect tree | Only mount provider when `ANYA_COPILOT_ENABLED`; when OFF, tree matches main |
| **Auth** | Anya session bootstrap uses profileId; wrong id could scope to wrong profile | No change to auth or session creation; flags only gate UI |
| **Anya session bootstrap** | useEffects in AnyaChat depend on sessionId/profileId | No new effects; when flag OFF, no new hooks that touch session |
| **Tool registry** | AnyaChat fetches tools; new UI might call tools before ready | Next-step actions only navigate or invoke when sessionId present; same as today |
| **Lint/build** | Pre-existing lint errors (client.js APP_BASE, navConfig empty block, etc.) | Do not change those files for this feature; CI may already be failing on main |
| **Infinite re-renders** | Context or adapter state updates on every render | Throttle/debounce context updates; adapter state from URL/useMemo only |

### Acceptance (stability)
- With **flags OFF**: app behaviour and DOM tree match current main (no AnyaContextProvider, no next steps, no "Use current screen").
- With **flags ON**: new Anya features work; Playwright smoke + new unit tests pass.
- No new code runs (no provider, no new Anya UI) when flags are OFF.
