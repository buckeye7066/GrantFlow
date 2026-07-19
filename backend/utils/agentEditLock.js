/**
 * agentEditLock.js
 *
 * Tiny shared helper for the multi-agent live-editing lock documented in
 * CLAUDE.md ("Live-editing lock"). When a file named `.agent-edit-lock` exists
 * at the repo root, a human + another assistant (Cursor's agent, Anya's
 * scheduler) are actively editing the working tree, and no autonomous writer may
 * commit/dispatch a code change until the lock is released.
 *
 * This module is intentionally dependency-free and synchronous so any apply path
 * (the owner adversarial-repair tool, Sam's branch proposer) can cheaply refuse
 * BEFORE it mutates anything or dispatches a workflow.
 */

import fssync from 'node:fs'
import path from 'node:path'

export const AGENT_EDIT_LOCK_FILENAME = '.agent-edit-lock'

/**
 * True when `.agent-edit-lock` is present at the given repo root.
 *
 * @param {string} [repoRoot=process.cwd()] absolute path to the repo root.
 * @returns {boolean}
 */
export function isAgentEditLockPresent(repoRoot = process.cwd()) {
  try {
    const root = String(repoRoot || process.cwd())
    return fssync.existsSync(path.join(root, AGENT_EDIT_LOCK_FILENAME))
  } catch {
    // Fail SAFE: if we cannot tell, do NOT block (the lock is an advisory
    // coordination signal, not a security boundary — the real apply gates
    // remain the CI/PR workflow and Sam's charter policy).
    return false
  }
}

export default isAgentEditLockPresent
