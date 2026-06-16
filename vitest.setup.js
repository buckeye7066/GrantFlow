try {
  await import("@testing-library/jest-dom")
} catch {
  // Optional: extends expect with DOM matchers when available (e.g. toBeInTheDocument)
}

globalThis.ResizeObserver =
  globalThis.ResizeObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
