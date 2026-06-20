/**
 * automationPreferences.js — canonical per-profile automation toggle model.
 *
 * Single source of truth for the per-profile "Automations" switches the user
 * sees on the profile screen. Each toggle maps to a REAL backend behaviour that
 * is gated on it. Defaults are ALL ON so existing profiles keep their current
 * (pre-feature) behaviour until the user deliberately turns something off.
 *
 * Stored on the profile_sections row keyed `automation_preferences`, under the
 * `automations` sub-key (alongside the existing `portal_access` schedule), e.g.
 *   { portal_access: {...}, automations: { hamilton_autopilot: true, ... } }
 *
 * Consumed by:
 *   - backend: GET/PUT /api/profiles/:id/automation-preferences (read/write),
 *     and the enforcement points listed per-toggle below.
 *   - frontend: the Automations card in components/profiles/ProfileOverview.
 */

/**
 * Canonical toggle definitions. `key` is the persisted field; `default` is the
 * behaviour-preserving default; `enforced` flags whether the backend currently
 * honours the toggle at a real gate (vs. surfaced-but-not-yet-wired).
 */
export const AUTOMATION_TOGGLES = Object.freeze([
  Object.freeze({
    key: 'hamilton_autopilot',
    label: 'Hamilton auto-apply',
    description:
      'Let Hamilton run scheduled, unattended application runs for this profile (open portals, '
      + 'fill forms, save drafts). Per-application authorization on the launch screen still applies.',
    default: true,
    enforced: true,
  }),
  Object.freeze({
    key: 'hamilton_auto_submit',
    label: 'Hamilton auto-submit',
    description:
      'Allow Hamilton to submit a completed application without a final human review. '
      + 'Turn off to have Hamilton stop and hand back for review before submitting.',
    default: true,
    enforced: true,
  }),
  Object.freeze({
    key: 'pipeline_processing',
    label: 'Pipeline auto-processing',
    description:
      'Let the AI advance this profile’s grants through pipeline stages automatically '
      + '(the "Process All" automation, when run on a schedule).',
    default: true,
    enforced: true,
  }),
  Object.freeze({
    key: 'discovery_auto_add',
    label: 'Discovery auto-add',
    description:
      'Allow scheduled crawlers / discovery to add newly-matched funding opportunities to this '
      + 'profile’s pipeline automatically.',
    default: true,
    enforced: false, // TODO: wire into the discovery/crawler auto-add path.
  }),
])

export const AUTOMATION_TOGGLE_KEYS = Object.freeze(AUTOMATION_TOGGLES.map((t) => t.key))

/**
 * Behaviour-preserving defaults — every toggle ON.
 */
export function defaultAutomationToggles() {
  const out = {}
  for (const t of AUTOMATION_TOGGLES) out[t.key] = t.default
  return out
}

/**
 * Coerce an arbitrary stored / incoming blob into the canonical shape:
 * only known keys, booleans, missing keys filled from defaults. A missing or
 * malformed blob resolves to all-defaults (= current behaviour).
 */
export function normalizeAutomationToggles(raw) {
  const base = defaultAutomationToggles()
  if (!raw || typeof raw !== 'object') return base
  for (const t of AUTOMATION_TOGGLES) {
    if (Object.prototype.hasOwnProperty.call(raw, t.key)) {
      base[t.key] = raw[t.key] === true
    }
  }
  return base
}

/**
 * Read a single toggle from a profile's automation_preferences blob,
 * defaulting to the behaviour-preserving value when unset. Use this at every
 * enforcement point so an absent preference NEVER disables an automation.
 *
 * @param {object|null} prefs  the parsed automation_preferences section blob
 * @param {string} key         one of AUTOMATION_TOGGLE_KEYS
 * @returns {boolean}
 */
export function isAutomationEnabled(prefs, key) {
  const def = AUTOMATION_TOGGLES.find((t) => t.key === key)?.default ?? true
  const automations = prefs && typeof prefs === 'object' ? prefs.automations : null
  if (!automations || typeof automations !== 'object') return def
  if (!Object.prototype.hasOwnProperty.call(automations, key)) return def
  return automations[key] === true
}
