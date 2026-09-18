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
      "if ($secure.Length -ne $fixture.Length) { throw 'Fixture roundtrip failed' }",
    ].join('\n')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, GF_DPAPI_TEST_DIR: dir }, encoding: 'utf8', windowsHide: true, timeout: 15000,
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'PowerShell fixture failed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
