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

import crypto from 'node:crypto'
import {
  resolveDirectLandSecret,
  issueDirectLandToken,
  verifyDirectLandToken,
  recordAndConsumeNonce,
  sha256Hex,
} from './anyaDirectLandToken.js'

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
export function resolveDirectLanding({ paths = [], landMode = 'pr', env = process.env, allowCritical = undefined } = {}) {
  const wantDirect = landMode === 'direct' || landMode === true
  if (!wantDirect) {
    return { landMode: 'pr', downgraded: false, note: null, critical: [], allowCritical: false }
  }
  // An explicit boolean (from the DB-authoritative settings config) wins over
  // the env read; when not supplied, fall back to the env flag (unchanged).
  const effectiveAllowCritical = typeof allowCritical === 'boolean' ? allowCritical : directAllowsCriticalPaths(env)
  const critical = criticalPathsTouched(paths)
  if (critical.length > 0 && !effectiveAllowCritical) {
    return {
      landMode: 'pr',
      downgraded: true,
      note: `critical path — routed to PR, not direct (${critical.join(', ')})`,
      critical,
      allowCritical: effectiveAllowCritical,
    }
  }
  return { landMode: 'direct', downgraded: false, note: null, critical, allowCritical: effectiveAllowCritical }
}

/**
 * Parse `git status --porcelain` output into the set of touched repo-relative
 * paths (handling renames `R  old -> new`). Pure.
 */
export function parsePorcelainPaths(porcelain) {
  const paths = new Set()
  for (const raw of String(porcelain || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    // Porcelain v1: 2 status chars + space + path (rename uses ' -> ').
    const rest = line.slice(3)
    const arrow = rest.indexOf(' -> ')
    if (arrow !== -1) {
      paths.add(rest.slice(0, arrow).replace(/^"|"$/g, ''))
      paths.add(rest.slice(arrow + 4).replace(/^"|"$/g, ''))
    } else {
      paths.add(rest.replace(/^"|"$/g, ''))
    }
  }
  return [...paths]
}

/**
 * Assert the working tree contains ONLY the files the validated patch declared —
 * nothing more (no lockfile churn, generated artifacts, or gate-written files
 * riding along into a direct merge). Also re-checks the changed set against the
 * critical-path denylist. Pure; the workflow feeds it real `git status` output.
 *
 * @returns {{ok:boolean, changed:string[], unexpected:string[], forbidden:string[], reason?:string}}
 */
export function assertTreeMatchesDeclared({ porcelain, expectedPaths = [] } = {}) {
  const changed = parsePorcelainPaths(porcelain)
  const expected = new Set((expectedPaths || []).map((p) => String(p)))
  const unexpected = changed.filter((p) => !expected.has(p))
  const forbidden = changed.filter((p) => FORBIDDEN_PATCH_PATH_PATTERNS.some((re) => re.test(p)))
  if (unexpected.length > 0) {
    return { ok: false, changed, unexpected, forbidden, reason: `working tree has undeclared changes: ${unexpected.join(', ')}` }
  }
  if (forbidden.length > 0) {
    return { ok: false, changed, unexpected, forbidden, reason: `working tree touches protected path(s): ${forbidden.join(', ')}` }
  }
  return { ok: true, changed, unexpected: [], forbidden: [] }
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
  expectedPaths = null,
  fetchImpl = null,
  env = process.env,
} = {}) {
  const validation = validatePatchForDispatch(patch, { allowCriticalPaths })
  if (!validation.ok) {
    return { ok: false, dispatched: false, error: validation.reason }
  }
  // The workflow can ONLY open a PR ('pr') or run gates + push a branch
  // ('gate_only'). It can NEVER admin-merge — the direct merge lives entirely in
  // the backend (landPatchDirectToMain), gated by the single-use HMAC token. So
  // any 'direct' request degrades here to a safe PR; a raw workflow_dispatch can
  // never land on main on its own.
  const effectiveLandMode = landMode === 'gate_only' ? 'gate_only' : 'pr'

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
          // land_mode drives the workflow's terminal action. There is NO direct
          // admin-merge in the workflow:
          //   'pr'        → open a PR (optional CI-gated auto-merge)
          //   'gate_only' → apply + run release:gates + assert ONLY the declared
          //                 files changed + push the branch, then STOP. The
          //                 backend lander merges only on a green run + a valid
          //                 single-use token + a still-matching head_sha.
          land_mode: effectiveLandMode,
          branch: String(branch || '').slice(0, 200),
          // The gate_only workflow re-validates the ACTUAL applied patch against
          // these: sha256(patch_content) must equal patch_sha256, and the tree
          // must contain ONLY expected_paths (newline-separated). expected_paths
          // comes from the caller's TRUSTED target set when supplied — never
          // solely from the model-authored diff — falling back to the diff's own
          // paths only for legacy callers (which already passed the denylist).
          patch_sha256: sha256Hex(patch),
          expected_paths: (Array.isArray(expectedPaths) && expectedPaths.length > 0
            ? expectedPaths.map((p) => String(p).replace(/\\/g, '/'))
            : validation.paths || []
          )
            .join('\n')
            .slice(0, 4000),
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

/**
 * FRESH, UNIQUE branch for every direct land. A reused branch could carry a
 * stale successful gate run or a racing push, so a direct land must always use a
 * name that does not already exist (asserted via branchExists).
 */
export function buildDirectLandBranch(seed = '') {
  const clean = String(seed || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'adhoc'
  const stamp = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  return `anya-direct/${clean}-${stamp}`
}

/** Default gate-run trigger — dispatch the workflow in gate_only mode. */
async function defaultTriggerGateRun({ patch, title, branch, allowCriticalPaths, expectedPaths, fetchImpl, env }) {
  return dispatchCodeFixWorkflow({
    patch,
    title,
    landMode: 'gate_only',
    branch,
    allowCriticalPaths,
    expectedPaths,
    fetchImpl,
    env,
  })
}

/** Default branch-existence probe — GET the ref; true if it resolves. */
async function defaultBranchExists({ branch, fetchImpl, env }) {
  const { token, repo } = resolveCodeFixGitHubConfig(env)
  const doFetch = fetchImpl || globalThis.fetch
  if (!token || typeof doFetch !== 'function') return false
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    return res?.status === 200
  } catch {
    return false
  }
}

/** Default current-head-SHA probe for a branch. Returns the sha or null. */
async function defaultGetBranchSha({ branch, fetchImpl, env }) {
  const { token, repo } = resolveCodeFixGitHubConfig(env)
  const doFetch = fetchImpl || globalThis.fetch
  if (!token || typeof doFetch !== 'function') return null
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    const body = await res.json().catch(() => null)
    return body?.object?.sha || null
  } catch {
    return null
  }
}

