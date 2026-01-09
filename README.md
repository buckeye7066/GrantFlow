# GrantFlow

GrantFlow is Axiom BioLabs’ grant operations workspace: a full-stack platform for managing detailed applicant profiles, orchestrating AI-assisted crawlers, tracking pipeline progress, and coordinating billing at scale. The repository contains both the production backend (Express + SQLite + OpenAI/Twilio integrations) and the Vite/React frontend deployed under `/grantflow`.

> **Production launch checklist?** See [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) for Railway/Vercel deployment steps, environment variables, seeding instructions, QA, and monitoring guidance.

---

## Feature Highlights

- **Multi-channel authentication** — Email OTP, SMS OTP (Twilio), and social OAuth (Google, Facebook, Yahoo) with rotating access/refresh tokens and session guardrails.
- **Profile operations** — 11 curated baseline profiles, section-level editors, AI enrichment, avatar lookup, document ingestion, and pipeline metrics.
- **Crawler automation** — Local, scholarship, comprehensive, item search, document ingestion, profile enrichment, avatar lookup, and pipeline automation jobs with telemetry, retry, and cancellation.
- **Funding intelligence** — Grants and item funding views enriched with match scores, crawler reasons, compliance badges, and guardrails against loans/match-required programs.
- **Billing console** — Tier assignment, discounts (student/minister), pro bono workflows, and audit logging for admins and end users.
- **Deployment ready** — Bundled scripts, smoke tests, and documentation for Railway (backend) + Vercel (frontend) with SQLite seed import and verification utilities.

---

## Architecture

| Layer | Technology |
| --- | --- |
| Frontend | Vite, React 18, React Router 7, Tailwind, shadcn/ui, Zustand, TanStack Query |
| Backend | Node.js 18+, Express, better-sqlite3, Twilio, OpenAI SDK, JWT |
| Data | SQLite (`grantflow.db` plus `/uploads` media) |
| Deployment | Railway (backend + persistent volume), Vercel (frontend with base path `/grantflow`) |
| Tooling | ESLint, Playwright smoke scripts, automation scripts under `scripts/` |

---

## Getting Started (Local Development)

### 1. Prerequisites

- Node.js 18+ and npm
- unzip / rsync (for seeding) and optionally the SQLite CLI
- OpenAI and Twilio credentials (even in development, many flows rely on them)

### 2. Clone & Install

```bash
git clone https://github.com/buckeye7066/grantflow.git
cd grantflow
npm install
```

### 3. Configure Environment

Copy the sample environment files and populate secrets:

```bash
cp backend/env.example backend/.env
cp env.example .env
```

At minimum set:

- `OPENAI_API_KEY`, `TWILIO_*`, and OAuth client IDs/secrets inside `backend/.env`
- `VITE_API_URL` (usually `http://localhost:8080`) inside `.env`

### 4. Seed the Database (11 baseline profiles)

Generate or refresh the curated SQLite seed that powers the app and automation previews:

```bash
npm run seed:db                    # creates backend/data/grantflow.db from scratch
FORCE=true npm run seed:db         # overwrite an existing database

# Reset an existing database back to the 11 curated profiles/sections
npm run seed:profiles -- --force   # uses seed/baseline-profiles.json
# Preview the changes without touching the DB
npm run seed:profiles -- --dry-run
```

> **Verification:** `npm run check:profiles` confirms the database contains all 11 baseline profiles and required sections. Use `DB_PATH=/absolute/path npm run check:profiles` if the database lives elsewhere.

### 5. Run the App

```bash
# Start backend + frontend concurrently
npm run dev:full
```

- Backend API: http://localhost:8080
- Frontend: http://localhost:5173/grantflow

You can also run the services individually (`npm run backend` and `npm run dev`) when debugging.

### 6. Onboarding Video

New team members land faster when they watch the GrantFlow walkthrough. Drop the final MP4 into `public/Grant Flow_ Get Started.mp4` (the filename matters so the dashboard link resolves) and share it during onboarding. The clip covers authentication, crawler automation, document ingestion, and the new Anya copilot.

