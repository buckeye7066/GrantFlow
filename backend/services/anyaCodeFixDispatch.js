/**
 * anyaCodeFixDispatch.js
 *
 * The programmatic trigger for the "agent proposes a code fix → branch → PR →
 * CI-gated auto-merge" loop. Before this module, `.github/workflows/
 * anya-code-fix-pr.yml` existed but could only be dispatched BY A HUMAN from
 * the GitHub UI — Anya could suggest a patch (code.suggestPatch /
 * admin.code.autoRepair) but never propose it for review on her own.
 *
 * This service dispatches that workflow via the GitHub REST API
 * (`POST /repos/{repo}/actions/workflows/{file}/dispatches`). The workflow —
 * not this service — then applies the patch on a throwaway checkout, runs the
 * corruption-hotspot guard + code-quality gate + `npm run release:gates`, and
 * opens a PR against main. Merging remains gated by branch protection
 * (required CI checks) — optionally with GitHub auto-merge queued so a green
 * PR lands without a human click, but NEVER an unreviewed direct-to-main
 * mutation from this process.
 *
 * Safety model (defense in depth, all enforced here BEFORE any network call):
 *   1. Caller gate — the only production caller is the owner-gated Anya tool
 *      `owner.propose_code_fix` (requiresOwner, enforced in invokeTool).
 *   2. Patch shape — must look like a unified diff, bounded size.
 *   3. Path denylist — a patch that touches CI workflows, migrations, schema,
 *      env files, auth middleware, or billing/Stripe code is refused outright
 *      (mirrors samSafeFixes.FORBIDDEN_PATH_PATTERNS; those need human hands).
 *   4. The workflow itself re-verifies everything with the release gates; a
 *      patch that fails the gates produces NO branch and NO PR.
 *
 * Env (same convention as githubSyncVehicles.js):
 *   GITHUB_TOKEN — PAT with `repo` + `workflow` scope (falls back to
 *                  ANYA_GITHUB_TOKEN so the Anya deployment can use its own).
 *   GITHUB_REPO  — full slug, defaults to the canonical GrantFlow repo.
 */

const WORKFLOW_FILE = 'anya-code-fix-pr.yml'
const DEFAULT_REPO = 'buckeye7066/GrantFlow'
const MAX_PATCH_CHARS = 200_000

// Paths an agent-proposed patch may NEVER touch. Keep in spirit with
// samSafeFixes.FORBIDDEN_PATH_PATTERNS; `.github/` is stricter here because a
// patch that edits the workflow that gates patches could self-escalate.
export const FORBIDDEN_PATCH_PATH_PATTERNS = Object.freeze([
  /^\.github\//i,
  /(^|\/)backend\/db\/migrations\//i,
  /(^|\/)backend\/db\/postgres\/migrations\//i,
  /(^|\/)backend\/db\/schema\.sql$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)backend\/middleware\/auth/i,
  /(^|\/)backend\/services\/(?:billing|stripe)[^/]*\.js$/i,
  /(^|\/)node_modules\//i,
  /(^|\/)package-lock\.json$/i,
])

/** Extract the repo-relative file paths a unified diff touches. Pure. */
export function extractPatchPaths(patch) {
  const paths = new Set()
  const text = String(patch || '')
  // `diff --git a/<path> b/<path>` headers.
  for (const m of text.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) {
    paths.add(m[1])
    paths.add(m[2])
  }
  // `--- a/<path>` / `+++ b/<path>` headers (also covers /dev/null omissions).
  for (const m of text.matchAll(/^(?:---|\+\+\+) [ab]\/(\S+)/gm)) {
    paths.add(m[1])
  }
  return [...paths]
}

/** Validate a proposed patch. Returns { ok } or { ok:false, reason }. Pure. */
export function validatePatchForDispatch(patch) {
  const text = typeof patch === 'string' ? patch : ''
  if (!text.trim()) return { ok: false, reason: 'patch is empty' }
  if (text.length > MAX_PATCH_CHARS) {
    return { ok: false, reason: `patch too large (${text.length} chars > ${MAX_PATCH_CHARS})` }
  }
  const looksLikeDiff = /^diff --git /m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text))
  if (!looksLikeDiff) {
    return { ok: false, reason: 'patch is not a unified diff (expected `diff --git` or `---`/`+++` headers)' }
  }
  const paths = extractPatchPaths(text)
  if (paths.length === 0) {
    return { ok: false, reason: 'patch declares no file paths' }
  }
  const forbidden = paths.filter((p) => FORBIDDEN_PATCH_PATH_PATTERNS.some((re) => re.test(p)))
  if (forbidden.length > 0) {
    return {
      ok: false,
      reason: `patch touches protected path(s) that require human review: ${forbidden.join(', ')}`,
    }
  }
  return { ok: true, paths }
}

export function resolveCodeFixGitHubConfig(env = process.env) {
  const token = String(env.GITHUB_TOKEN || env.ANYA_GITHUB_TOKEN || '').trim()
  const repo = String(env.GITHUB_REPO || DEFAULT_REPO).trim()
  return { token, repo }
}

/**
 * Dispatch the Anya code-fix workflow.
 *
 * @param {object} args
 * @param {string} args.patch          unified diff to propose
 * @param {string} [args.title]        short human summary for the PR
 * @param {boolean} [args.automerge]   queue CI-gated auto-merge on the PR
 * @param {string} [args.ref]          git ref to dispatch on (default 'main')
 * @param {Function} [args.fetchImpl]  injectable fetch for tests
 * @param {object} [args.env]          injectable env for tests
 * @returns {Promise<{ok:boolean, dispatched:boolean, repo?:string, ref?:string,
 *                    automerge?:boolean, paths?:string[], actions_url?:string,
 *                    error?:string}>}
 */
export async function dispatchCodeFixWorkflow({
  patch,
  title = '',
  automerge = true,
  ref = 'main',
  fetchImpl = null,
  env = process.env,
} = {}) {
  const validation = validatePatchForDispatch(patch)
  if (!validation.ok) {
    return { ok: false, dispatched: false, error: validation.reason }
  }

  const { token, repo } = resolveCodeFixGitHubConfig(env)
  if (!token) {
    return {
      ok: false,
      dispatched: false,
      error: 'GITHUB_TOKEN (or ANYA_GITHUB_TOKEN) is not configured — cannot dispatch the code-fix workflow.',
    }
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { ok: false, dispatched: false, error: `GITHUB_REPO is not a valid owner/repo slug: ${repo}` }
  }

  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') {
    return { ok: false, dispatched: false, error: 'fetch is unavailable in this runtime' }
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`
  let response
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: String(ref || 'main'),
        inputs: {
          patch_content: String(patch),
          pr_title: String(title || '').slice(0, 200),
          automerge: automerge === false ? 'false' : 'true',
        },
      }),
    })
  } catch (err) {
    return { ok: false, dispatched: false, error: `workflow dispatch failed: ${err?.message || err}` }
  }

  // GitHub answers 204 No Content on a successful dispatch.
  if (response?.status === 204) {
    return {
      ok: true,
      dispatched: true,
      repo,
      ref: String(ref || 'main'),
      workflow: WORKFLOW_FILE,
      automerge: automerge !== false,
      paths: validation.paths,
      actions_url: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
    }
  }

  let bodyText = ''
  try { bodyText = await response.text() } catch { /* best-effort */ }
  return {
    ok: false,
    dispatched: false,
    error: `GitHub dispatch returned ${response?.status}: ${String(bodyText).slice(0, 300)}`,
  }
}

export const __testing__ = { WORKFLOW_FILE, DEFAULT_REPO, MAX_PATCH_CHARS }
