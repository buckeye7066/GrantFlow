# GrantFlow

## Overview

GrantFlow is an open‑source platform for managing grant applications, tracking progress and compliance, and automating the grant lifecycle.  The system comprises a frontend built with **React**, **Vite**, **Tailwind CSS**, and a backend built with **Node.js**, **Express**, and **PostgreSQL** using Prisma ORM.  It also integrates AI tools to summarize grant proposals and provide recommendations.

This repository contains the core application code.  A separate marketing site is maintained in its own directory (see `marketing/README.md`) to avoid mixing deployment instructions and dependencies.

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

For a complete feature specification, see `docs/GRANTFLOW-SPEC.md`.

## Getting started

The backend service requires **Node.js 18+** and **PostgreSQL**.  See `docs/ENVIRONMENT.md` for environment variables and `docs/VERCEL_RAILWAY_DEPLOYMENT.md` or `docs/DEPLOYMENT_DO.md` for deployment options.

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

The marketing site can be developed from `marketing/`.

## Contributing

We welcome contributions!  Please open an issue or pull request to discuss changes.  See `docs/CONTRIBUTING.md` for guidelines.