> **Tip:** The repository ships with a placeholder file path only. Add your own recording before promoting to production so the dashboard CTA isn’t broken.

---

## Real Data Ingestion

GrantFlow fetches **live funding opportunities** from official government APIs. No mock or placeholder data is used in production.

### Running Ingestion Locally

```bash
# Ingest from all sources (Grants.gov + USASpending.gov)
npm run ingest

# Ingest from specific sources
npm run ingest:grantsgov      # Grants.gov only
npm run ingest:usaspending    # USASpending.gov only

# Run database migrations (if needed)
npm run migrate
```

### Verify Results

```bash
# Check total opportunities ingested
curl http://localhost:8080/api/opportunities | jq '.total'

# Check opportunities by source
curl 'http://localhost:8080/api/opportunities?source=grants.gov' | jq '.total'

# Get ingestion status
curl http://localhost:8080/api/opportunities/meta/ingestion | jq
```

### Admin API Ingestion

Trigger ingestion via API (requires admin auth):

```bash
POST /api/admin/ingest
```

Returns ingestion status, record counts, and any errors.

### Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_PATH` | No | Path to SQLite database (default: `backend/data/grantflow.db`) |
| `GRANTS_GOV_API_KEY` | No | Optional API key for Grants.gov (works without) |
| `OPENAI_API_KEY` | Yes | Required for AI features |
| `TWILIO_*` | Yes | Required for SMS auth |

### Data Sources

1. **Grants.gov** (`grants.gov` source)
   - Official federal grant opportunities API
   - No API key required for public data
   - Endpoint: `https://www.grants.gov/grantsws/rest/opportunities/search`

2. **USASpending.gov** (`usaspending.gov` source)
   - Federal spending and awards data
   - No API key required
   - Endpoint: `https://api.usaspending.gov/api/v2/search/spending_by_award/`

### Scheduling (Production)

On Railway, schedule ingestion to run daily using:

1. **Railway Cron**: Schedule `npm run ingest` as a cron job
2. **Internal scheduler**: Set `INGESTION_INTERVAL_HOURS` env var (future feature)

---

## QA & Smoke Tests

| Command | Purpose |
| --- | --- |
| `npm run lint` | ESLint across `src/` and `backend/` |
| `npm run smoke:callback` | Playwright smoke for social auth callback UX (requires `npm run preview`) |
| `npm run smoke:login` | Optional legacy login surface smoke |
| `npm run check:profiles` | Ensures the seed database retains the 11 baseline profiles + sections |
| `npm run seed:profiles -- --dry-run` | Preview the profile seeding plan against a target database |

