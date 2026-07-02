/**
 * anyaCodeFixDispatch — the programmatic trigger for the agent code-fix loop
 * (patch → anya-code-fix-pr.yml → release gates → PR → CI-gated auto-merge).
 * These tests never touch the network: fetch is injected.
 */
import { describe, it, expect } from 'vitest'
import {
  dispatchCodeFixWorkflow,
  extractPatchPaths,
  validatePatchForDispatch,
  FORBIDDEN_PATCH_PATH_PATTERNS,
  __testing__,
} from '../services/anyaCodeFixDispatch.js'

const GOOD_PATCH = [
  'diff --git a/backend/services/example.js b/backend/services/example.js',
  'index 1111111..2222222 100644',
  '--- a/backend/services/example.js',
  '+++ b/backend/services/example.js',
  '@@ -1,3 +1,3 @@',
  '-const x = 1',
  '+const x = 2',
  '',
].join('\n')

describe('extractPatchPaths', () => {
  it('reads paths from diff --git and ---/+++ headers', () => {
    expect(extractPatchPaths(GOOD_PATCH)).toContain('backend/services/example.js')
  })
})

describe('validatePatchForDispatch', () => {
  it('rejects empty and non-diff input', () => {
    expect(validatePatchForDispatch('').ok).toBe(false)
    expect(validatePatchForDispatch('please fix the bug').ok).toBe(false)
  })

  it('rejects oversized patches', () => {
    const huge = `diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n${'+'.repeat(__testing__.MAX_PATCH_CHARS + 10)}`
    const res = validatePatchForDispatch(huge)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/too large/i)
  })

  it('rejects patches touching protected paths (workflows, migrations, schema, env, billing)', () => {
    for (const file of [
      '.github/workflows/anya-code-fix-pr.yml',
      'backend/db/migrations/999_evil.sql',
      'backend/db/schema.sql',
      '.env.production',
      'backend/middleware/auth.js',
      'backend/services/stripeService.js',
      'package-lock.json',
    ]) {
      const patch = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`
      const res = validatePatchForDispatch(patch)
      expect(res.ok, `${file} must be refused`).toBe(false)
      expect(res.reason).toMatch(/protected path/i)
    }
  })

  it('accepts a normal backend patch and returns its paths', () => {
    const res = validatePatchForDispatch(GOOD_PATCH)
    expect(res.ok).toBe(true)
    expect(res.paths).toContain('backend/services/example.js')
  })

  it('every forbidden pattern is a RegExp (registry sanity)', () => {
    for (const re of FORBIDDEN_PATCH_PATH_PATTERNS) expect(re).toBeInstanceOf(RegExp)
  })
})

describe('dispatchCodeFixWorkflow', () => {
  it('refuses without a GitHub token (clear owner-actionable error, no network call)', async () => {
    let called = false
    const res = await dispatchCodeFixWorkflow({
      patch: GOOD_PATCH,
      env: {},
      fetchImpl: async () => { called = true; return { status: 204 } },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/GITHUB_TOKEN/)
    expect(called).toBe(false)
  })

  it('refuses an invalid patch before any network call', async () => {
    let called = false
    const res = await dispatchCodeFixWorkflow({
      patch: 'not a diff',
      env: { GITHUB_TOKEN: 't' },
      fetchImpl: async () => { called = true; return { status: 204 } },
    })
    expect(res.ok).toBe(false)
    expect(called).toBe(false)
  })

  it('dispatches the workflow with the patch + automerge inputs and reports the Actions URL', async () => {
    let captured = null
    const res = await dispatchCodeFixWorkflow({
      patch: GOOD_PATCH,
      title: 'fix example constant',
      automerge: true,
      env: { GITHUB_TOKEN: 'test-token', GITHUB_REPO: 'buckeye7066/GrantFlow' },
      fetchImpl: async (url, opts) => { captured = { url, opts }; return { status: 204 } },
    })
    expect(res.ok).toBe(true)
    expect(res.dispatched).toBe(true)
    expect(captured.url).toBe(
      `https://api.github.com/repos/buckeye7066/GrantFlow/actions/workflows/${__testing__.WORKFLOW_FILE}/dispatches`,
    )
    expect(captured.opts.method).toBe('POST')
    expect(captured.opts.headers.Authorization).toBe('Bearer test-token')
    const body = JSON.parse(captured.opts.body)
    expect(body.ref).toBe('main')
    expect(body.inputs.patch_content).toBe(GOOD_PATCH)
    expect(body.inputs.pr_title).toBe('fix example constant')
    expect(body.inputs.automerge).toBe('true')
    expect(res.actions_url).toContain('github.com/buckeye7066/GrantFlow/actions')
  })

  it('automerge:false is passed through so the PR waits for review', async () => {
    let body = null
    await dispatchCodeFixWorkflow({
      patch: GOOD_PATCH,
      automerge: false,
      env: { GITHUB_TOKEN: 't' },
      fetchImpl: async (_url, opts) => { body = JSON.parse(opts.body); return { status: 204 } },
    })
    expect(body.inputs.automerge).toBe('false')
  })

  it('surfaces a non-204 GitHub response as an error', async () => {
    const res = await dispatchCodeFixWorkflow({
      patch: GOOD_PATCH,
      env: { GITHUB_TOKEN: 't' },
      fetchImpl: async () => ({ status: 422, text: async () => 'Unexpected inputs provided' }),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/422/)
  })

  it('surfaces fetch failures without throwing', async () => {
    const res = await dispatchCodeFixWorkflow({
      patch: GOOD_PATCH,
      env: { GITHUB_TOKEN: 't' },
      fetchImpl: async () => { throw new Error('ECONNRESET') },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ECONNRESET/)
  })
})
