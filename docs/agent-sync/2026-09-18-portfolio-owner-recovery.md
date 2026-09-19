# Interrupted owner-routing recovery

Four review findings on c8f847b were reproduced before repair: durable queue ownership was lost after restart; detached deadline errors did not have the dispatcher timeout code; background replies were silently clamped to four minutes; code-crawl exclusion ended before an uncooperative editing phase settled.

Owner intent is now signed at authenticated enqueue paths with a job/type/profile-bound proof. Caller-supplied owner metadata is discarded. Queue drains use the stored proof, never the draining caller's privileges. Orphan retries validate and rebind the original proof; ordinary jobs remain ordinary even when an owner starts a drain. Invalid, revoked or re-bound proof fails without model execution or a metered fallback.

Background replies and their scope use one validated bounded timeout. Detached deadline errors carry JOB_TIMEOUT. Code repair retains its exclusion until the underlying work settles and checks cancellation between phases.

Executed: four initial regressions failed, then the focused queue, scope, cancellation and enqueue tests passed. The related 103-suite run passed 1,192 tests before the final neutral-drainer review refinement; the final exact-head suite and release gate remain required. Existing subscription/free routing, qualification rules and acceptance history were not loosened. Source changes are in an isolated worktree; the locked user checkout and unrelated portal fixes remain untouched.