Refer to the QA checklist in [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md#5-quality-assurance-checklist) before promoting a build.

---

## Deployment Overview

| Target | Checklist |
| --- | --- |
| **Railway (backend)** | Provision Node service, mount persistent volume (`/mnt/data`), copy `grantflow-migration.zip` data, set environment variables, start with `npm run server`, and verify `/api/health`.|
| **Vercel (frontend)** | Configure `VITE_API_URL` + `VITE_APP_BASE=/grantflow`, build with `npm run build`, and add rewrites for `/grantflow/api/* → Railway`. |
| **Runbook** | [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) details env vars, seeding, QA, monitoring, and rollback. |

---

## Useful Scripts

| Script | Description |
| --- | --- |
| `npm run dev:full` | Run backend and frontend simultaneously |
| `npm run backend` | Start the Express API |
| `npm run ingest` | Run full ingestion from all sources (Grants.gov + USASpending.gov) |
| `npm run ingest:grantsgov` | Ingest from Grants.gov only |
| `npm run ingest:usaspending` | Ingest from USASpending.gov only |
| `npm run migrate` | Run database migrations |
| `npm run smoke:callback` | Validate auth callback error surfaces |
| `npm run check:profiles` | Audit SQLite seeds (11 profiles + sections) |
| `npm run seed:db` | Build `backend/data/grantflow.db` from curated baseline profiles |
| `npm run seed:profiles` | Rehydrate the 11 curated profiles/sections into an existing DB (`--force` to reset) |
| `npm run seed:demo` | Seed demo data (development only, uses bundled JSON files) |
| `npm run build` / `npm run preview` | Build and preview the production frontend |

See `package.json` for the full script catalogue.

---

## National Crawl

The National ZIP Crawl feature enables comprehensive funding source discovery across all ~43,859 US ZIP codes.

### How to Run

**Start a national crawl (Admin only):**

```bash
POST /api/admin/national-crawl/start
{
  "batch_size": 50,
  "min_sources_per_zip": 3
}
```

**Monitor progress:**

```bash
GET /api/admin/national-crawl/status
```

**Stop a running crawl:**

```bash
POST /api/admin/national-crawl/stop
```

### Features

- **Batch Processing:** Processes ZIPs in configurable batches (default: 50)
- **Checkpointing:** Saves progress after every batch to `national_zip_progress` table
- **Resumable:** If interrupted, automatically resumes from last checkpoint
- **Rate Limited:** Respects upstream API limits (configurable delay between requests)
- **Memory Safe:** Processes in batches to avoid memory accumulation
- **Real Data Only:** Uses Grants.gov API, state portals, and foundation locators

### Data Sources

The national crawl integrates with multiple real data sources:
- **Grants.gov API** - Federal grant opportunities
- **State Grant Portals** - State-specific funding (OH, CA, TX, NY, FL configured)
- **Foundation Locator** - Community foundation grants

See [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) for complete source documentation.

### Monitoring

Track crawl progress in the database:

```sql
SELECT 
  COUNT(*) as total_zips,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
  SUM(sources_found) as total_sources,
  AVG(sources_found) as avg_per_zip
FROM national_zip_progress;
```

---

## Crawler Matrix Test

The Crawler Test Harness validates all 6 crawlers against all profiles in the database.

### How to Run

```bash
node scripts/test-all-crawlers-all-profiles.mjs [--db-path PATH]
```

### What It Tests

For each profile, runs all 6 crawlers:
1. `localFundingCrawler` - Local funding within 50 miles
2. `governmentFundingCrawler` - Federal/state/local government grants
3. `studentGrantsCrawler` - Student grants and scholarships
4. `ecfBenefitsCrawler` - ECF CHOICES and disability benefits
5. `itemFundingCrawler` - Item-specific funding (vehicles, equipment)
6. `specialNeedsCrawler` - Special needs populations

### Validation Checks

Each result is validated for:
- ✅ No loans (checks for keywords: loan, repay, interest, apr)
- ✅ No matching-fund requirements
- ✅ Required fields present (title, sponsor, description, URL, match_score)
- ✅ No placeholder URLs (example.com, example.org, example.gov)
- ✅ Match score within valid range (0-100)

### Output

- **Audit Report:** `backend/data/audit/crawler-matrix-YYYYMMDD.json`
- **Database Log:** Results logged to `crawl_logs` table
- **Console Output:** Real-time progress and summary statistics

### Exit Codes

- `0` - All tests passed
- `1` - Some tests failed or produced invalid results

---

## Admin Profile Access

GrantFlow enforces role-based access control for profile management.

### Admin User

**Identification:**
- Email: `buckeye7066@gmail.com`
- OR `users.is_admin = true` flag in database

**Permissions:**
- ✅ View ALL profiles in the system
- ✅ Create profiles for any user
- ✅ Access any profile details
- ✅ Run national crawls
- ✅ Access admin endpoints

### Enduser

**Permissions:**
- ✅ View only their own profiles (`profiles.user_id = user.id`)
- ✅ Create profiles for themselves only
- ✅ Access only their own profile details
- ❌ Cannot see other users' profiles
- ❌ Cannot run national crawls
- ❌ Cannot access admin endpoints

### API Endpoints

**GET /api/profiles**
- Admin: Returns all profiles
- Enduser: Returns only profiles where `user_id` matches

**POST /api/profiles**
- Admin: Can create for anyone (specify `user_id` in body)
- Enduser: Can only create for themselves

**GET /api/profiles/:id**
- Admin: Can access any profile
- Enduser: Can only access if `user_id` matches

### Server-Side Enforcement

All access control is enforced server-side. UI hints are NOT sufficient - the backend validates permissions on every request.

---

## Documentation & References

- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) — Complete documentation of all real data sources, APIs, rate limits, and best practices.
- [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) — Production checklist, env vars, seeding, QA, monitoring.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Vercel + Railway deployment guide.
- [`docs/VERCEL_RAILWAY_DEPLOYMENT.md`](docs/VERCEL_RAILWAY_DEPLOYMENT.md) — Detailed deployment instructions.
- [`docs/AUTH_FRONTEND_PLAN.md`](docs/AUTH_FRONTEND_PLAN.md) — Historical context for the authentication UX overhaul.
- `scripts/` — Smoke tests (`smoke-login.mjs`, `smoke-auth-callback.mjs`), database auditing (`check-profiles.mjs`), and crawler testing (`test-all-crawlers-all-profiles.mjs`).

