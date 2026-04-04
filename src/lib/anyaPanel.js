/**
 * Programmatically open the Anya panel from anywhere in the app.
 * Dispatches a custom event that AnyaFloatingButton listens for.
 */
export function openAnyaPanel({ prefillMessage } = {}) {
  window.dispatchEvent(new CustomEvent("anya:open", { detail: { prefillMessage: prefillMessage ?? null } }))
}
