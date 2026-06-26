/**
 * validateImports.js — Startup import validation for critical modules.
 *
 * Dynamically imports each module that the server depends on at runtime.
 * Modules loaded via lazyRouter() silently 404 if their import tree fails
 * (e.g., a missing native binary). This check surfaces those failures at
 * boot time so operators see clear warnings in the logs.
 *
 * Does NOT crash the server — only logs warnings and returns a summary.
 */

const CRITICAL_MODULES = [
  {
    name: 'crawlerDispatcher',
    specifier: '../services/crawlerDispatcher.js',
    description: 'Crawler job dispatch & queue drain',
  },
  {
    name: 'geoCrawlRouter',
    specifier: '../routes/geoCrawl.js',
    description: 'Geo crawl route handler',
  },
  {
    name: 'anyaToolRegistry',
    specifier: '../services/anyaToolRegistry.js',
    description: 'Anya tool registry (function calling)',
  },
  {
    name: 'geoCrawlRunStore',
    specifier: '../services/geoCrawlRunStore.js',
    description: 'Geo crawl run persistence layer',
  },
]

/** @type {{ ok: boolean, failures: string[], details: Array<{ name: string, ok: boolean, error?: string }>, checkedAt: string } | null} */
let _lastResult = null

/**
 * Dynamically imports every critical module and logs the outcome.
 * Safe to call at any point — never throws.
 *
 * @returns {Promise<{ ok: boolean, failures: string[], details: Array<{ name: string, ok: boolean, error?: string }>, checkedAt: string }>}
 */
export async function validateCriticalImports() {
  const details = []
  const failures = []

  for (const mod of CRITICAL_MODULES) {
    try {
      await import(mod.specifier)
      console.log(`[startup] OK: ${mod.name} (${mod.description})`)
      details.push({ name: mod.name, ok: true })
    } catch (err) {
      const message = err?.message || String(err)
      console.error(`[startup] CRITICAL: Failed to import ${mod.name}: ${message}`)
      failures.push(`${mod.name}: ${message}`)
      details.push({ name: mod.name, ok: false, error: message })
    }
  }

  const ok = failures.length === 0
  if (ok) {
    console.log(`[startup] All ${CRITICAL_MODULES.length} critical modules validated successfully`)
  } else {
    console.warn(
      `[startup] ${failures.length}/${CRITICAL_MODULES.length} critical module(s) failed to import — affected routes may return 404`,
    )
  }

  _lastResult = { ok, failures, details, checkedAt: new Date().toISOString() }
  return _lastResult
}

/**
 * Returns the most recent validation result, or null if validation hasn't run yet.
 */
export function getImportValidationResult() {
  return _lastResult
}
