# GrantFlow documentation index

Use this index to find the right doc. Duplicate or superseded docs have been merged or removed.

## Crawlers

| Doc | Purpose |
|-----|--------|
| **[CRAWLERS.md](CRAWLERS.md)** | Single reference: goals summary, policy implementation, data sources, env vars, defect log, link to V2 |
| **[CURSOR_MASTER_PROMPT_CRAWLERS.md](CURSOR_MASTER_PROMPT_CRAWLERS.md)** | Goals and rules for Cursor (paste into rules or chat when editing crawlers) |
| [DATA_SOURCES.md](DATA_SOURCES.md) | Real APIs (Grants.gov, NIH, etc.) — fields, rate limits, provenance |
| [CRAWLER_SOURCES.md](CRAWLER_SOURCES.md) | National Crawler V2 registry and scope (SMOKE/STATE/NATIONAL) |
| [CRAWLER_ARCHITECTURE.md](CRAWLER_ARCHITECTURE.md) | National Crawler V2 pipeline (tracks, fetch, parse, store) |
| [CRAWLER_SCHEMA.md](CRAWLER_SCHEMA.md) | V2 normalized schema (nf_programs_a/b) |

## Deployment and environment

| Doc | Purpose |
|-----|--------|
| **[ENVIRONMENT.md](ENVIRONMENT.md)** | Production env vars (Vercel + Railway) — single source of truth |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deployment overview and links |
| [VERCEL_RAILWAY_DEPLOYMENT.md](VERCEL_RAILWAY_DEPLOYMENT.md) | Step-by-step Vercel + Railway playbook |
| [PROD_READINESS.md](PROD_READINESS.md) | Production readiness report and quality gate |
| [ENV_VARS.md](ENV_VARS.md) | Generated inventory (run `node scripts/inventory-env.mjs`) |

## Product rules and auth

| Doc | Purpose |
|-----|--------|
| [canonical_rules.md](canonical_rules.md) | Product goals, correctness invariants, acceptance criteria |
| [AUTH_FLOW_BLUEPRINT.md](AUTH_FLOW_BLUEPRINT.md) | Auth flow and session handling |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Required env for auth (e.g. JWT, Resend) |

## Other

- **README.md** (repo root) — overview, getting started
- **Profile / taxonomy:** [PROFILE_TAXONOMY.md](PROFILE_TAXONOMY.md), [PROFILE_DATA_POINTS.md](PROFILE_DATA_POINTS.md)
- **API:** [API_ROUTING.md](API_ROUTING.md)
- **Testing:** [TESTING.md](TESTING.md)
- **Errors:** [ERROR_LEDGER.md](ERROR_LEDGER.md)
