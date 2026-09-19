# Private local free-model fallback

The gateway listens only on 127.0.0.1:11435; Ollama stays on 127.0.0.1:11434.
It accepts a dedicated bearer token, an installed allowlisted local model and
bounded non-streaming text completions. Model download/management, tools,
remote model selection, and metered fallback are not exposed. One active
request is allowed; overload returns 429 with Retry-After rather than queuing
unlimited work. Complete output and actual model identity are required.

Windows installation: run manage.ps1 -Action Install -OllamaExe <existing
absolute executable> -Model llama3.2:1b. The two limited-user logon tasks and
DPAPI-protected gateway token are stored outside the checkout under
LocalAppData/Axiom/LocalFreeAi. No model or token belongs in Git. Start the
Ollama and Gateway tasks separately. Remote access, when configured, must use
TLS in front of the token-protected gateway, never the raw Ollama port.

GrantFlow may reference the gateway with a FREE_AI_ROUTE_<NAME>_API_KEY secret
and a free route. A local response is labeled free_or_local, never subscription.
This removes external model-credit dependency, not hardware/time limits.
Extraction eligibility, evidence requirements and acceptance thresholds stay
unchanged. A successful gateway probe is not a passed 50-profile benchmark.

For JSON extraction, set json_mode: true on this explicitly compatible route.
This enables server-enforced JSON syntax without changing evidence validation.
Other routes and text requests retain their existing request format.

## Schema-capable extraction

An Ollama route may opt into `json_schema_mode: true` alongside `json_mode: true`.
The page reader then sends its typed schema through the existing provider
router, with a compact page-only prompt. Other providers and ordinary text
requests keep their existing request format and prompt. The schema bounds
amounts, dates, state codes, lifecycle fields and link IDs. It does not establish
eligibility or truth: the existing page-evidence validator and matcher still do
that. Unquoted facts remain unknown rather than being accepted as valid.

The schema and compact prompt are application-owned, not read from page
instructions. Inventory IDs are taken only after URL sanitation. The normal
prompt-cache version changes with this prompt revision. No public endpoint,
credential, subscription identity, matching threshold or production data is
changed by enabling this request-format capability.
