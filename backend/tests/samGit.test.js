/**
 * Unit tests for backend/services/sam/samGit.js (charter §6 git integration).
 *
 * Proves:
 *   1. Branch names are validated; the fix branch is deterministic + never main.
 *   2. Only applied + path-safe files are committable (never `git add -A`).
 *   3. gitProposeFixes refuses unless policy allows (default OFF) and never
 *      commits to main.
 *   4. On commit it runs checkout→add(--, files)→commit and reports the branch.
 *   5. A failed step is reported, not thrown.
 *   6. Push + PR are a separate opt-in; a push failure doesn't undo the commit.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  isSafeBranchName,
  buildFixBranchName,
  collectCommittableFiles,
  gitProposeFixes,
} from '../services/sam/samGit.js'

const ALLOW = { auto_commit_allowed: true, direct_main_commit: false }
const applied = (file) => ({ applied: true, evidence: { file } })

/** Injected git runner that records calls and lets a subcommand be forced to fail. */
function makeRunGit({ failOn = null } = {}) {
  const calls = []
  const runGit = vi.fn(async (args) => {
    calls.push(args)
    if (failOn && args[0] === failOn) return { ok: false, status: 1, stdout: '', stderr: `${failOn} failed` }
    return { ok: true, status: 0, stdout: '', stderr: '' }
  })
  return { runGit, calls }
}

describe('isSafeBranchName', () => {
  it('accepts normal branches and rejects dangerous ones', () => {
    expect(isSafeBranchName('sam/auto-fix-abc123')).toBe(true)
    expect(isSafeBranchName('feature/x')).toBe(true)
    expect(isSafeBranchName('sam/..//etc')).toBe(false)
    expect(isSafeBranchName('-rf')).toBe(false)
    expect(isSafeBranchName('a b')).toBe(false)
    expect(isSafeBranchName('a;rm')).toBe(false)
    expect(isSafeBranchName('')).toBe(false)
  })
})

describe('buildFixBranchName', () => {
  it('is deterministic, sanitized, and never main', () => {
    expect(buildFixBranchName('abc-123-def-456')).toBe('sam/auto-fix-abc123def456')
    expect(buildFixBranchName(null)).toBe('sam/auto-fix-adhoc')
    expect(buildFixBranchName('run')).not.toBe('main')
  })
})

describe('collectCommittableFiles', () => {
  it('keeps only applied + path-safe files, deduped', () => {
    const files = collectCommittableFiles([
      applied('src/a.js'),
      applied('src/a.js'), // dup
      applied('backend/services/sam/b.js'),
      { applied: false, evidence: { file: 'src/skipped.js' } }, // not applied
      applied('backend/db/schema.sql'), // forbidden path
      applied(''), // empty
      { applied: true }, // no evidence
    ])
    expect(files).toEqual(['src/a.js', 'backend/services/sam/b.js'])
  })
})

describe('gitProposeFixes', () => {
  it('skips when there are no committable files (no git calls)', async () => {
    const { runGit, calls } = makeRunGit()
    const res = await gitProposeFixes(null, { appliedFixes: [], policy: ALLOW, runGit })
    expect(res).toMatchObject({ committed: false, skipped: true, reason: 'no_committable_files' })
    expect(calls).toHaveLength(0)
  })

  it('refuses when policy disallows commits (default OFF) — no git calls', async () => {
    const { runGit, calls } = makeRunGit()
    const res = await gitProposeFixes(null, {
      runId: 'r1',
      appliedFixes: [applied('src/a.js')],
      policy: { auto_commit_allowed: false, direct_main_commit: false },
      runGit,
    })
    expect(res.committed).toBe(false)
    expect(res.skipped).toBe(true)
    expect(res.reason).toMatch(/auto_commit_allowed/)
    expect(calls).toHaveLength(0)
  })

  it('commits to a sam/ branch with an explicit pathspec (never add -A)', async () => {
    const { runGit, calls } = makeRunGit()
    const res = await gitProposeFixes(null, {
      runId: 'run-abcdef',
      appliedFixes: [applied('src/a.js'), applied('backend/services/sam/b.js')],
      policy: ALLOW,
      env: {}, // SAM_AUTO_OPEN_PR unset → no push/PR
      runGit,
    })
    expect(res).toMatchObject({ ok: true, committed: true, branch: 'sam/auto-fix-runabcdef', pushed: false, pr_url: null })
    expect(res.files).toEqual(['src/a.js', 'backend/services/sam/b.js'])

    const sub = calls.map((c) => c[0])
    expect(sub).toEqual(['checkout', 'add', 'commit']) // no push
    // checkout creates the branch, never main
    expect(calls[0]).toEqual(['checkout', '-b', 'sam/auto-fix-runabcdef'])
    // add uses an explicit '--' pathspec — NEVER -A or .
    expect(calls[1]).toEqual(['add', '--', 'src/a.js', 'backend/services/sam/b.js'])
    expect(calls[1]).not.toContain('-A')
    expect(calls[1]).not.toContain('.')
  })

  it('reports a failed step without throwing', async () => {
    const { runGit } = makeRunGit({ failOn: 'commit' })
    const res = await gitProposeFixes(null, { runId: 'r', appliedFixes: [applied('src/a.js')], policy: ALLOW, env: {}, runGit })
    expect(res).toMatchObject({ ok: false, committed: false, step: 'commit' })
    expect(res.error).toMatch(/commit failed/)
  })

  it('pushes + opens a PR only when SAM_AUTO_OPEN_PR is set', async () => {
    const { runGit, calls } = makeRunGit()
    const openPr = vi.fn().mockResolvedValue({ ok: true, url: 'https://github.com/x/y/pull/42' })
    const res = await gitProposeFixes(null, {
      runId: 'r',
      appliedFixes: [applied('src/a.js')],
      policy: ALLOW,
      env: { SAM_AUTO_OPEN_PR: 'true' },
      runGit,
      openPr,
    })
    expect(res).toMatchObject({ committed: true, pushed: true, pr_url: 'https://github.com/x/y/pull/42' })
    expect(calls.map((c) => c[0])).toContain('push')
    expect(openPr).toHaveBeenCalledTimes(1)
  })

  it('keeps the local commit even if the push fails', async () => {
    const { runGit } = makeRunGit({ failOn: 'push' })
    const openPr = vi.fn()
    const res = await gitProposeFixes(null, {
      runId: 'r',
      appliedFixes: [applied('src/a.js')],
      policy: ALLOW,
      env: { SAM_AUTO_OPEN_PR: 'true' },
      runGit,
      openPr,
    })
    expect(res).toMatchObject({ committed: true, pushed: false, pr_url: null })
    expect(openPr).not.toHaveBeenCalled() // never reached PR creation
  })
})