/**
 * Default gate poller. A gate_only run is dispatched on `main` (the workflow
 * CREATES the landing branch commit INSIDE the job), so its `head_sha` is main's
 * — NOT the commit we intend to merge, and `?branch=<landing branch>` never
 * matches it. We therefore correlate the run by its RUN NAME (the workflow sets
 * `run-name` to include the unique landing branch) and return only the
 * conclusion + runId. The commit to merge is read separately from the pushed
 * branch ref (getBranchSha) — that is the real gated commit. Never throws.
 *
 * Returns { conclusion:'success'|'failure'|'timed_out', runId }.
 */
async function defaultPollGateConclusion({ branch, fetchImpl, env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const { token, repo } = resolveCodeFixGitHubConfig(env)
  const doFetch = fetchImpl || globalThis.fetch
  if (!token || typeof doFetch !== 'function') return { conclusion: 'failure', runId: null }
  const deadline = Date.now() + GATE_POLL_TIMEOUT_MS
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=30`
  const matchesBranch = (run) =>
    String(run?.display_title || run?.name || '').includes(branch)
  while (Date.now() < deadline) {
    try {
      const res = await doFetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      })
      const body = await res.json().catch(() => null)
      const run = (body?.workflow_runs || []).find(matchesBranch)
      if (run && run.status === 'completed') {
        return { conclusion: run.conclusion === 'success' ? 'success' : 'failure', runId: run.id ?? null }
      }
    } catch {
      /* transient — keep polling until the deadline */
    }
    await sleep(GATE_POLL_INTERVAL_MS)
  }
  return { conclusion: 'timed_out', runId: null }
}

/**
 * Default admin merge — create a PR for the branch then merge it with admin
 * (equivalent to `gh pr merge --admin --squash`), bypassing the human-approval
 * requirement while the workflow's release:gates already served as the build
 * gate. Never throws.
 */
async function defaultAdminMergeToMain({ branch, sha, title, fetchImpl, env }) {
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
    // Pass the EXPECTED head `sha`: GitHub refuses the merge (409) if the branch
    // head has moved since the gate ran — so a racing push after green cannot be
    // merged un-gated.
    const mergeRes = await doFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ merge_method: 'squash', ...(sha ? { sha: String(sha) } : {}) }),
    })
    const merged = mergeRes?.status === 200
    return { ok: merged, pr_number: prNumber, merged, status: mergeRes?.status, sha: sha || null }
  } catch (err) {
    return { ok: false, error: `admin merge failed: ${err?.message || err}` }
  }
}

/**
 * Land a verified patch DIRECT to main. Fail-closed at every step; the merge is
 * reached ONLY when ALL hold:
 *   - a server secret (DIRECT_LAND_TOKEN_SECRET) exists (else inert → caller
 *     should fall back to a PR),
 *   - a FRESH, unique branch that does not already exist,
 *   - the gate_only workflow run correlated to THAT branch concluded 'success',
 *   - the branch was actually pushed (its ref resolves to a real commit) — that
 *     pushed commit is the gated code (the workflow runs release:gates + the
 *     declared-files assertion BEFORE it pushes), and it is what we merge (NOT
 *     the dispatch run's head_sha, which is main),
 *   - the branch head is STABLE across a re-read (no racing push), and
 *   - a single-use HMAC token bound to sha256(patch)+pushed_sha+nonce+expiry
 *     verifies and its nonce has never been consumed,
 * and the merge itself passes that pushed_sha so GitHub refuses a moved head.
 *
 * @returns {Promise<{ok:boolean, landed:boolean, step:string, branch?:string,
 *   gate_conclusion?:string, head_sha?:string, merge?:object, error?:string}>}
 */
export async function landPatchDirectToMain({
  patch,
  title = '',
  branch = null,
  allowCriticalPaths = false,
  expectedPaths = null,
  fetchImpl = null,
  env = process.env,
  db = null,
  triggerGateRun = defaultTriggerGateRun,
  pollGateConclusion = defaultPollGateConclusion,
  branchExists = defaultBranchExists,
  getBranchSha = defaultGetBranchSha,
  mergeToMain = defaultAdminMergeToMain,
  consumeNonce = recordAndConsumeNonce,
  now = () => Date.now(),
} = {}) {
  const validation = validatePatchForDispatch(patch, { allowCriticalPaths })
  if (!validation.ok) return { ok: false, landed: false, step: 'validate', error: validation.reason }

  // Direct land is INERT without a signing secret. The secret is SELF-
  // PROVISIONING: env wins, else a persisted system_kv value, else auto-generated
  // (crypto.randomBytes) and persisted — so direct land works with ZERO env
  // config and the owner never sets or sees a secret. Only a total absence of a
  // DB (and no env secret) leaves it empty → fail closed (caller falls back to PR).
  const secret = await resolveDirectLandSecret({ db, env })
  if (!secret) {
    return { ok: false, landed: false, step: 'secret', error: 'no signing secret available (no DB to auto-provision one) — direct land disabled (use the PR path).' }
  }

  // FRESH, unique branch — reject a reused/pre-existing name (stale green run /
  // racing push guard). Because it did not exist before this land, the only run
  // that can push it is the one we trigger.
  const landBranch = branch || buildDirectLandBranch(title)
  if (await branchExists({ branch: landBranch, fetchImpl, env })) {
    return { ok: false, landed: false, step: 'branch', branch: landBranch, error: `branch ${landBranch} already exists — refusing to reuse for a direct land.` }
  }

  const trigger = await triggerGateRun({ patch, title, branch: landBranch, allowCriticalPaths, expectedPaths, fetchImpl, env })
  if (!trigger?.ok) {
    return { ok: false, landed: false, step: 'gate_dispatch', branch: landBranch, error: trigger?.error || 'gate-run dispatch failed' }
  }

  // Correlate the run by name (see defaultPollGateConclusion): the run is
  // dispatched on main, so its head_sha is main — NOT what we merge.
  const gate = await pollGateConclusion({ branch: landBranch, fetchImpl, env })
  const conclusion = typeof gate === 'string' ? gate : gate?.conclusion
  if (conclusion !== 'success') {
    return {
      ok: false,
      landed: false,
      step: 'release_gates',
      branch: landBranch,
      gate_conclusion: conclusion,
      error: `release:gates ${conclusion} — the fix is adversarially clean but does NOT land on main (build gate protects prod).`,
    }
  }

  // The commit to merge is the ACTUAL pushed branch commit. The gate_only
  // workflow ran release:gates + the declared-files assertion BEFORE pushing, so
  // this ref IS the gated code. A green run that pushed nothing (no ref) means
  // the gate failed before the push — refuse.
  const pushedSha = await getBranchSha({ branch: landBranch, fetchImpl, env })
  if (!pushedSha) {
    return { ok: false, landed: false, step: 'no_pushed_commit', branch: landBranch, gate_conclusion: 'success', error: 'gate run concluded success but pushed no branch commit — refusing to merge.' }
  }

  // Issue + verify the single-use HMAC proof bound to patch + the PUSHED commit.
  const issued = issueDirectLandToken({ patch, headSha: pushedSha, now: now(), secret })
  const verify = verifyDirectLandToken({ ...issued, patch, headSha: pushedSha, secret, now: now() })
  if (!verify.ok) {
    return { ok: false, landed: false, step: 'token', branch: landBranch, head_sha: pushedSha, error: `direct-land token invalid: ${verify.reason}` }
  }
  const consumed = await consumeNonce(db, issued.nonce, { now: now() })
  if (!consumed.ok) {
    return { ok: false, landed: false, step: 'nonce', branch: landBranch, head_sha: pushedSha, error: `direct-land authorization not single-use-safe: ${consumed.reason}` }
  }

  // Immediately before merge, re-read the ref: it must STILL be the pushed
  // commit (no racing push between binding and merge).
  const stillSha = await getBranchSha({ branch: landBranch, fetchImpl, env })
  if (String(stillSha || '') !== String(pushedSha)) {
    return { ok: false, landed: false, step: 'head_moved', branch: landBranch, gate_conclusion: 'success', head_sha: pushedSha, error: `branch head moved after the gate (${pushedSha} → ${stillSha}) — refusing to merge un-gated code.` }
  }

  // Pass the pushed sha so GitHub itself 409s if the head moved concurrently.
  const merge = await mergeToMain({ branch: landBranch, sha: pushedSha, title, fetchImpl, env })
  return {
    ok: merge?.ok === true,
    landed: merge?.ok === true,
    step: 'merge',
    branch: landBranch,
    gate_conclusion: 'success',
    head_sha: pushedSha,
    token_nonce: issued.nonce,
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
  allowCritical = undefined,
  expectedPaths = null,
  fetchImpl = null,
  env = process.env,
  db = null,
  // Injectables passed straight through to the direct lander (tests):
  triggerGateRun,
  pollGateConclusion,
  branchExists,
  getBranchSha,
  mergeToMain,
  consumeNonce,
  now,
} = {}) {
  // Shape-check first (allow critical so we can read paths for the routing
  // decision even when the diff touches a critical path).
  const shape = validatePatchForDispatch(patch, { allowCriticalPaths: true })
  if (!shape.ok) return { ok: false, dispatched: false, landed: false, error: shape.reason }

  const decision = resolveDirectLanding({ paths: shape.paths, landMode, env, allowCritical })

  // NEVER SILENTLY FAIL: a direct land needs the GitHub merge token. If it is
  // absent, gracefully fall back to opening a PR (fail-closed) with a note the
  // owner-facing readiness line already explains — never attempt an admin-merge
  // that cannot complete.
  let effective = decision
  if (decision.landMode === 'direct') {
    const { token } = resolveCodeFixGitHubConfig(env)
    if (!token) {
      effective = {
        ...decision,
        landMode: 'pr',
        downgraded: true,
        note: 'GitHub token not configured — opened a PR instead of direct-merging.',
      }
    }
  }

  if (effective.landMode === 'pr') {
    // PR path (existing gate; strict forbidden-path block re-applied inside).
    const result = await dispatchCodeFixWorkflow({ patch, title, automerge, landMode: 'pr', expectedPaths, fetchImpl, env })
    return {
      ...result,
      land_mode: 'pr',
      downgraded_to_pr: effective.downgraded,
      land_note: effective.note,
    }
  }

  // Direct-to-main. Relax the forbidden block ONLY when the diff is critical AND
  // the owner override is on (decision.landMode stays 'direct' only then).
  const allowCriticalPaths = decision.critical.length > 0 && decision.allowCritical
  const landed = await landPatchDirectToMain({
    patch,
    title,
    allowCriticalPaths,
    expectedPaths,
    fetchImpl,
    env,
    db,
    ...(triggerGateRun ? { triggerGateRun } : {}),
    ...(pollGateConclusion ? { pollGateConclusion } : {}),
    ...(branchExists ? { branchExists } : {}),
    ...(getBranchSha ? { getBranchSha } : {}),
    ...(mergeToMain ? { mergeToMain } : {}),
    ...(consumeNonce ? { consumeNonce } : {}),
    ...(now ? { now } : {}),
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
  defaultBranchExists,
  defaultGetBranchSha,
  defaultAdminMergeToMain,
}
