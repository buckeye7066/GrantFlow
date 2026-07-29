# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for GrantFlow (Vite + Express hybrid)
# Stage 1: Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Build deps for native modules (node-gyp: better-sqlite3, etc.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# The source materializer is copied later with the source tree. Skip the npm
# lifecycle hook during dependency installation, then run it explicitly once the
# complete repository is present. Native dependency install scripts still run.
RUN GRANTFLOW_SKIP_SOURCE_MATERIALIZATION=1 \
  npm ci --include=dev --include=optional --legacy-peer-deps

COPY . .

# Materialize and verify the exact product tree that passed the clean-room gate.
# Generator inputs delete themselves before the build and never reach runtime.
RUN node scripts/materialize-production-source.mjs

RUN npm run build

# Remove devDependencies so runtime image doesn't ship them
RUN npm prune --omit=dev

# Stage 2: Production stage
FROM node:20-slim

WORKDIR /app

# Runtime deps for document ingestion:
# - poppler-utils: pdftoppm/pdftotext (PDF raster + extraction)
# - tesseract-ocr: OCR engine for scanned documents
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
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
