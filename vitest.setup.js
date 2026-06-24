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

globalThis.ResizeObserver =
  globalThis.ResizeObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
