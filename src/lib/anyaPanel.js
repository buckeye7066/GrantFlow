/**
 * Programmatically open the Anya panel from anywhere in the app.
 * Dispatches a custom event that AnyaFloatingButton listens for.
 */
export function openAnyaPanel({ prefillMessage, prefillHidden, profileId, title, metadata } = {}) {
  window.dispatchEvent(new CustomEvent("anya:open", {
    detail: {
      prefillMessage: prefillMessage ?? null,
      // prefillHidden=true → the prefill is Anya's PRIVATE script (interview
      // seeds, question queues): it is sent to the model but never rendered in
      // the chat transcript. Leave false for prefills phrased as the user's own
      // request ("Help me find grants…"), which should stay visible.
      prefillHidden: prefillHidden === true,
      profileId: profileId ?? null,
      title: title ?? null,
      metadata: metadata ?? null,
    },
  }))
}
