# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for GrantFlow (Vite + Express hybrid)
# Stage 1: Build stage
FROM node:20-slim AS builder

# Set working directory
WORKDIR /app

# Build deps for native modules (node-gyp: better-sqlite3, etc.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install ALL deps (incl dev) for build. Use lockfile.
RUN npm ci --legacy-peer-deps

# Copy all source files
COPY . .

# Build Vite frontend to dist/
RUN npm run build

# Remove devDependencies so runtime image doesn't ship them
RUN npm prune --omit=dev

# Stage 2: Production stage
FROM node:20-slim

# Set working directory
WORKDIR /app

# Runtime deps for document ingestion:
# - poppler-utils: pdftoppm/pdftotext (PDF raster + extraction)
# - tesseract-ocr: OCR engine for scanned documents
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

# Copy ONLY production dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Hamilton browser automation (HAMILTON_ENABLE_BROWSER_AUTOMATION): install the
# chromium browser Playwright drives, plus its OS shared-library dependencies.
# `playwright` is a production dependency (above), so node_modules already ships
# the client; this downloads the matching browser build into a fixed path. The
# code in hamiltonAutopilotEngine.js calls chromium.executablePath() and falls
# back to a `no_browser` blocker when this is absent, so the image MUST carry it
# for automation to run. Adds ~300MB — the cost of in-image browser automation.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node node_modules/playwright/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

# Copy backend code
COPY --from=builder /app/backend ./backend

# Copy `shared/` — backend re-exports from it (e.g.
# `backend/utils/profileSuggestionGuards.js` -> `shared/profileSuggestionGuards.js`).
# Without this, the container crashes at boot with ERR_MODULE_NOT_FOUND and
# Railway silently keeps serving the previous deployment.
COPY --from=builder /app/shared ./shared

# Copy `src/config/` — `shared/` transitively imports `src/config/sectionMetadata.js`
# (and other config modules) at runtime. We deliberately copy only `src/config/`
# (not the entire frontend `src/`) to keep the runtime image small while still
# satisfying every transitive backend import.
COPY --from=builder /app/src/config ./src/config

# Copy seed data needed for admin maintenance operations (e.g., baseline profile seeding)
COPY seed ./seed

# Copy built frontend assets from builder stage
COPY --from=builder /app/dist ./dist

# Copy package manifests so runtime has /app/package.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Expose port (Railway will set PORT env var)
EXPOSE 8080

# Liveness check on /healthz endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/healthz', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the Express server
CMD ["node", "backend/start.js"]
