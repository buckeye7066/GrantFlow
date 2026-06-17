/**
 * Reusable toast helper functions
 */

/**
 * Display a success toast notification
 * @param {Function} toast - The toast function from useToast hook
 * @param {string} title - Toast title
 * @param {string} description - Toast description
 */
export function showSuccessToast(toast, title, description) {
  toast({
    title,
    description,
  });
}

/**
 * Display an error toast notification
 * @param {Function} toast - The toast function from useToast hook
 * @param {string} title - Toast title
 * @param {string} description - Toast description
 */
export function showErrorToast(toast, title, description) {
  toast({
    variant: "destructive",
    title,
    description,
  });
}

/**
 * Display a warning toast (uses default variant; we attach a yellow accent
 * via title styling on the consumer side when needed). Yana uses this for
 * "needs info / login required" toasts.
 */
export function showWarningToast(toast, title, description) {
  toast({
    title,
    description,
    duration: 6000,
  });
}

/**
 * Display an info toast — used for low-urgency Yana notifications
 * (draft started, application ready for review, etc.).
 */
export function showInfoToast(toast, title, description) {
  toast({
    title,
    description,
    duration: 5000,
  });
}