# Free-only acceptance and local fallback, September 18

The user excluded pull-request merging from this continuation. These repairs
remain on their feature branch; no main/production completion is claimed.

Acceptance preflight now obtains free/local routes from the canonical route
validator, after disposable database/email isolation. It still requires a real
grounded extraction result. The exact-50 workflow can receive dedicated free
route configuration without a paid API key. No benchmark or eligibility
threshold was changed, reset or bypassed.

A real local-model failure exposed missing structured-output negotiation.
Free routes may explicitly opt into json_mode:true. Only JSON calls to those
routes send response_format:json_object; ordinary endpoints and text calls
retain their previous behavior. This is a syntax contract, not evidence that
all model facts are correct. The existing grounding validator still removes
unsupported facts. A successful local extraction is not a qualified admission.

Regression evidence: four new acceptance tests and one structured-output test
failed before the respective repairs. Final affected tests: 91 passed; gateway
and acceptance-workflow native tests: 10 passed. Changed JavaScript lint and
diff checks passed. The earlier full run recorded 10,862 passing tests, a
SQLite import I/O failure in crawlerFetchTimeout, and the newly introduced red
JSON-mode test before its implementation completed. Both failing files pass
in the final affected run. A fresh whole-repository green run is not claimed.

The new optional loopback gateway exposes only token-protected, bounded local
text completions. It never exposes Ollama management or external paid models.
Its limited-user Windows startup tasks keep credentials in DPAPI outside Git.
Cloud ingress was not enabled. All four production coverage/cohort/admission/
parity findings therefore remain open pending live production measurements.
