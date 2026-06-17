/**
 * manualPortalAdapter.js
 *
 * Fallback adapter for portals Yana refuses to automate (offline /
 * paper / unknown URL / generic directories). Yana opens the URL for
 * the user but never inspects forms, fills fields, or attempts submit.
 */

import { basePortalBrowserAdapter } from './basePortalBrowserAdapter.js'

export const manualPortalAdapter = Object.freeze({
  ...basePortalBrowserAdapter,
  name: 'manual_portal',
  portalTypes: ['manual_or_offline'],

  canHandle(portalLink) {
    return Boolean(portalLink) && portalLink.portal_type === 'manual_or_offline'
  },

  async detectGate() {
    return { kind: 'consent', reason: 'Manual / offline portal — Yana will not automate this. Please complete the application manually.' }
  },

  async detectForm() { return [] },
  async detectSaveDraftButton() { return null },
  async detectSubmitButton() { return null },
  async detectConfirmation() { return null },
})
