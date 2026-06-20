/**
 * applicationPacketPrint
 *
 * Opens a clean, self-contained printable APPLICATION PACKET for a NON-PORTAL
 * funding source — i.e. a real funding source (it has a URL) that you do NOT
 * apply to through a login/application portal, but by MAIL / FAX / EMAIL (or
 * whose page is info-only). The Portals dashboard surfaces these in its "Apply
 * by mail/fax/email" section; clicking "Print application packet" calls here.
 *
 * The packet HTML itself is built by the SHARED builder in applicationPacketHtml,
 * so the printed packet and the copy Hamilton saves to Documents are identical.
 * This module only handles OPENING + printing the packet in the browser.
 *
 * We open a same-origin about:blank with window.open("") and WITHOUT "noopener" —
 * passing noopener makes window.open() return null, leaving the tab blank (a
 * known footgun). The child is fully ours, so there is nothing to sever.
 */

import { buildApplicationPacketHtml } from "@/components/hamilton/applicationPacketHtml"

/**
 * Open the printable application packet for one non-portal source.
 *
 * @param {object} args
 * @param {string} args.profileName  who the application is for (profile/org name)
 * @param {object} args.source       a mailFaxSources[] entry from the portals API
 */
export function openApplicationPacket({ profileName = "", source } = {}) {
  if (typeof window === "undefined" || !source) return

  // NB: do NOT pass "noopener"/"noreferrer" here — that makes window.open()
  // return null and the tab opens blank. The child is a same-origin about:blank
  // we fully control.
  const win = window.open("", "_blank", "width=820,height=1060")
  if (!win) return // popup blocked — the in-app list still shows the contact info

  const html = buildApplicationPacketHtml({ profileName, source, autoPrint: true })
  win.document.write(html)
  win.document.close()
}

export default openApplicationPacket
