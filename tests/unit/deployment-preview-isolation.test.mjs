import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('Vercel production rewrites are host-gated and previews fail closed', () => {
  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))
  const production = config.rewrites.filter((rule) =>
    String(rule.destination || '').includes('grantflow-production.up.railway.app'),
  )
  assert.equal(production.length, 4)
  for (const rule of production) {
    assert.ok(rule.has?.some((condition) =>
      condition.type === 'host' && /axiombiolabs/i.test(String(condition.value)),
    ))
  }
  assert.ok(config.rewrites.some((rule) =>
    rule.source === '/grantflow/api/:path*' &&
    rule.destination === '/api/preview-backend-disabled',
  ))
  assert.equal(config.installCommand, 'npm ci --include=dev --include=optional')
})
