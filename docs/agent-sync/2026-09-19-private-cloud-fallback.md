# Private production fallback

The existing cloud service has unused CPU/memory capacity. This release adds
an optional CPU-only Ollama runtime inside that same container. It does not
connect to Home, expose a model port, enroll subscription credentials or share
an individual account. It uses existing hosting CPU/memory, not model API credits.

The engine is pinned to official Ollama 0.34.2, and the Llama 3.2 1B model
manifest is pinned to baf6a787fdffd633537aa2eb51cfd54cb93ff08e28040095462bb63daf552878.
The image build downloads/verifies the model and runs real offline inference.
CPU libraries, weights and the model license are shipped in the runtime.
Built with Llama. Model license: /app/local-model-license.txt in the image.

GRANTFLOW_LOCAL_MODEL_ENABLED=1 enables the private process. It receives no
application/provider secrets, binds only to 127.0.0.1:11434, disables cloud mode,
loads one model, allows two parallel requests and queues at most eight. The
normal container startup waits for the exact model identity. Unexpected engine
exit requests the application's normal shutdown and existing supervised restart.
No download or model-management route is exposed by the application.

The existing FREE_AI_ROUTES setting can name http://127.0.0.1:11434/v1 with model
llama3.2:1b, json_mode:true and json_schema_mode:true. Keep other existing free
routes; the local route provides an independent fallback when quotas run out.
All evidence validation, source verification and admission requirements remain
unchanged. Model/server health is not a completed 50-profile acceptance run.

This is a different deployment architecture, not an alternative path into Home
or a retry of blocked worker enrollment. Subscription-specific gaps remain
separate until the normal activation actions can be completed.

The runtime includes a public-source acceptance launcher. It fetches the exact
release commit into a temporary clone, verifies commit, dependency lock and
clean worktree, then executes the unchanged canonical fifty-profile command.
It forwards no production DB, mail, authentication, paid-model or GitHub
credentials. Search/government catalog keys are the only retained service
configuration. Results persist under /data/acceptance-results; the temporary
checkout and child-created databases are removed afterward. A two-hour
operational ceiling produces failure, never a smaller passing cohort. No mock
discovery or source inspector replaces the canonical acceptance engine.

GRANTFLOW_PAGE_FACT_MEMO_ENABLED=1 avoids repeatedly inferring identical freshly
fetched page bytes across profiles. A 256-entry/16 MiB immutable memo is keyed
by full bounded page bytes, source URL and extractor/prompt versions. Every
profile still runs its own matching and source/target checks. Changed content,
provider failures and cancelled requests never become cached success. Hits are
explicitly tagged extraction_cached; no model usage or subscription receipt is
fabricated. Empty outputs expire after one minute; other snapshots after one
hour. This limits wasted inference, not the number of profiles or required searches.

The OpenAI-compatible client's default request timeout is 12 seconds, which is
shorter than the existing 60-second page-extraction deadline. The local CPU
configuration sets FREE_AI_TIMEOUT_MS=60000 in both production and the isolated
acceptance environment. Existing caller deadlines and cancellation still apply;
this does not extend a shorter caller budget or change any acceptance criterion.
