# Agent routing and submission verification

John's AI drafting entry point previously required an Anthropic key before trying any model. It now uses the shared JSON gateway: canonical owner subscription first, then configured API routes when allowed, then configured free/local routes. Customer calls never acquire owner subscription scope. The existing organization-research prompt, output checks and code-generated footer remain; receipts identify the actual model, provider and billing mode. Explicit JOHN_AI_DRAFTING=off still disables AI drafting. The shared gateway owns retries; the unused JOHN_AI_MAX_RETRIES setting is removed.

Free routes now pass their allocated deadline into the SDK request, avoiding the SDK's shorter implicit default. An explicit FREE_AI_TIMEOUT_MS ceiling still applies. A live local-model extraction completed in 20.4 seconds with grounded bus-grant facts; no API keys or paid clients were configured. This verifies the local route, not production throughput or every funding page.

Hamilton's browser test accepts an explicit installed Chromium executable and fails when that configured executable is unavailable. Both real-Chrome fixture cases passed: an authorized submission reached confirmation, and a missing required SSN prompted for the missing value without fabrication. The portal and captcha provider were fixtures, not an external funding submission.

These repairs do not certify every original agent, billing or funding-discovery requirement. The native owner Codex invocation still fails during app-server initialization with Access is denied; app-specific installation_id read/write access returned EPERM under this workspace's filesystem policy. Application fallbacks do not repair that underlying filesystem restriction.
