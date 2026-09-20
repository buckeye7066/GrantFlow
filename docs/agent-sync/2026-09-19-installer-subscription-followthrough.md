# Installer and subscription follow-through

The selected local model is now verified by tools/local-free-ai/model-preflight.mjs before Install changes configuration, credentials or scheduled tasks. The preflight is read-only, uses only the loopback Ollama catalog, rejects unsupported or missing models and unavailable catalogs, and bounds response time and size. The installer copies the verifier alongside its existing runtime files. Supported model names come from the gateway's shared registry.

The regression tests avoid the earlier rejected dynamic PowerShell execution approach: they exercise the verifier with local in-memory response fixtures and inspect installer call ordering. Both tests failed on the previous source; all 9 installer/gateway tests pass after the repair. The actual selected llama3.2:1b model on Home passed the read-only check. PowerShell syntax parsing passed. Related owner routing and ledger suites passed all 46 tests. Full prepush, including lint, typecheck, secret scan and production build, passed.

The push CodeQL job on 8fd9e2a failed its existing count ratchet because a newly added test compared pageUrl by substring. Both test URL comparisons now use parsed hostname equality; the CodeQL baseline is unchanged. Required hosted checks still must run on the new commit before merge.

Owner authentication and general crawler acceptance are different scopes. The existing dedicated Codex client reports ready for ChatGPT authentication, and the installed GrantFlow Owner AI Bridge task is running against GrantFlow production. Earlier owner-browser proof at 777eeeb is preserved in the release verification record. None of these observations proves that an isolated no-owner benchmark is using that subscription; its launcher explicitly disables the owner bridge and uses cloud-local inference. API balance is not a requirement for a successful subscription-backed owner request.

This note does not declare a completed fifty-profile acceptance or completed ForgePress integration. Preserve customer billing isolation, all qualification gates, and accurate completion states.
