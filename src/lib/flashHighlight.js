/**
 * flashHighlight — scroll to and visually "flash" the element(s) a notification
 * points at, so a clickable toast can land the user/admin exactly on what needs
 * attention.
 *
 * A target may be:
 *   - a `data-flash-id="<name>"` value (preferred — decoupled from styling ids),
 *   - a plain element id,
 *   - or any CSS selector (fallback).
 * Multiple targets are comma-separated.
 *
 * The flash is driven by the `.gf-flash` class + keyframes in src/index.css.
 * Because the destination may still be rendering (route change, tab switch,
 * modal open), we retry for a short window until the element exists.
 */

const FLASH_CLASS = 'gf-flash'
const FLASH_VISIBLE_MS = 2800

function cssEscape(value) {
  if (typeof window !== 'undefined' && window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value)
  }
  return String(value).replace(/["\\\]]/g, '\\$&')
}

function resolveElements(target) {
  const t = String(target || '').trim()
  if (!t || typeof document === 'undefined') return []
  const found = new Set()
  // 1) data-flash-id (preferred)
  document.querySelectorAll(`[data-flash-id="${cssEscape(t)}"]`).forEach((el) => found.add(el))
  // 2) element id
  if (found.size === 0) {
    const byId = document.getElementById(t)
    if (byId) found.add(byId)
  }
  // 3) raw CSS selector (best-effort)
  if (found.size === 0) {
    try { document.querySelectorAll(t).forEach((el) => found.add(el)) } catch { /* invalid selector */ }
  }
  return [...found]
}

export function parseFlashTargets(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean)
  return String(input || '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * Flash one or more targets. Retries while the destination renders.
 * @param {string|string[]} targetsInput comma-separated targets or array
 */
export function flashHighlight(targetsInput, { retries = 16, intervalMs = 250 } = {}) {
  if (typeof document === 'undefined') return
  const targets = parseFlashTargets(targetsInput)
  if (targets.length === 0) return

  let attempt = 0
  const run = () => {
    const els = targets.flatMap(resolveElements)
    if (els.length > 0) {
      try { els[0].scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch { /* ignore */ }
      els.forEach((el) => {
        el.classList.remove(FLASH_CLASS)
        // Force reflow so re-adding the class restarts the animation.
        void el.offsetWidth
        el.classList.add(FLASH_CLASS)
        window.setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_VISIBLE_MS)
      })
      return
    }
    attempt += 1
    if (attempt < retries) window.setTimeout(run, intervalMs)
  }
  // Defer one tick so a route change / tab switch can render first.
  window.setTimeout(run, 120)
}

/**
 * Compose a destination URL that carries a `flash` target, so navigating there
 * triggers the flash on arrival (handled by <FlashHighlighter/>).
 */
export function withFlashParam(path, flash) {
  if (!path) return path
  const targets = parseFlashTargets(flash)
  if (targets.length === 0) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}flash=${encodeURIComponent(targets.join(','))}`
}
