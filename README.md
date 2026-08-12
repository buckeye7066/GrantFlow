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

### Anya autonomous crawler - code-error repair

The `admin.anya.runAutonomous` tool and the `scripts/anya-autonomous.mjs` CLI
are **safe by default**. They can scan the repo, surface findings, and return a
diff preview without writing a file.

To modify files, use per-invocation intent: `--write` on the CLI, or
`dry_run: false` on the HTTP endpoint. Anya code-error repair does not require a
separate environment permission gate. Applied edits are backed up and audited.

```bash
# Safe dry run (default)
node scripts/anya-autonomous.mjs

# Actually apply fixes
node scripts/anya-autonomous.mjs --write --fix-empty-catch
```

## Getting started

The verified backend/release runtime is **Node.js 20.20.2** and production uses **PostgreSQL**. Capacitor commands use the explicit **Node.js 22.22.0** mobile-tooling pin in `.node-version-mobile`; web builds and release gates still run under `.nvmrc`. See `docs/ENVIRONMENT.md` for environment variables and `docs/VERCEL_RAILWAY_DEPLOYMENT.md` or `docs/DEPLOYMENT_DO.md` for deployment options.

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

## School portal scholarship imports (pilot)

GrantFlow now includes a provider-based foundation for importing scholarships and funding items from school portals into student profiles.

- **Supported provider(s):** TSAC (`tsac`)
- **Current mode:** `pilot_manual_import`
- **Live TSAC auth/API:** **not** implemented in this release

### Architecture overview

- Provider adapters normalize portal-specific award records into a canonical GrantFlow scholarship shape.
- Imported awards are stored with provenance metadata (provider, portal URL, import mode, and merge timestamps).
- Merged awards are attached to `university_applications.applications[].imported_portal_awards` and mirrored into each school’s `financial_aid_pipeline`.
- Duplicate merges are collapsed by provider/source identity plus award fingerprint so the same portal award is not repeatedly added.

### Current user flow

1. Open a student profile’s **Student portals** card.
2. Choose **Connect portal**.
3. Select the provider (currently TSAC), optionally choose the target university, and paste JSON copied/exported from the portal.
4. Review the normalized awards and merge the selected items into the student profile.
5. Remove merged awards later if needed; disconnecting a provider does not delete awards that were already merged into the profile.

### Limitations / setup

- This is intentionally a **manual-import pilot**, not a simulated OAuth flow.
- GrantFlow does **not** request or store raw school-portal passwords.
- For TSAC, provide award records as JSON objects with fields such as `title`, `amount`, `status`, and `academic_year`.
- No extra environment variables are required for the current pilot mode.

## Contributing

We welcome contributions!  Please open an issue or pull request to discuss changes.  See `docs/CONTRIBUTING.md` for guidelines.
