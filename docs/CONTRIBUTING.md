# Contributing to GrantFlow

Thank you for helping improve GrantFlow! This guide covers everything you need to get started, stay consistent with our code style, and ship quality changes.

---

## Getting Started

1. **Fork** the repository and clone your fork locally.
2. **Install dependencies:**
   ```bash
   npm ci
   ```
3. **Set up your environment:** Copy `.env.example` to `.env` and fill in the required values (see `docs/ANYA_SETUP_GUIDE.md` for AI-related keys).
4. **Run database migrations:**
   ```bash
   npm run migrate
   ```
5. **Start the development server:**
   ```bash
   npm run dev
   ```
   This starts both the Vite frontend (default port 5173) and the Express backend (default port 3000) concurrently.

### Before you push or open a PR

- Run **`npm run check:prepush`** — lint, TypeScript check, and **`vite build`** (the same production bundle Vercel builds). This catches missing exports and Rollup errors in minutes.
- Run **`npm test`** before large changes when you can spare the time (includes unit tests and release-style checks via `npm run release:gates` in CI).
- When editing **`src/api/*.js`** or other shared modules: **extend** the file; do not replace it wholesale. Search imports (`grep`) and keep every existing export callers rely on.

---

## Code Style

### Logging

- Use `console.info()` in route handlers — **never `console.log()`**.  
  `console.log` is treated as debug noise; `console.info` is visible at production log levels.
- Use `console.warn()` for recoverable issues and background errors.
- Use `console.error()` for unexpected failures.

### Error Handling

- **No empty catches.** Replace `.catch(() => {})` with `.catch(e => console.warn('[background]', e?.message || e))` so background errors surface in logs.
- **Exception:** Filesystem temp-file cleanup may use `.catch(() => { /* temp cleanup */ })` to document intent.
- Wrap fire-and-forget calls in a named catch so failures are observable.

### Parameterized SQL

- All SQL queries **must** use parameterized statements (placeholders `?` or `$1`).  
  Never interpolate user-supplied values directly into query strings.

### Zod Validation

- Validate all external input (request bodies, API responses, env vars) with [Zod](https://zod.dev) schemas before use.
- Define schemas close to where they are used; export them when shared.

---

## Profile Isolation Rule

Every query that reads from the `funding_opportunities` table **must** include a profile-ID isolation filter to prevent cross-profile data bleed:

```sql
AND (profile_id IS NULL OR profile_id = ?)
```

- `profile_id IS NULL` — global catalog entries visible to all profiles.
- `profile_id = ?` — profile-scoped records visible only to that profile.

Queries that omit this filter will be flagged by the Anya auto-repair scanner (`profile_bleed` repair type) and should be treated as security issues.

---

## Testing

| Command | Purpose |
|---|---|
| `npm test` | Full suite: lint + typecheck + unit tests + build |
| `npm run test:unit` | Unit tests only (Vitest) |
| `npm run test:smoke` | Smoke tests (requires running server) |
| `npm run test:e2e` | End-to-end tests |

All 60 Vitest unit tests must pass before merging. Run `npm test` locally before opening a PR.

---

## Commit Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>
```

**Types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`

**Examples:**
```
feat(matching): add veteran-only grant eligibility check
fix(auth): prevent code reuse after expiry
docs(contributing): add profile isolation rule
chore(deps): remove unused firebase dependency
```

Keep the subject line under 72 characters. Add a body for anything non-obvious.

---

## Pull Request Workflow

1. Create a branch from `main`: `git checkout -b feat/my-feature`
2. Make focused, atomic commits.
3. Run `npm test` — all checks must pass.
4. Open a PR against `main` with a clear title and description.
5. Address reviewer feedback; re-request review when ready.
6. Squash-merge after approval.

---

## Architecture Overview

### Backend Stack

| Technology | Role |
|---|---|
| Node.js + Express | API server |
| better-sqlite3 / Postgres | Database |
| Anthropic Claude | AI assistant (Anya) |
| Zod | Runtime validation |

### Frontend Stack

| Technology | Role |
|---|---|
| React + Vite | UI framework |
| Framer Motion | Animations |
| Tailwind CSS | Styling |

### AI (Anya)

Anya is the autonomous assistant integrated throughout GrantFlow. She uses:
- **Tool registry** (`anyaToolRegistry.js`) — maps tool names to handlers
- **Brain service** (`anyaBrainService.js`) — persistent memory across sessions
- **Health service** (`anyaHealthService.js`) — periodic background maintenance
- **Auto-repair service** (`anyaAutoRepairService.js`) — automated code quality scanning

### Key Directories

| Directory | Contents |
|---|---|
| `backend/routes/` | Express route handlers |
| `backend/services/` | Business logic and AI services |
| `backend/utils/` | Shared utilities |
| `backend/middleware/` | Express middleware (auth, rate limiting) |
| `src/components/` | React UI components |
| `src/pages/` | Page-level components |
| `src/api/` | Frontend API client |
| `docs/` | Documentation |
| `tests/` | Test files |

---

## Security Guidelines

- **Never commit secrets** — use environment variables and `.env` files (which are git-ignored).
- **Parameterize all SQL** — see [Parameterized SQL](#parameterized-sql) above.
- **Enforce profile isolation** — every `funding_opportunities` query must include the isolation filter.
- **Validate input with Zod** — never trust raw request data.
- **Rate-limit sensitive endpoints** — auth routes are protected by `express-rate-limit`.
- **Admin routes require authentication** — use the `ensureAdminRequest` guard.
- Report security vulnerabilities privately to the maintainers — do not open public issues for security bugs.
