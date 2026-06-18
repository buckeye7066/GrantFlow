/**
 * Tiny module-level holder for the current react-router route (path + search,
 * relative to the app basename). Updated by <FlashHighlighter/> on every
 * navigation and read by toast() so EVERY toast can remember where it was fired
 * — that origin becomes the toast's click target when it doesn't set an
 * explicit navigateTo. Using react-router's location (not window.location)
 * keeps it basename-correct for navigate().
 */

let current = ""

export function setCurrentRoute(path) {
  current = String(path || "")
}

export function getCurrentRoute() {
  return current
}
