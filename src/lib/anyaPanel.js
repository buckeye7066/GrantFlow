/**
 * Programmatically open the Anya panel from anywhere in the app.
 * Dispatches a custom event that AnyaFloatingButton listens for.
 */
export function openAnyaPanel({ prefillMessage, profileId, title, metadata } = {}) {
  window.dispatchEvent(new CustomEvent("anya:open", {
    detail: {
      prefillMessage: prefillMessage ?? null,
      profileId: profileId ?? null,
      title: title ?? null,
      metadata: metadata ?? null,
    },
  }))
}
