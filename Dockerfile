# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for GrantFlow (Vite + Express hybrid)
# Stage 1: Build stage
FROM node:24.19.0-slim AS builder

WORKDIR /app

# Build deps for native modules (node-gyp: better-sqlite3, etc.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --include=dev --include=optional --legacy-peer-deps

COPY . .

# The production Docker runtime stage copies only product/runtime files, so
# build-only scripts and tests never ship in the final image.
RUN npm run build

# Remove devDependencies so runtime image doesn't ship them
RUN npm prune --omit=dev

# Stage 2: Production stage
FROM node:24.19.0-slim

# Explicit deployment origins, never a wildcard. Operators can override this
# list at runtime; an explicitly empty override still fails startup validation.
ENV CORS_ORIGIN=https://grant-flow-three.vercel.app,https://app.axiombiolabs.org,https://grantflow.axiombiolabs.org

WORKDIR /app

# Runtime deps for document ingestion:
# - poppler-utils: pdftoppm/pdftotext (PDF raster + extraction)
# - tesseract-ocr: OCR engine for scanned documents
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

# postgresql-client-17: provides `pg_dump` for the verified DB backup
# (backend/services/ops/databaseBackup.js → backupPostgres, `pg_dump -Fc`).
# WHY THE PGDG REPO, NOT STOCK postgresql-client: the prod Postgres server is
# v17, and pg_dump REFUSES to dump a server newer than itself — Debian bookworm's
# stock postgresql-client is v15, so a plain install would put a v15 pg_dump on
# PATH that aborts with "server version mismatch" (the ENOENT JSON fallback never
# fires, because the binary DOES exist). Pulling postgresql-client-17 from apt.postgresql.org
# guarantees a client >= the server. The postgresql-client-common wrapper makes
# bare `pg_dump` on PATH dispatch to the highest installed major (17), which is
# exactly what databaseBackup.js spawns. Codename read from /etc/os-release so a
# future base-image bump keeps pulling the right suite.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

# Hamilton browser automation (HAMILTON_ENABLE_BROWSER_AUTOMATION): install the
# chromium browser Playwright drives, plus its OS shared-library dependencies.
# `playwright` is a production dependency, so node_modules ships the client;
# this downloads the matching browser build into a fixed path. The code in
# hamiltonAutopilotEngine.js calls chromium.executablePath() and falls back to
# a `no_browser` blocker when this is absent, so the image MUST carry it for
# automation to run. Adds ~300MB — the cost of in-image browser automation.
#
# Layer-cache hygiene: we deliberately COPY only the playwright client packages
# (not the whole node_modules) before running the browser install, so this
# ~300MB layer is keyed to the playwright VERSION and survives unrelated
# lockfile changes. cli.js only requires its sibling playwright-core.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=builder /app/node_modules/playwright /tmp/pw/node_modules/playwright
COPY --from=builder /app/node_modules/playwright-core /tmp/pw/node_modules/playwright-core
RUN node /tmp/pw/node_modules/playwright/cli.js install --with-deps chromium \
  && rm -rf /tmp/pw /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend ./backend

# Backend runtime imports shared modules and selected frontend configuration.
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/src/config ./src/config

COPY seed ./seed
COPY --from=builder /app/docs/Payment_sheet_Grantflow_2026-06-15_EXTRACT.md ./docs/Payment_sheet_Grantflow_2026-06-15_EXTRACT.md
COPY --from=builder /app/docs/production-readiness/grantflow.md ./docs/production-readiness/grantflow.md
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

RUN mkdir -p /app/data /app/uploads \
  && chown -R node:node /app/data /app/uploads
# Production must set UPLOADS_DIR to a mounted persistent volume (Railway: /data/uploads).
COPY docker-entrypoint.sh /usr/local/bin/grantflow-entrypoint
RUN chmod +x /usr/local/bin/grantflow-entrypoint
ENTRYPOINT ["grantflow-entrypoint"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/healthz', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "backend/start.js"]
