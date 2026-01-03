# GrantFlow Production Readiness Checklist

This playbook captures the exact steps and configuration required to ship the current GrantFlow build to production. It assumes you are deploying the frontend to **Vercel** (served from `/grantflow`) and the backend (Node/Express + SQLite) to **Railway**. Adaptation for other providers is straightforward as long as the environment variables and base paths remain consistent.

---

## 1. Pre-flight Verification

Run these commands locally before cutting any release:

```bash
npm install
npm run lint
node scripts/smoke-auth-callback.mjs      # requires npm run preview in another terminal
# (optional) add any Playwright/Playwright-style smoke suites here
```

Confirm that the app starts cleanly:

```bash
npm run dev              # frontend (Vite, served from http://localhost:5173/grantflow)
npm run server           # backend (Express, http://localhost:8080)
```

Smoke the login flow (email, SMS, social) using the hosted preview or local environment. Make sure the session-expired dialog can re-authenticate without a full refresh.

---

## 2. Environment Variables

### Backend (Railway)

| Variable | Sample | Notes |
| --- | --- | --- |
| `PORT` | `8080` | Railway assigns dynamically; use `${PORT}` in start script |
| `DATABASE_URL` | `/mnt/data/grantflow.db` or Railway SQLite URL | Persisted SQLite path; on Railway use the built-in `DATABASE_URL` mount |
| `NODE_ENV` | `production` | Enables production logging/behavior |
| `ADMIN_TOKEN` | `openssl rand -hex 32` | Required for admin-scoped API actions (legacy compatibility) |
| `ADMIN_NAME` | `Lindsay White` | Optional: default display for admin accounts |
| `ADMIN_EMAIL` | `admin@axiombiolabs.org` | Optional |
| `CORS_ORIGIN` | `https://www.axiombiolabs.org,https://app.axiombiolabs.org` | Comma-separated list of allowed origins |
| `OPENAI_API_KEY` | `sk-...` | Needed for Anya AI, crawlers, profile enrichment, avatar lookup |
| `AUTH_JWT_SECRET` | `openssl rand -hex 64` | Signs access tokens |
| `AUTH_ACCESS_TOKEN_TTL` | `900` | Seconds (15 minutes) |
| `AUTH_REFRESH_TOKEN_TTL` | `2592000` | Seconds (30 days) |
| `AUTH_EMAIL_CODE_TTL` | `600` | Seconds (10 minutes) |
| `AUTH_EMAIL_RESEND_SECONDS` | `45` | Cooldown between email OTP sends |
| `AUTH_PHONE_CODE_TTL` | `600` | Seconds |
| `AUTH_PHONE_RESEND_SECONDS` | `60` | Seconds |
| `AUTH_OAUTH_STATE_TTL` | `600` | Seconds |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | Provided by Google | Required for Google SSO |
| `AUTH_FACEBOOK_CLIENT_ID` / `AUTH_FACEBOOK_CLIENT_SECRET` | Provided by Meta | Required for Facebook SSO |
| `AUTH_YAHOO_CLIENT_ID` / `AUTH_YAHOO_CLIENT_SECRET` | Provided by Yahoo | Required for Yahoo SSO |
| `AUTH_GOOGLE_REDIRECT_URI` (etc.) | `https://app.axiombiolabs.org/grantflow/api/auth/google/callback` | Override only if provider dashboard requires absolute URIs |
| `TWILIO_ACCOUNT_SID` | `AC...` | Required for SMS OTP |
| `TWILIO_AUTH_TOKEN` | `...` | Required for SMS OTP |
| `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER` | `...` | Required for SMS OTP |
| `AUTH_PUBLIC_URL` | `https://app.axiombiolabs.org/grantflow` | Used for magic-link emails (if enabled later) |
| `AUTH_FRONTEND_URL` | `https://app.axiombiolabs.org` | Base URL for redirects |
| `AUTH_FRONTEND_APP_BASE` | `/grantflow` | Keeps callback URLs aligned with the Vite base path |
| `ANALYTICS_WRITE_KEY` | `GF_PROD_...` | Optional: plug into Segment/PostHog to capture usage |
| `SENTRY_DSN` | `https://...@sentry.io/...` | Optional: capture unhandled exceptions / rejected promises |
| `LOG_LEVEL` | `info` | Optional: adjust verbosity (`info`, `warn`, `error`, `debug`) |

**Start command on Railway**: `npm run server`

The backend automatically provisions `/uploads` and `/backend/data` directories; ensure Railway file storage (persistent disk) is enabled so avatars and derived documents survive deploys.

### Frontend (Vercel)

| Variable | Sample | Notes |
| --- | --- | --- |
| `VITE_API_URL` | `https://railway-app-url.up.railway.app` | Base URL for backend API |
| `VITE_APP_BASE` | `/grantflow` | Ensures Router, assets, and smoke tests resolve correctly |
| `VITE_AUTH_DEFAULT_METHOD` *(optional)* | `email` | Force default auth tab if you do not want the persisted preference |

**Build command**: `npm run build`  
**Output directory**: `dist`  
**Install command**: `npm install`

If using Vercel preview deployments, remember to set `VITE_API_URL` to your staging backend or proxy via Vercel rewrites.

---

## 3. Backend Deployment (Railway)