---

## Support & Maintenance

- Monitor OpenAI and Twilio usage; set billing caps and alerts.
- Schedule backups of `grantflow.db` and `/uploads` from the Railway volume.
- Keep OAuth redirect URIs in each provider dashboard synchronized with production (`https://app.axiombiolabs.org/grantflow/api/auth/<provider>/callback`).
- Review crawler logs regularly to ensure data sources remain operational.
- Update data source configurations if APIs change (see `docs/DATA_SOURCES.md`).

Questions or deployment assistance? Open an issue or contact the GrantFlow engineering team at Axiom BioLabs. Happy shipping! 🎉
# GrantFlow

A professional marketing website for GrantFlow by Axiom BioLabs - Finding funding sources for various financial situations.

## Overview

This is a static marketing site built with Vite, React, and Tailwind CSS. It includes:

- Landing page with hero section, features, and CTAs
- Pricing page with multiple subscription tiers
- Complete legal pages (Terms of Service, Privacy Policy, HIPAA Compliance, Data Retention)
- Responsive design with modern UI components
- Navigation and footer with all required links

## Technology Stack

- **Vite** - Fast build tool and dev server
- **React** - UI component library
- **Tailwind CSS** - Utility-first CSS framework
- **React Router** - Client-side routing

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Installation

```bash
# Install dependencies
npm install
```

### Development

```bash
# Start development server
npm run dev
```

The site will be available at `http://localhost:5173/`

### Build for Production

```bash
# Build optimized production bundle
npm run build
```

The production files will be in the `dist/` directory.

### Preview Production Build

```bash
# Preview production build locally
npm run preview
```

### Linting

```bash
# Run ESLint
npm run lint
```

## Deployment

### GoDaddy Hosting

1. **Build the project:**
   ```bash
   npm run build
   ```

2. **Upload to GoDaddy:**
   - Log in to your GoDaddy account
   - Navigate to your hosting control panel (cPanel)
   - Use File Manager or FTP to upload the contents of the `dist/` folder
   - Upload to your `public_html` directory (or subdirectory)
   - Ensure the `index.html` is in the root of your web directory

3. **Configure .htaccess for Single Page Application:**
   Create a `.htaccess` file in your web root with:
   ```apache
   <IfModule mod_rewrite.c>
     RewriteEngine On
     RewriteBase /
     RewriteRule ^index\.html$ - [L]
     RewriteCond %{REQUEST_FILENAME} !-f
     RewriteCond %{REQUEST_FILENAME} !-d
     RewriteRule . /index.html [L]
   </IfModule>
   ```

## Project Structure

