# GrantFlow Repository

This repo now contains the **complete GrantFlow stack** as exported from Base44:

- `functions/` — All Deno backend functions (cleaned and production-ready)
- `frontend/` — Full React/Vite application implementing the dashboard, pipeline, profile management, analytics, automation control panels, and 200+ UI components.
- `exportFromBase44.js` — Script for pulling future function updates from Base44.

---

## Prerequisites

- Node.js 20+ (for the frontend)
- npm (ships with Node) or your package manager of choice
- Deno 2.x (for local function testing, optional unless you’re editing backend code)
- Git

---

## Project Layout

```text
GrantFlow/
├── frontend/                # React + Vite codebase
│   ├── src/
│   │   ├── pages/           # 40+ flat route components (Dashboard, Pipeline, etc.)
│   │   ├── components/      # Large component library (pipeline, organizations, UI primitives...)
│   │   ├── api/             # Base44 SDK wrappers
│   │   └── ...              # hooks, utils, styles
│   ├── package.json         # Frontend dependencies & scripts
│   ├── vite.config.js       # Vite config with alias setup
│   ├── tailwind.config.js   # Tailwind/shadcn configuration
│   └── eslint.config.js     # Extended lint rules
├── functions/               # Deno serverless functions
│   ├── _shared/             # Shared utilities (security, matching engine, atomic locks, AI helpers)
│   ├── _utils/              # Common helper modules
│   └── *.js                 # Individual Base44 functions
└── exportFromBase44.js      # Optional script to re-export functions from Base44
```

---

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

This launches Vite (default: <http://localhost:5173>). The codebase already uses the Base44 SDK wrappers under `src/api/`. To connect to a live Base44 environment, provide the expected credentials via environment variables (see below).

### Useful scripts

- `npm run dev` — Start development server (with hot module reload)
- `npm run build` — Production build
- `npm run preview` — Preview the production build locally
- `npm run lint` — Run ESLint across the frontend

---

## Backend Functions

The `functions/` directory contains the production-ready Deno functions. They are designed to be deployed via Base44’s serverless infrastructure. If you want to run local validation:

```bash
deno check functions/<function>.js
deno lint functions/<function>.js
```

Most functions rely on Base44’s runtime (environment variables, auth context, etc.), so they aren’t meant to run standalone without the platform. Use the `exportFromBase44.js` script to refresh functions from Base44 when needed.

---

## Environment Variables

The frontend expects Base44 credentials, typically configured via Vite environment files. Create `frontend/.env.local` (never commit it) with values similar to:

```env
VITE_BASE44_PROJECT_URL=https://your-project.base44.com
VITE_BASE44_ANON_KEY=...
```

If additional keys are required (service role tokens, etc.), mirror the values used in Base44’s dashboard.

---

## Testing & QA

- **Frontend linting:** `npm run lint` (under `frontend/`)
- **Frontend type checks:** Vite + ESLint handle JSX/TSX validation automatically; optional to add TypeScript in the future.
- **Backend linting:** `deno lint functions`
- **Backend type checks:** `deno check functions/<name>.js`
- **Pipeline integrity:** Use the `removeMismatchedPipelineGrants` function (dry-run mode available) to purge stale grants from queues.

---

## Next Steps

1. Configure `.env.local` with Base44 credentials so the frontend can authenticate.
2. Optional: Add root-level scripts for convenience, e.g. `npm run frontend` (dev server) and `npm run functions:check` (deno lint/check) via a top-level `package.json`.
3. Update this README with any deployment steps once you integrate with your hosting platform (Netlify, Vercel, Base44, etc.).
4. Consider automating the `exportFromBase44.js` script (GitHub Action or manual run) to keep backend functions synchronized.

With the frontend imported and backend functions cleaned up, you now have a full local copy of the GrantFlow platform ready for continued development. Let me know if you’d like scaffolding for deployment scripts or additional tooling. 

