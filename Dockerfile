# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for GrantFlow (Vite + Express hybrid)
# Private CPU-only fallback, pinned engine and immutable model manifest.
# Only CPU libraries and the verified local weights enter the final runtime.
FROM ollama/ollama:0.34.2 AS local-model-assets
ENV OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NO_CLOUD=1 OLLAMA_MODELS=/opt/grantflow-models
RUN set -eu; \
    ollama serve >/tmp/model-build.log 2>&1 & model_pid=$!; \
    trap 'kill "$model_pid" 2>/dev/null || true' EXIT; \
    for attempt in 1 2 3 4 5 6 7 8 9 10; do ollama list >/dev/null 2>&1 && break; sleep 1; done; \
    ollama pull llama3.2:1b; \
    echo 'baf6a787fdffd633537aa2eb51cfd54cb93ff08e28040095462bb63daf552878  /opt/grantflow-models/manifests/registry.ollama.ai/library/llama3.2/1b' | sha256sum -c -; \
    ollama show --license llama3.2:1b > /opt/grantflow-model-license.txt; \
    timeout 90 ollama run llama3.2:1b 'Reply with the word READY.' >/tmp/model-proof.txt; \
    test -s /tmp/model-proof.txt
RUN rm -rf /usr/lib/ollama/cuda_v12 /usr/lib/ollama/cuda_v13 /usr/lib/ollama/vulkan /usr/lib/ollama/rocm_v7_2 /usr/lib/ollama/mlx_cuda_v13

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
# (backend/services/ops/databaseBackup.js â†’ backupPostgres, `pg_dump -Fc`).
# WHY THE PGDG REPO, NOT STOCK postgresql-client: the prod Postgres server is
# v17, and pg_dump REFUSES to dump a server newer than itself â€” Debian bookworm's
# stock postgresql-client is v15, so a plain install would put a v15 pg_dump on
# PATH that aborts with "server version mismatch" (the ENOENT JSON fallback never
# fires, because the binary DOES exist). Pulling postgresql-client-17 from apt.postgresql.org
# guarantees a client >= the server. The postgresql-client-common wrapper makes
# bare `pg_dump` on PATH dispatch to the highest installed major (17), which is
# exactly what databaseBackup.js spawns. Codename read from /etc/os-release so a
# future base-image bump keeps pulling the right suite.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg git \
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
# automation to run. Adds ~300MB â€” the cost of in-image browser automation.
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

COPY --from=local-model-assets /bin/ollama /usr/bin/ollama
COPY --from=local-model-assets /usr/lib/ollama /usr/lib/ollama
COPY --from=local-model-assets /opt/grantflow-models /opt/grantflow-models
COPY --from=local-model-assets /opt/grantflow-model-license.txt /app/local-model-license.txt

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/qa ./qa

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
