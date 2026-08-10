import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const sourcePath = 'scripts/one-shot-grantflow-avatar-hardening.mjs'
const temporaryPath = 'scripts/.one-shot-grantflow-avatar-hardening.patched.mjs'
let source = fs.readFileSync(sourcePath, 'utf8')

function replaceExactlyOnce(needle, replacement, label) {
  const first = source.indexOf(needle)
  if (first === -1) throw new Error(`[${label}] patch target not found`)
  if (source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`[${label}] patch target was not unique`)
  }
  source = source.slice(0, first) + replacement + source.slice(first + needle.length)
}

replaceExactlyOnce(
  "    `  const host = parsed.hostname.toLowerCase().replace(/^\\\\[|\\\\]$/g, '')\n  if (SSRF_BLOCKED_HOSTS.has(host)) return { ok: false, reason: \\\`blocked_host:\\\${host}\\\` }\n`,",
  "    `  const host = parsed.hostname.toLowerCase().replace(/^\\\\[|\\\\]$/g, '')\n  if (SSRF_BLOCKED_HOSTS.has(host)) {\n    throw new SsrfBlockedError(\\\`blocked_host:\\\${host}\\\`, url)\n  }\n`,",
  'actual-safe-fetch-host-marker',
)

replaceExactlyOnce(
  "  if (SSRF_BLOCKED_HOSTS.has(host) && !allowTestLoopback) {\n    return { ok: false, reason: \\\`blocked_host:\\\${host}\\\` }\n  }",
  "  if (SSRF_BLOCKED_HOSTS.has(host) && !allowTestLoopback) {\n    throw new SsrfBlockedError(\\\`blocked_host:\\\${host}\\\`, url)\n  }",
  'safe-fetch-host-replacement-must-throw',
)

fs.writeFileSync(temporaryPath, source, 'utf8')
try {
  await import(pathToFileURL(`${process.cwd()}/${temporaryPath}`).href)
} finally {
  fs.rmSync(temporaryPath, { force: true })
}