```
GrantFlow/
├── src/
│   ├── components/
│   │   ├── Navigation.jsx    # Main navigation bar
│   │   └── Footer.jsx         # Site footer
│   ├── pages/
│   │   ├── Home.jsx           # Landing page
│   │   ├── Pricing.jsx        # Pricing plans
│   │   ├── Terms.jsx          # Terms of Service
│   │   ├── Privacy.jsx        # Privacy Policy
│   │   ├── HIPAA.jsx          # HIPAA Compliance
│   │   └── DataRetention.jsx  # Data Retention Policy
│   ├── App.jsx                # Main app component with routing
│   ├── main.jsx               # Application entry point
│   └── index.css              # Global styles with Tailwind
├── public/                    # Static assets
├── index.html                 # HTML template
├── tailwind.config.js         # Tailwind configuration
├── postcss.config.js          # PostCSS configuration
├── vite.config.js             # Vite configuration
└── package.json               # Project dependencies
```

## Placeholder Assets

⚠️ **Note: The following assets need to be replaced with actual assets:**

- Company logo (currently using text-based branding)
- Hero section background images
- Feature icons (currently using emoji placeholders: 🔍 📊 🔒)
- Testimonial photos
- Any branded imagery

To add real images:
1. Place images in the `public/` directory
2. Reference them in components using `/image-name.png`
3. For optimized images, place in `src/assets/` and import in components

## Customization

### Brand Colors

Edit `tailwind.config.js` to update brand colors:

```javascript
theme: {
  extend: {
    colors: {
      'axiom-blue': '#1e40af',        // Primary brand color
      'axiom-light-blue': '#3b82f6',  // Secondary brand color
    },
  },
}
```

### Content Updates

- **Home page:** Edit `src/pages/Home.jsx`
- **Pricing:** Edit `src/pages/Pricing.jsx`
- **Legal pages:** Edit respective files in `src/pages/`
- **Navigation links:** Edit `src/components/Navigation.jsx`
- **Footer content:** Edit `src/components/Footer.jsx`

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## License

Copyright © 2024 Axiom BioLabs. All rights reserved.

## Support

For questions or issues, contact: support@axiombiolabs.org
A grant management application built with React, TypeScript, and Vite.

## 🚀 Quick Start

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/buckeye7066/GrantFlow.git
   cd GrantFlow
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   # Copy the example environment file
   cp .env.example .env
   
   # Edit .env and replace placeholder values with your actual configuration
   # IMPORTANT: Never commit your .env file to version control
   ```

4. **Start the development servers**
   
   **Frontend (Vite dev server):**
   ```bash
   npm run dev
   ```
   
   **Backend (if applicable):**
   ```bash
   cd backend
   npm start
   ```

## 🔐 Environment Configuration

### Required Environment Variables

GrantFlow requires several environment variables to run properly. These should be configured in a `.env` file in the root directory.

#### Backend Variables
- `ANYA_ADMIN_TOKEN` - Admin authentication token (⚠️ **Must be a strong, random value**)
- `PORT` - Backend server port (default: 4000)
- `CORS_ORIGIN` - Allowed CORS origin for API requests

#### Frontend Variables
- `VITE_API_PROXY_TARGET` - Backend API URL for Vite proxy

#### Optional Variables
- `OPENAI_API_KEY` - For AI-powered features (if enabled)
- Database connection strings (if using a database)

### 🔒 Security Best Practices

**CRITICAL:** Never commit secrets to version control!

1. **Always use `.env` for local development**
   - Your `.env` file is automatically ignored by git
   - Use `.env.example` as a template (safe to commit)

2. **Generate strong tokens**
   ```bash
   # Example: Generate a secure random token
   openssl rand -hex 32
   ```

3. **Rotate exposed secrets immediately**
   - If you accidentally expose an API key, rotate it immediately
   - Check your git history for accidentally committed secrets
   - Review access logs for unauthorized usage

4. **Use different secrets for each environment**
   - Development, staging, and production should have unique credentials

5. **Audit your configuration regularly**
   ```bash
   # Check that .env is in .gitignore
   git check-ignore .env
   
   # Search for accidentally committed secrets (if you have git-secrets)
   git secrets --scan
   ```

### 📋 Environment Setup Checklist

- [ ] `.env` file created from `.env.example`
- [ ] All placeholder values replaced with real credentials
- [ ] Strong, random token generated for `ANYA_ADMIN_TOKEN`
- [ ] Verified `.env` is in `.gitignore`
- [ ] Confirmed no secrets in git history
- [ ] Different credentials for dev/staging/production

## 🛠️ Development

### Tech Stack

- **Frontend:** React + TypeScript + Vite
- **Styling:** Tailwind CSS
- **Backend:** Node.js (Express)
- **Build Tool:** Vite with HMR (Hot Module Replacement)

### Available Scripts

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run linter
npm run lint
```

