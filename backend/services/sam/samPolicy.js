/**
 * samPolicy.js
 *
 * Canonical automation policy for Sam (AGENT_AUTOMATION_CHARTER.md §6).
 *
 * Sam may edit / save / test / correct code — but only within these guardrails.
 * The defaults encode the charter doctrine:
 *
 *   auto_fix_safe       = true   — deterministic, clearly-correct fixes may be
 *                                  applied directly (still admin + repair-safe
 *                                  gated in samSafeFixes.js).
 *   auto_branch_risky   = true   — risky fixes go to a branch/PR, never main.
 *   auto_commit_allowed = false  — Sam does not commit unless explicitly enabled.
 *   direct_main_commit  = false  — NEVER commit straight to main unless an admin
 *                                  explicitly opts in. This is the dangerous one;
 *                                  it defaults off and assertCommitAllowed() will
 *                                  refuse a main commit while it is off.
 *
 * Every flag is overridable via environment so an admin can tune policy without
 * a code change. Nothing here mutates anything — it only reports policy and
 * provides assertions the mutating paths call before acting.
 */

function readEnvBool(name, fallback) {
  const raw = process.env[name]
  if (raw === null || raw === undefined || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

/**
 * Resolve Sam's effective automation policy. Pass an explicit `env` object in
 * tests; defaults to process.env.
 */
export function getSamPolicy(env = process.env) {
  const read = (name, fallback) => {
    const raw = env?.[name]
    if (raw === null || raw === undefined || raw === '') return fallback
    return /^(1|true|yes|on)$/i.test(String(raw).trim())
  }
  return {
    auto_fix_safe: read('SAM_AUTO_FIX_SAFE', true),
    auto_branch_risky: read('SAM_AUTO_BRANCH_RISKY', true),
    auto_commit_allowed: read('SAM_AUTO_COMMIT_ALLOWED', false),
    direct_main_commit: read('SAM_DIRECT_MAIN_COMMIT', false),
  }
}

/**
 * Whether Sam may auto-apply a fix of the given risk level under current policy.
 * Only `safe` fixes are auto-applicable, and only when auto_fix_safe is on.
 * Anything riskier must be branched/PR'd (auto_branch_risky), never applied here.
 */
export function isSafeFixAllowed(riskLevel, policy = getSamPolicy()) {
  if (riskLevel !== 'safe') return false
  return policy.auto_fix_safe === true
}

/**
 * Guard the (currently un-implemented) commit path. Returns { allowed, reason }.
 * A commit to `main` requires BOTH auto_commit_allowed AND direct_main_commit.
 * Any other branch requires auto_commit_allowed. This exists so that when git
 * integration is added it CANNOT bypass the charter defaults — call it first.
 */
export function assertCommitAllowed({ branch = null } = {}, policy = getSamPolicy()) {
  if (!policy.auto_commit_allowed) {
    return { allowed: false, reason: 'auto_commit_allowed is false (charter default).' }
  }
  const isMain = branch === 'main' || branch === 'master'
  if (isMain && !policy.direct_main_commit) {
    return { allowed: false, reason: 'direct_main_commit is false; commit to a branch + PR instead.' }
  }
  return { allowed: true, reason: null }
}

export { readEnvBool }
