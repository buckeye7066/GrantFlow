/**
 * Dry-run is REMOVED OUTRIGHT from owner-facing routes (owner order
 * 2026-08-13: "I don't want dry runs, I want work" — a "safe" mode is how a
 * 6-hour run found 3,464 defects, fixed zero, and exited 0). Removed means a
 * request NAMING the old flag FAILS with 400 — it never silently proceeds as
 * a real run the caller believed was a preview, and it is never replaced by
 * a confirmation gate. Companion to agentControlTypes.assertNoDryRunOption
 * (the agent-control choke point, #1389); this is the HTTP-route edition.
 *
 * Returns true (and writes the 400) when the body names the flag — callers
 * `if (rejectDryRunBody(req, res)) return`.
 */
export function rejectDryRunBody(req, res) {
  const body = req?.body
  if (body && typeof body === 'object' && ('dry_run' in body || 'dryRun' in body)) {
    res.status(400).json({
      ok: false,
      error: 'dry_run has been removed (owner no-dry-runs order). Every run does real work — drop the flag.',
    })
    return true
  }
  return false
}
