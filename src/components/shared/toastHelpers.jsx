/**
 * Reusable toast helper functions.
 *
 * Each accepts an optional `options` object so a notification can become a
 * clickable toast that takes the user/admin to where attention is needed:
 *   { navigateTo: "<route>", flash: "<data-flash-id|selector>", duration }
 * Clicking the toast navigates to `navigateTo` and flashes `flash` on arrival
 * (handled by the Toaster + FlashHighlighter).
 */

// Urgency drives BOTH color (white→green→yellow→orange→red) and how long the
// toast stays (base 3.5s, +2s per level) — see use-toast.jsx. An explicit
// `duration` in options still overrides.
function build(base, options = {}) {
  const { navigateTo = null, flash = null, duration, onActivate = null } = options || {};
  const toastArgs = { ...base };
  if (navigateTo) toastArgs.navigateTo = navigateTo;
  if (flash) toastArgs.flash = flash;
  // A click handler that runs instead of (or before) navigation — e.g. open the
  // Anya panel to gather a missing field conversationally.
  if (typeof onActivate === "function") toastArgs.onActivate = onActivate;
  if (typeof duration === "number") toastArgs.duration = duration;
  return toastArgs;
}

export function showSuccessToast(toast, title, description, options) {
  toast(build({ urgency: "success", title, description }, options)); // green
}

export function showErrorToast(toast, title, description, options) {
  toast(build({ urgency: "critical", title, description }, options)); // red, longest
}

export function showWarningToast(toast, title, description, options) {
  toast(build({ urgency: "warning", title, description }, options)); // yellow
}

export function showInfoToast(toast, title, description, options) {
  toast(build({ urgency: "info", title, description }, options)); // white, shortest
}

// Orange — between a warning and a critical error (e.g. action needed soon).
export function showElevatedToast(toast, title, description, options) {
  toast(build({ urgency: "elevated", title, description }, options));
}
