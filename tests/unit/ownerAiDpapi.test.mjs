import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('installed DPAPI token survives the newline written by Set-Content', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('../../tools/owner-ai/manage.ps1', import.meta.url), 'utf8')
  const readLine = source.split(/\r?\n/).find(line => line.trim().startsWith('$secure ='))
  assert.ok(readLine, 'Run must read the installed encrypted token')
  const dir = mkdtempSync(path.join(tmpdir(), 'grantflow-dpapi-test-'))
  try {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$secretPath = Join-Path $env:GF_DPAPI_TEST_DIR 'fixture.dpapi'",
      "$fixture = ConvertTo-SecureString 'synthetic-fixture-value-never-a-real-token' -AsPlainText -Force",
      '$fixture | ConvertFrom-SecureString | Set-Content -LiteralPath $secretPath',
      readLine,
      "if ([System.Net.NetworkCredential]::new('', $secure).Password -cne 'synthetic-fixture-value-never-a-real-token') { throw 'Fixture roundtrip failed' }",
    ].join('\n')
    // GitHub's pwsh host exports its incompatible v7 module paths to Windows PowerShell 5.
    // Let the native child reconstruct its own built-in module search paths.
    const env = { ...process.env, GF_DPAPI_TEST_DIR: dir }
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env, encoding: 'utf8', windowsHide: true, timeout: 15000,
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'PowerShell fixture failed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Windows CI executes the native DPAPI roundtrip regression', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const windows = workflow.split('  windows-build:')[1]?.split('  postgres-migrations:')[0]
  assert.ok(windows?.includes('node --test tests/unit/ownerAiDpapi.test.mjs'))
})