### Smoke Tests

- `npm run smoke:login` validates that the login page renders in a headless browser.
- Start the preview server in another terminal (`npm run preview`) before running the smoke script.
- Local preview serves the app at `/`, so run `SMOKE_BASE_PATH=/ npm run smoke:login`.
- In hosted environments (Vercel), the default base path `/grantflow` is already configured—no override required.

## 📦 Building for Production

```bash
# Create optimized production build
npm run build

# The build output will be in the `dist` directory
```

**Before deploying:**
- Ensure all environment variables are properly configured on your hosting platform
- Use production-grade secrets (not development values)
- Enable HTTPS for all production deployments
- Set appropriate CORS origins

## 🚀 Production Deployment

For deploying GrantFlow to a production environment (Digital Ocean, AWS, etc.), see the comprehensive deployment guide:

**[📘 Production Deployment Guide](docs/DEPLOYMENT.md)**

The deployment guide covers:
- Digital Ocean server setup
- Nginx reverse proxy configuration
- SSL/TLS certificate setup with Let's Encrypt
- Backend service configuration with systemd
- Automated deployment scripts
- Troubleshooting common issues
- Health checks and monitoring

### Quick Deploy

For automated deployment on your production server:

```bash
# Make the deployment script executable
chmod +x scripts/deploy-production.sh

# Run the deployment
./scripts/deploy-production.sh
```

### Production Checklist

Before going live, ensure:
- [ ] Environment variables configured (`.env.production.example` → `.env`)
- [ ] Strong, random `ANYA_ADMIN_TOKEN` generated
- [ ] CORS origins set to production domain(s)
- [ ] SSL/TLS certificates installed
- [ ] Nginx configured and running
- [ ] Backend systemd service enabled
- [ ] Firewall rules configured (ports 80, 443, 22)
- [ ] DNS records pointing to your server
- [ ] Health checks passing

### Production Architecture

```
Vercel (Frontend) → www.axiombiolabs.org/grantflow
Railway (Backend API) → grantflow-production.up.railway.app

DNS: Managed by Vercel
Routing: vercel.json handles /grantflow/* → Frontend, /api/* → Railway
```

## 🧪 React + Vite Configuration

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc/tree/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

### Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      // Or for stricter rules:
      // tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
])
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

**Security Note:** Never include secrets or API keys in your commits!

## 📄 License

This project is licensed under the MIT License.

## 🆘 Troubleshooting

### Common Issues

**Environment variables not loading:**
- Verify `.env` file exists in project root
- Check that variables are properly formatted (`KEY=value`)
- Restart development server after changing `.env`

**CORS errors:**
- Check `CORS_ORIGIN` matches your frontend URL
- Verify backend server is running on the correct port

**Build failures:**
- Clear node_modules and reinstall: `rm -rf node_modules && npm install`
- Check for TypeScript errors: `npm run type-check` (if configured)

## 🔗 Resources

- [Vite Documentation](https://vitejs.dev/)
- [React Documentation](https://react.dev/)
- [TypeScript Documentation](https://www.typescriptlang.org/)
- [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [GitHub Secret Scanning](https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning)
