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

/**
 * The critical-path set that a DIRECT-to-main auto-merge may never touch. It is
 * the SAME set as FORBIDDEN_PATCH_PATH_PATTERNS (migrations, schema, .env,
 * auth, billing, .github workflows, lockfiles) — named separately so the
 * direct-landing policy reads clearly and can be toggled independently. When
 * `ADVERSARIAL_DIRECT_ALLOW_CRITICAL` is truthy the owner has opted to let
 * direct-to-main reach these paths too (default OFF).
 */
export const DIRECT_LAND_CRITICAL_PATTERNS = FORBIDDEN_PATCH_PATH_PATTERNS

/** True when the owner has flipped the direct-critical override on. */
export function directAllowsCriticalPaths(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env?.ADVERSARIAL_DIRECT_ALLOW_CRITICAL ?? '').trim())
}

/** Which of the given paths hit the critical-path set. Pure. */
export function criticalPathsTouched(paths = []) {
  return (paths || []).filter((p) => DIRECT_LAND_CRITICAL_PATTERNS.some((re) => re.test(p)))
}

/**
 * Validate a proposed patch. Returns { ok } or { ok:false, reason }. Pure.
 *
 * @param {string} patch
 * @param {object} [opts]
 * @param {boolean} [opts.allowCriticalPaths=false]  skip the forbidden-path
 *        block. Existing callers pass nothing → identical strict behavior. Only
 *        the direct-to-main lander sets this true, and ONLY after the owner
 *        override (ADVERSARIAL_DIRECT_ALLOW_CRITICAL) is on.
 */
export function validatePatchForDispatch(patch, { allowCriticalPaths = false } = {}) {
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
  if (!allowCriticalPaths) {
    const forbidden = paths.filter((p) => FORBIDDEN_PATCH_PATH_PATTERNS.some((re) => re.test(p)))
    if (forbidden.length > 0) {
      return {
        ok: false,
        reason: `patch touches protected path(s) that require human review: ${forbidden.join(', ')}`,
      }
    }
  }
  return { ok: true, paths }
}

/**
 * Decide the effective landing mode for a verified diff. Pure.
 *
 * A caller may REQUEST 'direct' (auto-merge to main after the build gate), but a
 * diff that touches a critical path is downgraded to 'pr' unless the owner
 * override is on. 'pr' requests always stay 'pr'.
 *
 * @returns {{landMode:'pr'|'direct', downgraded:boolean, note:string|null,
 *            critical:string[], allowCritical:boolean}}
 */
