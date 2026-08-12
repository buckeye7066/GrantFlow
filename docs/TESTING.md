# Testing + Local Boot (GrantFlow)

This repo is a single Node workspace (frontend + backend run from the repo root).

## Prereqs
- Node.js **20.20.2** for tests and web builds (the `.nvmrc` release/runtime pin); Capacitor commands use Node **22.22.0** from `.node-version-mobile`
- npm
- (Optional) Postgres, if you want `DB_PROVIDER=postgres`

## Install
### Windows (PowerShell)
```powershell
npm ci
Copy-Item .env.example .env
```

### macOS/Linux (bash)
```bash
npm ci
cp .env.example .env
```

## Database init (migrate + deterministic seed)
```bash
npm run db:setup
```

What it seeds:
- 1 admin user \(email from `ADMIN_EMAIL`, default `admin@grantflow.app`\)
- 2 non-admin users \(fixed emails `user1@grantflow.local`, `user2@grantflow.local`\)
- 2 profiles \(one per user\)
- baseline “Source Directory” entries as `funding_opportunities` with `type=PROGRAM|DIRECTORY`
- **no** grant opportunities (`type=OPPORTUNITY`)

## Start app (frontend + backend)
```bash
npm run dev:all
```

Defaults:
- Frontend: `http://localhost:5173/grantflow/`
- Backend: `http://127.0.0.1:8080/api/health`

## Test commands
### Unit + contracts (repo unit runner)
```bash
npm run unit
```

### Lint
```bash
npm run lint
```

### Typecheck
```bash
npm run typecheck
```

### E2E smoke tests (Playwright)
First-time setup:
```bash
npx playwright install
```

Run:
```bash
npm run smoke
```

### Full suite (required for hardening)
```bash
npm run test:all
```
