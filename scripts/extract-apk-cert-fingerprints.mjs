import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SIGNER_SHA256_LINE =
  /^Signer(?: #\d+| \([^\r\n]*\)) certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/i

export function extractApkSignerSha256Digests(output) {
  return [...new Set(
    String(output || '')
      .split(/\r?\n/)
      .map((line) => line.match(SIGNER_SHA256_LINE)?.[1])
      .filter(Boolean)
      .map((digest) => digest.replaceAll(':', '').toLowerCase()),
  )]
}

async function main() {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk

  const digests = extractApkSignerSha256Digests(input)
  if (digests.length === 0) {
    throw new Error('apksigner output did not contain a recognized signer SHA-256 digest')
  }
  process.stdout.write(`${digests.join('\n')}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[apk-cert] ${error?.message || error}`)
    process.exitCode = 1
  })
}
