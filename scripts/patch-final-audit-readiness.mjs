import fs from 'node:fs'

const file = 'scripts/vercel-final-authenticated-audit.mjs'
let source = fs.readFileSync(file, 'utf8')

if (!source.includes("const BACKEND_URL = 'https://grantflow-production.up.railway.app'")) {
  source = source.replace(
    "const BASE_URL = 'https://app.axiombiolabs.org'\n",
    "const BASE_URL = 'https://app.axiombiolabs.org'\nconst BACKEND_URL = 'https://grantflow-production.up.railway.app'\n",
  )
}

if (!source.includes('const targetUrl = /^https?:\\/\\//i.test(pathname)')) {
  source = source.replace(
    '    const response = await fetch(`${BASE_URL}${pathname}`, {',
    "    const targetUrl = /^https?:\\/\\//i.test(pathname) ? pathname : `${BASE_URL}${pathname}`\n    const response = await fetch(targetUrl, {",
  )
}

source = source.replace(
  '    requestJson(`/readyz?fresh=${fresh}`),',
  '    requestJson(`${BACKEND_URL}/readyz?fresh=${fresh}`),',
)

if (!source.includes("requestJson(`${BACKEND_URL}/readyz?fresh=${fresh}`)")) {
  throw new Error('final audit Railway readiness patch did not apply')
}

fs.writeFileSync(file, source)
console.log('[final-audit-readiness] direct Railway readiness check applied')
