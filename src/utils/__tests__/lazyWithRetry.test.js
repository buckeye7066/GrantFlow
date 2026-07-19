import { describe, expect, it } from "vitest"

import { looksLikeStaleChunkError } from "@/utils/lazyWithRetry"

describe("looksLikeStaleChunkError", () => {
  it("matches the classic failed-dynamic-import shapes", () => {
    for (const msg of [
      "Failed to fetch dynamically imported module: https://app/assets/Start-abc.js",
      "Importing a module script failed.",
      "error loading dynamically imported module",
      "Loading chunk 42 failed.",
      "Expected a JavaScript module script but the server responded with a MIME type of text/html",
    ]) {
      expect(looksLikeStaleChunkError(new Error(msg)), msg).toBe(true)
    }
  })

  it("matches ChunkLoadError by name", () => {
    const err = new Error("boom")
    err.name = "ChunkLoadError"
    expect(looksLikeStaleChunkError(err)).toBe(true)
  })

  // Regression: a stale/partial chunk resolves to an undefined module namespace,
  // so React.lazy reads `.default` off `undefined` at render time. This shape
  // previously fell through to a scary boundary + owner-facing 500 email.
  it("matches the React.lazy undefined-module `.default` shape (all engines)", () => {
    for (const msg of [
      "Cannot read properties of undefined (reading 'default')", // V8 / Chrome
      "Cannot read property 'default' of undefined", // legacy V8
      "undefined is not an object (evaluating 'e.default')", // Safari
    ]) {
      expect(looksLikeStaleChunkError(new Error(msg)), msg).toBe(true)
    }
  })

  it("does NOT match unrelated runtime errors", () => {
    for (const msg of [
      "Cannot read properties of undefined (reading 'name')",
      "x is not a function",
      "Network request failed",
      "Element type is invalid: expected a string but got: undefined",
    ]) {
      expect(looksLikeStaleChunkError(new Error(msg)), msg).toBe(false)
    }
  })

  it("tolerates non-Error inputs", () => {
    expect(looksLikeStaleChunkError(undefined)).toBe(false)
    expect(looksLikeStaleChunkError("Failed to fetch dynamically imported module")).toBe(true)
  })
})
