/**
 * Reusable toast helper functions.
 *
 * Each accepts an optional `options` object so a notification can become a
 * clickable toast that takes the user/admin to where attention is needed:
 *   { navigateTo: "<route>", flash: "<data-flash-id|selector>", duration }
 * Clicking the toast navigates to `navigateTo` and flashes `flash` on arrival
 * (handled by the Toaster + FlashHighlighter).
 */

function build(base, options = {}) {
  const { navigateTo = null, flash = null, duration } = options || {};
  const toastArgs = { ...base };
  if (navigateTo) toastArgs.navigateTo = navigateTo;
  if (flash) toastArgs.flash = flash;
  if (typeof duration === "number") toastArgs.duration = duration;
  return toastArgs;
}

export function showSuccessToast(toast, title, description, options) {
  toast(build({ title, description }, options));
}

export function showErrorToast(toast, title, description, options) {
  toast(build({ variant: "destructive", title, description }, options));
}

export function showWarningToast(toast, title, description, options) {
  toast(build({ title, description, duration: 6000 }, options));
}

export function showInfoToast(toast, title, description, options) {
  toast(build({ title, description, duration: 5000 }, options));
}
