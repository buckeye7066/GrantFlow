try {
  await import("@testing-library/jest-dom")
} catch {
  // Optional: extends expect with DOM matchers when available (e.g. toBeInTheDocument)
}

// Disable the live verification network path (ProPublica + US Census) by
// default in tests so NO test ever hits a live API as a side effect of an
// insert/discovery code path. The dedicated provider tests explicitly opt back
// in (and fully mock node-fetch), so this only affects incidental callers.
process.env.ENABLE_REGISTRY_VERIFICATION = process.env.ENABLE_REGISTRY_VERIFICATION ?? "false"
process.env.ENABLE_CENSUS_GEO = process.env.ENABLE_CENSUS_GEO ?? "false"

// Disable LIVE web search (SearXNG/Brave/DuckDuckGo in webSearchEngine.searchWeb)
// under Vitest, same as the node:test lane (scripts/run-unit-tests.mjs sets this
// for its child process only — the `npm exec -- vitest run` half of `npm run
// unit` never inherited it). Without this, any test that reaches the open-web
// discovery lane (WEB_DISCOVERY_ENABLED defaults ON — e.g. runProfileDiscoveryLive
// in robertDiscoveryDryRunAndDegradation.test.js) issues real DuckDuckGo/search
// requests: an intermittent multi-minute hang/timeout on slow networks. Every
// Vitest consumer of searchWeb mocks the module; a test that truly wants the
// live path can set GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS=true (the engine's
// explicit escape hatch, which overrides this flag).
process.env.GRANTFLOW_TEST_RUNNER = process.env.GRANTFLOW_TEST_RUNNER ?? "1"

// NO TEST MAY SPEND A REAL LLM CALL. Same rule as the two flags above, for the
// one class they did not cover: `utils/aiProviders.invokeJsonWithFallback` and
// its text twin fall back to Anthropic when OpenAI fails, and
// `getAnthropicClient()` builds a REAL client from an ambient
// `ANTHROPIC_API_KEY`. A developer machine that exports provider keys therefore
// turned "the provider returned invalid JSON" tests into live paid calls whose
// answer was a real model's — `aiMatchCanonicalAuthority`'s parse-failure case
// asserted `ai_enhanced === false` and got `true`, because Anthropic answered
// with perfectly good observations. CI has no keys, so it passed there and
// failed only locally: a test whose verdict depends on the developer's shell.
//
// Credentials are removed BEFORE any test module loads. The suites that
// exercise provider behaviour set what they need in their own setup, which runs
// after this file, so they are unaffected. `GRANTFLOW_ALLOW_LIVE_LLM_IN_TESTS`
// is the deliberate escape hatch, mirroring the live-web one above.
if (!/^(1|true|yes|on)$/i.test(String(process.env.GRANTFLOW_ALLOW_LIVE_LLM_IN_TESTS ?? ''))) {
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANYA_OPENAI_MODEL']) {
    delete process.env[key]
  }
}

globalThis.ResizeObserver =
  globalThis.ResizeObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
