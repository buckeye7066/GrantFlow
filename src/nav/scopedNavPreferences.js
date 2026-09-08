/** Navigation choices belong to an account and workspace, not a shared browser. */
export function navPreferenceKey(scope) {
  return scope ? 'grantflow:nav:v2:' + encodeURIComponent(scope) : null
}
export function readScopedNav(scope, defaults = [], activeGroup = null, storage) {
  let values = null
  const key = navPreferenceKey(scope)
  try {
    const target = storage ?? globalThis.localStorage
    const parsed = key ? JSON.parse(target?.getItem(key) || 'null') : null
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) values = parsed
  } catch { /* Private browsing and corrupt caches retain default navigation. */ }
  const allowed = new Set(defaults)
  const result = new Set((values ?? defaults).filter((id) => allowed.has(id)))
  if (activeGroup && allowed.has(activeGroup)) result.add(activeGroup)
  return result
}
export function writeScopedNav(scope, open, storage) {
  const key = navPreferenceKey(scope)
  try {
    const target = storage ?? globalThis.localStorage
    if (key) target?.setItem(key, JSON.stringify([...open]))
  } catch { /* Navigation remains usable without browser storage. */ }
}