1. **Create a new Railway project** and provision a “Node.js” service.
2. **Attach persistent storage** (SQLite lives at `backend/data` + `/uploads`).
3. **Set environment variables** listed above.
4. **Deploy from GitHub** (`buckeye7066/grantflow`, branch `main`) or push a Railway-specific branch.
5. **Confirm build & start** succeed:
   - Logs should show `Database schema initialized`.
   - Hit `/api/health` and expect `{"status":"ok"}`.
6. **Seed critical data**:
   - Generate the curated SQLite seed directly on the persistent volume:
     ```bash
     railway run DB_PATH=/mnt/data/grantflow.db FORCE=true npm run seed:db
     railway run DB_PATH=/mnt/data/grantflow.db npm run seed:profiles -- --force
     railway run DB_PATH=/mnt/data/grantflow.db npm run check:profiles
     ```
   - (Optional) mirror any required media assets: `railway run rsync -av backend/uploads/ /mnt/data/uploads/`
   - Restart the service so the new database is picked up.
   - `/api/profiles?status=active` should return the 11 curated profiles with all sections populated.
   - Upload the onboarding clip (`Grant Flow_ Get Started.mp4`) to your static host or CDN and verify the dashboard link.
   - If you plan to bundle the video with the frontend, drop your final file into `public/Grant Flow_ Get Started.mp4` **before** running `npm run build`. Vite will copy it verbatim so the dashboard CTA resolves without extra configuration.

---

## 4. Frontend Deployment (Vercel)

1. **Import the GitHub repository** into Vercel.
2. **Set build settings**:
   - Framework: “Vite”
   - Build command: `npm run build`
   - Output directory: `dist`
   - Root directory: (leave blank)
3. **Environment variables**: `VITE_API_URL`, `VITE_APP_BASE=/grantflow`.
4. **Custom domain**: `www.axiombiolabs.org/grantflow`
5. **Redeploy**. After the build, verify the app at `https://www.axiombiolabs.org/grantflow/`.
6. **Set the base path**:
   - In `vercel.json` (if using), ensure rewrites handle `/grantflow/api/* → backend`.
   - Otherwise, configure Vercel project rewrites:
     ```
     {
       "source": "/grantflow/api/(.*)",
       "destination": "https://<railway-app>.up.railway.app/api/$1"
     }
     ```

---

## 5. Quality Assurance Checklist

| Area | Steps |
| --- | --- |
| **Smoke Tests** | `npm run lint`, `node scripts/smoke-auth-callback.mjs`, optionally Playwright flows for login and key dashboards |
| **Authentication** | Test email OTP, SMS OTP, Google, Facebook, Yahoo logins. Confirm session persistence + refresh tokens. |
| **Authorization** | Validate admin can view all profiles, regular users scoped to their data. Ensure the 11 foundational profiles contain all required fields and can be edited. |
| **Crawlers** | Queue each crawler type (`local`, `scholarship`, `comprehensive`, `item_search`, `document_ingest`, `profile_enrichment`, `pipeline_automation`, `avatar_lookup`) and confirm job metrics in Automation dashboard. |
| **Documents** | Upload sample files (PDF, DOCX, JPG), ensure parsing populates profile sections and stored documents render. |
| **Billing** | Adjust tiers, apply student/minister discounts, toggle pro bono flag, confirm audit log entries. |
| **Dashboards** | Verify organization count masking (3144 for non-admins), funds acquired card, pipeline totals, Urgent Deadlines, reminders, and automation metrics. |
| **Accessibility / UX** | Check login page, session modal, and navigation for keyboard access & tab order. |
| **Anya Copilot** | Confirm chat boots, code search tool runs end-to-end with results logged in-thread, and profile scoping holds. |

---

## 6. Monitoring & Ops

| Task | Notes |
| --- | --- |
| **Railway logs** | `railway logs` or dashboard tail; establish alerts for crashes. |
| **OpenAI usage** | Track through OpenAI dashboard; set billing caps. |
| **Twilio quota** | Monitor message usage; ensure production numbers are verified. |
| **Crawler load** | The `Automation` page surfaces job metrics; investigate spikes in `failed` count quickly. |
| **Document storage** | Ensure Railway persistent disk has headroom for `/uploads`. |

Add incident response runbooks as the team scales. At minimum, document how to rotate secrets (OpenAI, Twilio, OAuth providers) and how to flush/reseed the SQLite DB if corruption is detected.

---

## 7. Rollback Strategy

1. Keep previous Vercel deployments promoted for one-click rollback.
2. On Railway, use the “Deployments” tab to redeploy a prior build or redeploy locally built image (`railway up`).
3. Maintain scheduled backups of the SQLite database (Railway persistent volume). Store nightly snapshots in S3 or another secure bucket.

---

## 8. Launch Checklist

- [ ] Environment variables validated in both Vercel and Railway
- [ ] `npm run lint` and smoke tests green
- [ ] 11 baseline profiles populated with complete data sets
- [ ] Admin vs user access tested
- [ ] Document ingestion + AI enrichment verified
- [ ] Crawlers produce match reasons and job metrics
- [ ] Billing tiers configured; overrides tested
- [ ] Anya copilot chat + tooling responding successfully (code search, grant insights when enabled)
- [ ] Manual QA across dashboards/pipeline/documents complete
- [ ] Monitoring/alerting configured (logs, OpenAI, Twilio)
- [ ] Backup plan documented

Once all boxes are checked, promote the Vercel production deployment, confirm DNS routes `www.axiombiolabs.org/grantflow` to the new build, and your GrantFlow instance is production-ready. 🎉

