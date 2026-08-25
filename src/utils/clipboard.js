/**
 * Copy text in modern browsers and in Safari/iOS WebViews where the async
 * Clipboard API can be missing or can reject outside a secure context.
 *
 * The legacy path runs only inside the user's click handler and removes its
 * temporary textarea immediately. Callers get an honest boolean instead of a
 * rejected promise or an unconditional "Copied" state.
 */
export async function copyTextToClipboard(
  value,
  {
    navigatorRef = globalThis.navigator,
    documentRef = globalThis.document,
  } = {},
) {
  const text = String(value ?? '')

  if (typeof navigatorRef?.clipboard?.writeText === 'function') {
    try {
      await navigatorRef.clipboard.writeText(text)
      return true
    } catch {
      // Safari and embedded WebViews may expose the API but reject it. Fall
      // through to the user-gesture-compatible selection path below.
    }
  }

  if (!documentRef?.body || typeof documentRef.createElement !== 'function') return false
  if (typeof documentRef.execCommand !== 'function') return false

  const textarea = documentRef.createElement('textarea')
  const previouslyFocused = documentRef.activeElement
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  Object.assign(textarea.style, {
    position: 'fixed',
    inset: '0 auto auto -9999px',
    opacity: '0',
    pointerEvents: 'none',
  })

  documentRef.body.appendChild(textarea)
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange?.(0, text.length)
    return documentRef.execCommand('copy') === true
  } catch {
    return false
  } finally {
    textarea.remove()
    previouslyFocused?.focus?.({ preventScroll: true })
  }
}
