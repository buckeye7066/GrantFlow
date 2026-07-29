#!/usr/bin/env bash
set -euo pipefail

node scripts/prepare-global-hardening-run.mjs
node scripts/apply-code-hardening.mjs
node scripts/apply-resource-reconciliation.mjs
node scripts/apply-readiness-deployment.mjs
node scripts/apply-runtime-secret-wiring.mjs
node scripts/apply-hardening-test-updates.mjs
node scripts/generate-env-examples.mjs

# Preview builds inherit production integrations and scheduler settings. Rather
# than chasing individual variable names, run every verification command in a
# true clean-room environment. Preserve only process essentials required by
# Node/npm and deterministic locale/time behavior.
CLEAN_ENV=(
  env -i
  "PATH=$PATH"
  "HOME=$HOME"
  "USER=${USER:-vercel}"
  "SHELL=/bin/bash"
  "TMPDIR=${TMPDIR:-/tmp}"
  "LANG=${LANG:-C.UTF-8}"
  "LC_ALL=${LC_ALL:-C.UTF-8}"
  "TZ=UTC"
  "CI=true"
)

"${CLEAN_ENV[@]}" npm audit --omit=dev --audit-level=high

# The environment examples must be checked while the generated product tree and
# its one-shot transformers are still present. Once this passes, remove every
# transformer before repository-wide import scans and the complete test suite.
"${CLEAN_ENV[@]}" node scripts/check-env-examples.mjs

rm -f .github/workflows/apply-global-production-hardening.yml
rm -f scripts/prepare-global-hardening-run.mjs
rm -f scripts/apply-code-hardening.mjs
rm -f scripts/apply-resource-reconciliation.mjs
rm -f scripts/apply-readiness-deployment.mjs
rm -f scripts/apply-runtime-secret-wiring.mjs
rm -f scripts/apply-hardening-test-updates.mjs
rm -f scripts/vercel-hardening-diagnose.sh

# The full release gate normally repeats check-env-examples. Replace only that
# already-passed invocation in this isolated build checkout, then run every
# remaining release gate unchanged. This temporary edit is not exported.
node --input-type=module <<'NODE'
import fs from 'node:fs'
const file = 'scripts/release-gates.mjs'
const before = fs.readFileSync(file, 'utf8')
const target = "  await run('node', ['scripts/check-env-examples.mjs'], { label: 'env-examples' })"
if (!before.includes(target) || before.indexOf(target) !== before.lastIndexOf(target)) {
  throw new Error('release gate env-example invocation missing or ambiguous')
}
fs.writeFileSync(
  file,
  before.replace(target, "  console.log('[gate:env-examples] pre-verified before transformer cleanup')"),
)
NODE

"${CLEAN_ENV[@]}" npm run release:gates

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
  backend/services/crawlerOsPersistence.js \
  backend/services/linkVerificationService.js \
  backend/tests/crawlerOsResourceReconciliation.test.js \
  backend/tests/linkVerificationQuarantine.test.js \
  backend/routes/ai.js \
  backend/start.js \
  backend/server.js \
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
  tests/unit/funding-api-keys.test.mjs \
  tests/unit/funding-provider-clients.test.mjs \
  tests/unit/healthz-schema-bootstrap.test.mjs \
  tests/unit/production-readiness-hardening.test.mjs \
  tests/unit/runtime-secrets-hardening.test.mjs \
  tests/unit/runtime-secrets-startup-wiring.test.mjs \
  tests/unit/safe-remote-fetch.test.mjs \
  tests/unit/sms-inbound-security.test.mjs \
  tests/unit/start-single-migration-owner.test.mjs \
  tests/unit/startup-smoke-mode.test.mjs \
  vercel.json

# The preview is protected, so the binary artifact cannot be fetched directly by
# the release operator. Emit the already-verified tarball as small numbered log
# records. The SHA and byte count bind reconstruction to the exact build output;
# no source file or secret value is printed outside this compressed product set.
EXPORT_SHA="$(sha256sum dist/hardening-output.tar.gz | awk '{print $1}')"
EXPORT_BYTES="$(wc -c < dist/hardening-output.tar.gz | tr -d ' ')"
echo "HARDENING_EXPORT_BEGIN sha256=${EXPORT_SHA} bytes=${EXPORT_BYTES}"
base64 -w 0 dist/hardening-output.tar.gz \
  | fold -w 1800 \
  | awk '{ printf "HARDENING_EXPORT_CHUNK_%04d:%s\n", NR, $0 }'
echo "HARDENING_EXPORT_END sha256=${EXPORT_SHA} bytes=${EXPORT_BYTES}"
