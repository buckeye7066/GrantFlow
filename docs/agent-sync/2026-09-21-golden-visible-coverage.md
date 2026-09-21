# Golden coverage must survive display rules

Production verification found required-source matches that passed the golden sentinel but were hidden by link verification. The sentinel now requires a surfaced matching lane and the shared display predicate, preserving the existing eligibility, proof, lifecycle and pointer rules. Saved pipeline membership still counts as coverage; it should not be rediscovered as a new result. Hidden, inactive, rejected, unproved and retired-lane matches no longer produce a green check.

The Medicaid HCBS directory moved from its retired `/index.html` URL to `https://www.medicaid.gov/medicaid/home-community-based-services`. Both the engine registry and legacy waiver crawler now use the current official address. Existing production rows require evidence-backed URL repair and normal link reverification; this change does not unhide links automatically.

Validation: all five new sentinel regressions failed before the fix; 32 sentinel, pointer ranking and registry parity tests pass afterward. Production Findhelp access and a completed fresh Amy cohort remain independent verification requirements.
