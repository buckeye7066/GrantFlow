/**
 * Deep-link click identity for ProfileDetail (?tab=&section=&field=&focus=).
 *
 * THE DEAD-CLICK CLASS THIS PREVENTS: the Profile Action Plan / checklist /
 * reminder buttons are router <Link>s into ProfileDetail. A handler effect
 * keyed only on the PARAM VALUES runs once per unique value set — so the
 * moment the URL already carries the target params, re-clicking the same
 * button changes no dependency and the click does nothing. React-router
 * assigns a NEW location.key on every navigation (even to an identical URL),
 * so the key must be part of the click identity: same params + new key =
 * a real user click that must be handled again.
 */

export function isActionableDeepLink({ tab, section, field, focus } = {}) {
  return Boolean(tab || section || field || focus)
}

export function buildDeepLinkToken({ locationKey, tab, section, field, focus } = {}) {
  return `${locationKey || ""}|${tab || ""}|${section || ""}|${field || ""}|${focus || ""}`
}
