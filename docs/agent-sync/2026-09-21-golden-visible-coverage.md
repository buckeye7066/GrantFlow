# Golden coverage must survive display rules

Production verification found required-source matches that passed the golden sentinel but were hidden by link verification. The sentinel now requires a surfaced matching lane and the shared display predicate, preserving the existing eligibility, proof, lifecycle and pointer rules. Saved pipeline membership still counts as coverage; it should not be rediscovered as a new result. Hidden, inactive, rejected, unproved and retired-lane matches no longer produce a green check.

The Medicaid HCBS directory moved from its retired `/index.html` URL to `https://www.medicaid.gov/medicaid/home-community-based-services`. Both the engine registry and legacy waiver crawler now use the current official address. Existing production rows require evidence-backed URL repair and normal link reverification; this change does not unhide links automatically.

Validation: all five new sentinel regressions failed before the fix; 32 sentinel, pointer ranking and registry parity tests pass afterward. Production Findhelp access and a completed fresh Amy cohort remain independent verification requirements.

The per-profile coverage audit also lost lifecycle flags and structured application metadata in its narrow SQL projection. It now passes the full catalog row to the shared predicates, with the existing legacy-schema fallbacks retained. The hidden-row SQL regression failed before this correction; 128 related coverage/golden tests pass. This prevents self-heal decisions based on inflated hidden-resource counts. GitHub CI is currently blocked before job startup by an account billing lock; local checks are not a substitute for the mandatory merge gate.
