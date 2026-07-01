/**
 * browserLaunch.js — the single source of truth for Chromium launch args used by
 * every Hamilton browser flow.
 *
 * Railway/Docker containers give a tiny `/dev/shm` (64 MB) by default. Chromium
 * writes shared-memory there and, without `--disable-dev-shm-usage`, OOM-crashes
 * the whole container under load — which is exactly what took prod down during a
 * bulk portal-automation run (dozens of serial browsers, silent SIGKILL restarts,
 * no JS stack). `--no-sandbox` is required in the unprivileged container, and
 * `--disable-gpu` trims memory in headless. Every `chromium.launch(...)` in the
 * Hamilton services MUST spread these so no launch site drifts back to the
 * OOM-prone bare default.
 */
export const CHROMIUM_CONTAINER_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
])
