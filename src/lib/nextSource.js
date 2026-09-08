/** The first pipeline row with an id is the one the end-user home tells them to start with. */
export function pickNextSource(grants) {
  const list = Array.isArray(grants) ? grants.filter((g) => g && g.id !== null && g.id !== undefined) : []
  return list[0] || null
}
