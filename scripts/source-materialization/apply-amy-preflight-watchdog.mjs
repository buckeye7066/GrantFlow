#!/usr/bin/env node

// Preserve the verified watchdog materializer byte-for-byte, then apply the
// flywheel precision correction through the same permanent npm lifecycle seam.
await import(`./apply-amy-preflight-watchdog-core.mjs?materialize=${Date.now()}`)
await import(`./apply-amy-flywheel-precision.mjs?materialize=${Date.now()}`)
