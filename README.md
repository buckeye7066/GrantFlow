# GrantFlow Repository

This repository is being converted into a **self-hosted GrantFlow platform**.  
The legacy Base44 exports are still present (`functions/` and `exportFromBase44.js`), but the new stack lives in a monorepo that you fully control.

---

## Prerequisites

- Node.js 20+ (install [pnpm](https://pnpm.io/) via `corepack enable pnpm`)
- Docker Desktop (for local Postgres/Redis; optional but recommended)
- Deno 2.x (only required if you continue to work with the legacy Base44 functions)
- Git

---

## Project Layout

```text
GrantFlow/
├── apps/
│   ├── api/                 # Node.js (Express + tRPC) backend
│   └── web/                 # React/Vite frontend (imported from Base44)
├── jobs/
│   ├── crawler-worker/      # BullMQ worker for grant processing
│   └── scheduler/           # Cron-style orchestrator (node-cron)
├── packages/
│   ├── prisma/              # Prisma schema + client wrapper
│   ├── match-engine/        # AI-driven matching service (OpenAI)
│   └── crawler-runtime/     # Shared crawler strategy utilities
├── docker/                  # docker-compose, NGINX reverse proxy
├── functions/               # Legacy Base44 Deno functions (read-only)
└── exportFromBase44.js      # Legacy helper script
```

---

## Getting Started

1. **Install dependencies**
   ```bash
   corepack enable pnpm
   pnpm install
   ```

2. **Set environment files**
   ```bash
   cp apps/api/env.sample apps/api/.env
   cp packages/prisma/env.sample packages/prisma/.env
   # fill in DATABASE_URL, REDIS_URL, OPENAI_API_KEY, JWT_SECRET
   ```

3. **Run local database (optional)**
   ```bash
   docker compose -f docker/docker-compose.yml up -d postgres redis
   ```

4. **Apply Prisma migrations**
   ```bash
   pnpm prisma:migrate
   pnpm prisma:generate
   ```

5. **Start services**
   ```bash
   pnpm dev:api        # http://localhost:4000 (tRPC router)
   pnpm dev:web        # http://localhost:5173 (Vite dev server)
   pnpm dev:crawler    # background worker consuming BullMQ jobs
   ```

---

## Environment Variables

| Location                     | Variables                                                                        |
|-----------------------------|----------------------------------------------------------------------------------|
| `apps/api/.env`             | `DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY`, `JWT_SECRET`                      |
| `packages/prisma/.env`      | `DATABASE_URL`                                                                   |
| `apps/web/.env.local` (new) | `VITE_API_URL`, `VITE_OPENAI_PROXY` (if needed)                                  |
| jobs                        | inherit from API environment (`OPENAI_API_KEY`, `REDIS_URL`, `DATABASE_URL`)     |

---

## Docker Deployment (self-hosted)

The `docker/docker-compose.yml` file provisions:

- Postgres 16
- Redis 7
- API container
- Crawler worker
- Scheduler
- Web build (Vite) served behind NGINX reverse proxy

Steps:

```bash
cd docker
OPENAI_API_KEY=... JWT_SECRET=... docker compose up -d
```

Point DNS:

- `grantflow.axiombiolabs.org` → host IP (served by NGINX → web)
- `api.axiombiolabs.org` → host IP (served by NGINX → API)

Provide TLS certs in `docker/certs/` (e.g., Let’s Encrypt `fullchain.pem` and `privkey.pem`).

---

## Testing & QA

- **Frontend:** `pnpm --filter @grantflow/web lint`
- **API:** `pnpm --filter @grantflow/api lint`
- **Prisma:** `pnpm prisma:migrate` / `pnpm prisma:generate`
- **Workers:** run BullMQ queues locally (`pnpm dev:crawler`)
- The legacy Deno functions remain in `functions/` for reference—use `deno lint` / `deno check` if needed.

---

## Next Steps

1. **Replace Base44 SDK usage** inside `apps/web` with calls to the new tRPC API.
2. **Import existing Base44 data** into Postgres using Prisma scripts.
3. **Expand the crawler runtime** with real web-scraping + LLM calls.
4. **Implement authentication** (JWT/session) in `apps/api`.
5. **Retire the legacy `functions/` directory** once the new backend covers all features.

With this structure, GrantFlow can run entirely on your own infrastructure, with full transparency and control over logs, runtime, and database access. Let me know when you want help wiring the frontend to the new API or setting up CI/CD for your self-hosted environment.