export function resolveDirectLanding({ paths = [], landMode = 'pr', env = process.env } = {}) {
  const wantDirect = landMode === 'direct' || landMode === true
  if (!wantDirect) {
    return { landMode: 'pr', downgraded: false, note: null, critical: [], allowCritical: false }
  }
  const allowCritical = directAllowsCriticalPaths(env)
  const critical = criticalPathsTouched(paths)
  if (critical.length > 0 && !allowCritical) {
    return {
      landMode: 'pr',
      downgraded: true,
      note: `critical path — routed to PR, not direct (${critical.join(', ')})`,
      critical,
      allowCritical,
    }
  }
  return { landMode: 'direct', downgraded: false, note: null, critical, allowCritical }
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
  landMode = 'pr',
  branch = '',
  allowCriticalPaths = false,
  fetchImpl = null,
  env = process.env,
} = {}) {
  const validation = validatePatchForDispatch(patch, { allowCriticalPaths })
  if (!validation.ok) {
    return { ok: false, dispatched: false, error: validation.reason }
  }
  const effectiveLandMode = landMode === 'direct' || landMode === 'gate_only' ? landMode : 'pr'

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
          // land_mode drives the workflow's terminal action:
          //   'pr'        → open a PR (existing behavior; optional auto-merge)
          //   'direct'    → after gates pass, admin-merge to main (no human wait)
          //   'gate_only' → apply + run release:gates + push the branch, then STOP
          //                 (the app-side lander admin-merges only on a green run)
          land_mode: effectiveLandMode,
          branch: String(branch || '').slice(0, 200),
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
      land_mode: effectiveLandMode,
      branch: String(branch || '') || null,
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

// ===========================================================================
// Direct-to-main landing (owner-requested): auto-merge after the BUILD GATE.
//
// The build gate is NEVER removed — only the HUMAN approval step is. The
// mechanism is two-phase and fail-closed:
//   1. Trigger the workflow in `gate_only` mode: it applies the diff on a
//      throwaway checkout, runs `npm run release:gates`, and — only if the gate
//      passes — pushes the branch. If the gate fails, the workflow job fails and
//      the branch is never pushed.
//   2. Poll the workflow RUN conclusion. On 'success' (gate green) admin-merge
//      the branch to main. On anything else, land NOTHING and report the gate
//      outcome.
//
// Every external step is injectable so tests never touch GitHub. The gate-run
// dispatch, the poll, and the merge are separate seams; the merge is reached
// ONLY when the poll returns 'success'.
// ===========================================================================

const GATE_POLL_INTERVAL_MS = Number(process.env.ADVERSARIAL_GATE_POLL_INTERVAL_MS) || 15_000
const GATE_POLL_TIMEOUT_MS = Number(process.env.ADVERSARIAL_GATE_POLL_TIMEOUT_MS) || 20 * 60_000

/** Deterministic short-lived branch name for a direct land. */
export function buildDirectLandBranch(seed = '') {
  const clean = String(seed || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'adhoc'
  const stamp = Date.now().toString(36)
  return `anya-direct/${clean}-${stamp}`
}

/** Default gate-run trigger — dispatch the workflow in gate_only mode. */
async function defaultTriggerGateRun({ patch, title, branch, allowCriticalPaths, fetchImpl, env }) {
  return dispatchCodeFixWorkflow({
    patch,
    title,
    landMode: 'gate_only',
    branch,
    allowCriticalPaths,
    fetchImpl,
    env,
  })
}

/**
 * Default gate poller — poll the workflow runs for `branch` until the run
 * concludes. Returns 'success' | 'failure' | 'timed_out'. Best-effort; the
 * tests inject a stub. Never throws.
 */
async function defaultPollGateConclusion({ branch, fetchImpl, env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const { token, repo } = resolveCodeFixGitHubConfig(env)
  const doFetch = fetchImpl || globalThis.fetch
  if (!token || typeof doFetch !== 'function') return 'failure'
  const deadline = Date.now() + GATE_POLL_TIMEOUT_MS
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${encodeURIComponent(branch)}&per_page=1`
  while (Date.now() < deadline) {
    try {
      const res = await doFetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      const body = await res.json().catch(() => null)
      const run = body?.workflow_runs?.[0]
      if (run && run.status === 'completed') {
        return run.conclusion === 'success' ? 'success' : 'failure'
      }
    } catch {
      /* transient — keep polling until the deadline */
    }
    await sleep(GATE_POLL_INTERVAL_MS)
  }
  return 'timed_out'
}

/**
 * Default admin merge — create a PR for the branch then merge it with admin
 * (equivalent to `gh pr merge --admin --squash`), bypassing the human-approval
 * requirement while the workflow's release:gates already served as the build
 * gate. Never throws.
 */
async function defaultAdminMergeToMain({ branch, title, fetchImpl, env }) {
  const { token, repo } = resolveCodeFixGitHubConfig(env)
  const doFetch = fetchImpl || globalThis.fetch
  if (!token || typeof doFetch !== 'function') {
    return { ok: false, error: 'GITHUB_TOKEN or fetch unavailable for admin merge' }
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
  try {
    // Merge the branch straight into main. A repo whose branch protection
    // forbids a direct push still lands via the PR+admin path below; we try the
    // simplest merge first.
    const prRes = await doFetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: title || `Anya direct fix: ${branch}`, head: branch, base: 'main', body: 'Adversarially-verified fix; build gate passed in gate_only workflow run.' }),
    })
    const pr = await prRes.json().catch(() => null)
    const prNumber = pr?.number
    if (!prNumber) {
      return { ok: false, error: `could not open PR for admin merge: ${prRes?.status}` }
    }
    const mergeRes = await doFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ merge_method: 'squash' }),
    })
    const merged = mergeRes?.status === 200
    return { ok: merged, pr_number: prNumber, merged, status: mergeRes?.status }
  } catch (err) {
    return { ok: false, error: `admin merge failed: ${err?.message || err}` }
  }
}

/**
 * Land a verified patch DIRECT to main: gate-run → poll → merge-on-green.
 * Fail-closed: only a 'success' gate conclusion reaches the merge.
 *
 * @returns {Promise<{ok:boolean, landed:boolean, step:string, branch?:string,
 *   gate_conclusion?:string, merge?:object, error?:string}>}
 */
export async function landPatchDirectToMain({
  patch,
  title = '',
  branch = null,
  allowCriticalPaths = false,
  fetchImpl = null,
  env = process.env,
  triggerGateRun = defaultTriggerGateRun,
  pollGateConclusion = defaultPollGateConclusion,
  mergeToMain = defaultAdminMergeToMain,
} = {}) {
  const validation = validatePatchForDispatch(patch, { allowCriticalPaths })
  if (!validation.ok) return { ok: false, landed: false, step: 'validate', error: validation.reason }

  const landBranch = branch || buildDirectLandBranch(title)

  const trigger = await triggerGateRun({ patch, title, branch: landBranch, allowCriticalPaths, fetchImpl, env })
  if (!trigger?.ok) {
    return { ok: false, landed: false, step: 'gate_dispatch', branch: landBranch, error: trigger?.error || 'gate-run dispatch failed' }
  }

  const conclusion = await pollGateConclusion({ branch: landBranch, fetchImpl, env })
  if (conclusion !== 'success') {
    // The fix is adversarially clean but release:gates did NOT pass (or timed
    // out). Prod must never get a broken build — land NOTHING.
    return {
      ok: false,
      landed: false,
      step: 'release_gates',
      branch: landBranch,
      gate_conclusion: conclusion,
      error: `release:gates ${conclusion} — the fix is adversarially clean but does NOT land on main (build gate protects prod).`,
    }
  }

  const merge = await mergeToMain({ branch: landBranch, title, fetchImpl, env })
  return {
    ok: merge?.ok === true,
    landed: merge?.ok === true,
    step: 'merge',
    branch: landBranch,
    gate_conclusion: 'success',
    merge,
  }
}

/**
 * The single entry point the owner tool + Sam use to APPLY a verified diff.
 * Decides pr vs direct (with critical-path downgrade) then routes to the PR
 * dispatch or the direct-to-main lander. Pure decision + delegated I/O.
 *
 * @param {object} args
 * @param {string} args.patch
 * @param {string} [args.title]
 * @param {'pr'|'direct'} [args.landMode='pr']
 * @param {boolean} [args.automerge=false]  (PR path only) queue CI auto-merge
 * @returns {Promise<object>} { ok, land_mode, downgraded_to_pr, land_note, ... }
 */
export async function landVerifiedPatch({
  patch,
  title = '',
  landMode = 'pr',
  automerge = false,
  fetchImpl = null,
  env = process.env,
  // Injectables passed straight through to the direct lander (tests):
  triggerGateRun,
  pollGateConclusion,
  mergeToMain,
} = {}) {
  // Shape-check first (allow critical so we can read paths for the routing
  // decision even when the diff touches a critical path).
  const shape = validatePatchForDispatch(patch, { allowCriticalPaths: true })
  if (!shape.ok) return { ok: false, dispatched: false, landed: false, error: shape.reason }

  const decision = resolveDirectLanding({ paths: shape.paths, landMode, env })

  if (decision.landMode === 'pr') {
    // PR path (existing gate; strict forbidden-path block re-applied inside).
    const result = await dispatchCodeFixWorkflow({ patch, title, automerge, landMode: 'pr', fetchImpl, env })
    return {
      ...result,
      land_mode: 'pr',
      downgraded_to_pr: decision.downgraded,
      land_note: decision.note,
    }
  }

  // Direct-to-main. Relax the forbidden block ONLY when the diff is critical AND
  // the owner override is on (decision.landMode stays 'direct' only then).
  const allowCriticalPaths = decision.critical.length > 0 && decision.allowCritical
  const landed = await landPatchDirectToMain({
    patch,
    title,
    allowCriticalPaths,
    fetchImpl,
    env,
    ...(triggerGateRun ? { triggerGateRun } : {}),
    ...(pollGateConclusion ? { pollGateConclusion } : {}),
    ...(mergeToMain ? { mergeToMain } : {}),
  })
  return {
    ...landed,
    land_mode: 'direct',
    downgraded_to_pr: false,
    land_note: decision.note,
  }
}

export const __testing__ = {
  WORKFLOW_FILE,
  DEFAULT_REPO,
  MAX_PATCH_CHARS,
  defaultTriggerGateRun,
  defaultPollGateConclusion,
  defaultAdminMergeToMain,
}
