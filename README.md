# GrantFlow

## Overview

GrantFlow is an open‑source platform for managing grant applications, tracking progress and compliance, and automating the grant lifecycle.  The system comprises a frontend built with **React**, **Vite**, **Tailwind CSS**, and a backend built with **Node.js**, **Express**, and **PostgreSQL**.  It also integrates AI tools to summarize grant proposals and provide recommendations.

This repository contains the core application code.

## Feature highlights

- **Profile management** – users can create organizations and manage members with granular access roles.
- **Grant discovery** – search and filter grants from multiple sources using the built‑in crawler and external APIs.
- **Pipeline management** – track each grant opportunity through stages (research, application, follow‑up, reporting).
- **Proposal development** – collaborative editor with AI assistance to generate and refine proposal sections.
- **Document management** – upload and organize supporting documents; integrate with storage providers.
- **Milestones & deadlines** – schedule tasks, due dates, and reminders.
- **Reporting & analytics** – dashboards summarise funding pipelines and win rates.
- **Billing & invoicing** – optional module for agencies that provide grant services to clients.
- **Outreach/CRM** – manage relationships with grantors and partners.
- **Admin tooling** – built‑in admin UI for configuration, user management, and health monitoring.

For documentation, see **`docs/README.md`** (index). Key: **`docs/CRAWLERS.md`** (crawlers), **`docs/ENVIRONMENT.md`** (env vars), **`docs/VERCEL_RAILWAY_DEPLOYMENT.md`** (deploy).

### Anya autonomous crawler — write gating

The `admin.anya.runAutonomous` tool and the `scripts/anya-autonomous.mjs` CLI
are **safe by default**. They can scan the repo, surface findings, and return
a diff preview without ever writing a file.

To actually modify files, BOTH of the following must be true:

1. Environment: `ANYA_AUTONOMOUS_WRITES=1` (or legacy `ANYA_AUTONOMOUS_WRITE_CHANGES=true`)
2. Per-invocation intent: either `--write` on the CLI, or `dry_run: false` on
   the HTTP endpoint

If either is missing, the run is forced to dry run and the report sets
`dry_run_forced_by_env: true`. This is intentional — it blocks accidental or
remotely-triggered writes. Never enable these by default in production.

```bash
# Safe dry run (default)
node scripts/anya-autonomous.mjs

# Actually apply fixes — BOTH gates required
ANYA_AUTONOMOUS_WRITES=1 node scripts/anya-autonomous.mjs --write --fix-empty-catch
```

## Getting started

The backend service requires **Node.js 20+** and **PostgreSQL**.  See `docs/ENVIRONMENT.md` for environment variables and `docs/VERCEL_RAILWAY_DEPLOYMENT.md` or `docs/DEPLOYMENT_DO.md` for deployment options.

To set up a development environment:

```bash
git clone https://github.com/buckeye7066/GrantFlow.git
cd GrantFlow
npm install
cp .env.example .env
# set required environment variables in .env
npm run migrate
npm run dev
```


## Contributing

We welcome contributions!  Please open an issue or pull request to discuss changes.  See `docs/CONTRIBUTING.md` for guidelines.