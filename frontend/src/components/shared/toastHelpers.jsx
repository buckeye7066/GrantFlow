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