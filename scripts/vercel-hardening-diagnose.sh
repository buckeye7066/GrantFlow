#!/usr/bin/env bash
set -euo pipefail

node scripts/prepare-global-hardening-run.mjs
node scripts/apply-code-hardening.mjs
node scripts/apply-readiness-deployment.mjs
node scripts/generate-env-examples.mjs

node --test tests/unit/anya-tools.test.mjs
node --test tests/unit/auth-access-check.test.mjs
node --test tests/unit/auth-email-otp.test.mjs
node --test tests/unit/auth-email-production-503.test.mjs

npm exec -- vitest run tests/unit/api-rate-limit-policy.test.mjs tests/unit/production-readiness-hardening.test.mjs --reporter=verbose
npm run build
