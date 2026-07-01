/**
 * hamiltonMissingInfoAnya.js
 *
 * Turns a `hamilton_missing_info` notification into an Anya-panel open request:
 * a conversation PREFILLED to ask the user for exactly the field(s) Hamilton
 * flagged. Anya saves each answer to the profile (profile.updateSection, which
 * asks for confirmation first), and once every flagged item is supplied the task
 * auto-resumes (backend resumeTaskAfterMissingInfo) so Hamilton continues using
 * the new value in the portal.
 *
 * Consumed by NotificationBell (persistent card click) and HamiltonToastBridge
 * (toast click) so BOTH surfaces route into the conversation rather than only the
 * static field editor.
 */

/**
 * @param {object} notification a /api/notifications row ({ type, data, ... })
 * @returns {null | { profileId, title, prefillMessage, metadata }}
 *   null when this isn't a conversational missing-info notification (caller then
 *   falls back to the field-editor deep-link).
 */
export function buildMissingInfoAnyaOpen(notification) {
  const type = String(notification?.type || '')
  if (!/missing_info/.test(type)) return null
  const d = notification?.data || {}
  const profileId = d.profile_id || d.profileId || notification?.profile_id || null
  if (!profileId) return null

  // Items Hamilton needs (key + label). Prefer the structured list; fall back to
  // the primary field/label the backend always sends.
  let items = Array.isArray(d.missing_items) ? d.missing_items.filter((m) => m && m.key) : []
  if (items.length === 0) {
    const key = d.field || d.missing_key || d.key || d.missing_field
    if (key) items = [{ key, label: d.field_label || null, kind: 'field' }]
  }
  if (items.length === 0) return null

  const fundingSource = d.funding_source_title ? ` to finish "${d.funding_source_title}"` : ''
  const bullets = items
    .map((m) => `- ${m.label || m.key}${m.kind === 'document' ? ' (a document to upload)' : ''}`)
    .join('\n')

  const prefillMessage = [
    `Hamilton needs ${items.length === 1 ? 'one detail' : `${items.length} details`}${fundingSource} and paused until we have ${items.length === 1 ? 'it' : 'them'}:`,
    bullets,
    'Please ask me for these conversationally, one at a time, in plain language — explain briefly why each is needed. When I answer, save it to my profile using the profile.updateSection tool (confirm with me before writing). The moment everything is supplied, Hamilton resumes automatically and continues the application.',
    'For any official ID, SSN, EIN, tax number, license number, or benefit/medical proof, do NOT ask me to type the number into chat — ask me to upload the official document to the profile instead, so there is an audit trail. Never repeat a full sensitive identifier back to me.',
  ].join('\n\n')

  return {
    profileId,
    title: 'Hamilton needs a detail',
    prefillMessage,
    metadata: {
      source: 'hamilton_missing_info',
      intent: 'supply_missing_field',
      profile_id: profileId,
      task_id: d.task_id || null,
      missing_keys: items.map((m) => m.key),
    },
  }
}

export default { buildMissingInfoAnyaOpen }
