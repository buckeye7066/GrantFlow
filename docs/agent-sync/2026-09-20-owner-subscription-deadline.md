# Owner-only subscription deadline repair

## Cause and implementation
The gateway always limited native subscription work to half the caller budget.
When an authenticated owner prohibits metered fallback and has no free route,
that reserved half cannot be used by another provider. A valid native reply in
the second half was cancelled and replaced by a failure.

The gateway now uses the available caller budget only for that owner-only case.
The configured subscription cap, 60-second maximum, original caller deadline,
cancellation, verified identity, customer routing, and paid opt-in are unchanged.
An enabled free fallback or opted-in paid fallback retains the existing reserve.

## Verification
Three regression assertions failed against the original gateway (JSON, text,
and premature settlement). The repaired focused suite covers those cases plus
the configured cap and free fallback. Native process/parser tests are unchanged.
Full exact-head release checks and deployment must pass before claiming delivery.

## Remaining scope
This repair does not change the explicit local acceptance subscription shortcut.
It is not a passed exact-50 benchmark, hosted enrollment, or proof that the two
missing grant amounts were acquired. Do not infer global readiness from it.
The independent synthetic native extractor diagnostic returned one grounded
candidate using subscription:codex and no metered fallback; it is a diagnostic,
not a replacement for the failed exact-50 acceptance receipt.
