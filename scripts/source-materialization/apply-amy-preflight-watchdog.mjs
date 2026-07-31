#!/usr/bin/env node

// Preserve the verified watchdog materializer byte-for-byte, then apply the
// flywheel precision and exact-SHA production corrections through the same
// permanent npm lifecycle seam.
await import(`./apply-amy-preflight-watchdog-core.mjs?materialize=${Date.now()}`)
await import(`./apply-amy-flywheel-precision.mjs?materialize=${Date.now()}`)
await import(`./apply-amy-exact-sha-cleanup.mjs?materialize=${Date.now()}`)
await import(`./apply-amy-organization-identity-dedupe.mjs?materialize=${Date.now()}`)
