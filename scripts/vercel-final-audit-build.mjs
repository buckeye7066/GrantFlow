import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${args.join(' ')} exited ${result.status}`)
  }
  return Number(result.status || 0)
}

run(['scripts/patch-final-audit-readiness.mjs'])
run(['scripts/patch-final-audit-session.mjs'])
run(['scripts/production-audit/redact.mjs', '--self-test'])
run(['scripts/production-audit/policy.test.mjs'])
run(['scripts/production-audit/validate-artifact.mjs', '--self-test'])
const status = run(['scripts/vercel-final-authenticated-audit.mjs'], { allowFailure: true })
if (status !== 0) {
  try {
    process.stdout.write(fs.readFileSync('audit-dist/final-audit.json', 'utf8'))
  } catch {
    console.error('[final-audit-build] sanitized evidence file was not created')
  }
  process.exitCode = status
}
