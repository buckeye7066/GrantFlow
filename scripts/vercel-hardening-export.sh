#!/usr/bin/env bash
set -euo pipefail

node scripts/prepare-global-hardening-run.mjs
node scripts/apply-code-hardening.mjs
node scripts/apply-readiness-deployment.mjs
npm run release:gates

git diff --name-status > dist/hardening-manifest.txt

tar -czf dist/hardening-output.tar.gz \
  .env.example \
  backend/.env.example \
  backend/env.example \
  backend/services/missionHealthService.js \
  tests/mission/mission-health-dashboard.test.mjs \
  backend/crawler-os/safeUrl.js \
  backend/crawler-os/fetcher.js \
  backend/crawler-os/tests/fetcher.test.mjs \
  backend/routes/ai.js \
  backend/start.js \
  backend/middleware/pipelineMonitor.js \
  backend/routes/admin.js \
  backend/routes/health.js \
  backend/services/productionReadinessChecks.js \
  scripts/check-deployment-config.mjs \
  src/config/env.js \
  backend/middleware/apiRateLimitPolicy.js \
  backend/routes/smsInbound.js \
  backend/services/twilioWebhookSecurity.js \
  backend/utils/runtimeSecrets.js \
  backend/utils/safeRemoteFetch.js \
  api/preview-backend-disabled.js \
  tests/unit/api-rate-limit-policy.test.mjs \
  tests/unit/deployment-preview-isolation.test.mjs \
  tests/unit/production-readiness-hardening.test.mjs \
  tests/unit/runtime-secrets-hardening.test.mjs \
  tests/unit/safe-remote-fetch.test.mjs \
  tests/unit/sms-inbound-security.test.mjs \
  tests/unit/start-single-migration-owner.test.mjs \
  vercel.json
