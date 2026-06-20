/**
 * applicationPacketPrint
 *
 * Builds + opens a clean, self-contained printable APPLICATION PACKET for a
 * NON-PORTAL funding source — i.e. a real funding source (it has a URL) that you
 * do NOT apply to through a login/application portal, but by MAIL / FAX / EMAIL
 * (or whose page is info-only). The Portals dashboard surfaces these in its
 * "Apply by mail/fax/email" section; clicking "Print application packet" calls
 * here.
 *
 * The packet states who the application is for (the profile / org), the funding
 * source + its page, the funder's contact block, and clear "Mail to / Fax to /
 * Email to" instructions plus application steps — everything the user needs to
 * apply off-portal. The browser's print dialog handles physical printing and
 * "Save as PDF"; no server-side PDF dependency.
 *
 * This mirrors the pipeline-potential printout's approach EXACTLY: we open a
 * same-origin about:blank with window.open("") and WITHOUT "noopener" — passing
 * noopener makes window.open() return null, leaving the tab blank (a known
 * footgun). The child is fully ours, so there is nothing to sever.
 */

import { safeHttpUrl } from "@/lib/safeUrl"

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Humanize an application_method token (e.g. "e-mail" → "Email") for display.
function methodLabel(method) {
  const m = String(method || "").trim().toLowerCase()
  const map = {
    mail: "Mail",
    postal: "Mail",
    paper: "Mail (paper application)",
    fax: "Fax",
    email: "Email",
    "e-mail": "Email",
    pdf: "Downloadable PDF application",
    in_person: "In person",
    "in-person": "In person",
  }
  return map[m] || (method ? String(method) : "")
}

// Pick the single clearest "how to apply" instruction line from the method +
// contact block, so the packet leads with the actionable step.
function primaryInstruction(method, contact) {
  const m = String(method || "").trim().toLowerCase()
  if ((m === "email" || m === "e-mail") && contact.email) {
    return { kind: "Email to", value: contact.email }
  }
  if (m === "fax" && contact.fax) return { kind: "Fax to", value: contact.fax }
  if ((m === "mail" || m === "postal" || m === "paper") && contact.address) {
    return { kind: "Mail to", value: contact.address }
  }
  // No method, or method without a matching contact field: fall back to whatever
  // contact channel we DO have, in mail → fax → email priority.
  if (contact.address) return { kind: "Mail to", value: contact.address }
  if (contact.fax) return { kind: "Fax to", value: contact.fax }
  if (contact.email) return { kind: "Email to", value: contact.email }
  return null
}

/**
 * Open the printable application packet for one non-portal source.
 *
 * @param {object} args
 * @param {string} args.profileName  who the application is for (profile/org name)
 * @param {object} args.source       a mailFaxSources[] entry from the portals API
 */
export function openApplicationPacket({ profileName = "", source } = {}) {
  if (typeof window === "undefined" || !source) return
  const contact = (source.contact && typeof source.contact === "object") ? source.contact : {}
  const safeContact = {
    name: contact.name || "",
    email: contact.email || "",
    phone: contact.phone || "",
    fax: contact.fax || "",
    address: contact.address || "",
  }
  const title = source.title || source.host || "Funding source"
  const pageUrl = safeHttpUrl(source.url)
  const method = source.applicationMethod || ""
  const instruction = primaryInstruction(method, safeContact)
  const generatedAt = new Date().toLocaleString()

  // NB: do NOT pass "noopener"/"noreferrer" here — that makes window.open()
  // return null and the tab opens blank. The child is a same-origin about:blank
  // we fully control.
  const win = window.open("", "_blank", "width=820,height=1060")
  if (!win) return // popup blocked — the in-app list still shows the contact info

  const contactRows = [
    ["Funder contact", safeContact.name],
    ["Email", safeContact.email],
    ["Phone", safeContact.phone],
    ["Fax", safeContact.fax],
    ["Mailing address", safeContact.address],
  ].filter(([, v]) => v)

  const contactHtml = contactRows.length
    ? contactRows
        .map(([label, val]) => `<div class="c-row"><span class="c-label">${escapeHtml(label)}</span><span class="c-val">${escapeHtml(val)}</span></div>`)
        .join("")
    : `<div class="c-none">No contact details on file. Visit the funder's page for how to apply.</div>`

  const instructionHtml = instruction
    ? `<div class="apply-to"><span class="apply-kind">${escapeHtml(instruction.kind)}</span><span class="apply-val">${escapeHtml(instruction.value)}</span></div>`
    : `<div class="c-none">No mail/fax/email destination on file — confirm how to apply on the funder's page.</div>`

  const stepsHtml = `
    <ol class="steps">
      <li>Prepare this profile's application materials (narrative, budget, and any required attachments).</li>
      <li>Address the application to the funder contact above${instruction ? ` and send it via <strong>${escapeHtml(methodLabel(method) || instruction.kind.replace(/ to$/, ""))}</strong>` : ""}.</li>
      <li>Keep a copy and note the date sent so the pipeline status can be updated.</li>
      ${pageUrl ? `<li>Double-check the funder's page for current deadlines and exact submission requirements.</li>` : ""}
    </ol>`

  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Application Packet — ${escapeHtml(title)}${profileName ? ` (${escapeHtml(profileName)})` : ""}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 36px; line-height: 1.45; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin: 22px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  .sub { color: #475569; font-size: 12px; }
  .for { margin: 10px 0 4px; font-size: 13px; }
  .for strong { font-weight: 700; }
  .source-page a { color: #4338ca; word-break: break-all; }
  .badge { display: inline-block; font-size: 11px; font-weight: 600; color: #3730a3; background: #e0e7ff; border-radius: 999px; padding: 2px 10px; margin-left: 6px; }
  .c-row { display: flex; gap: 12px; font-size: 13px; padding: 3px 0; }
  .c-label { min-width: 130px; color: #64748b; font-weight: 600; }
  .c-val { color: #0f172a; }
  .c-none { font-size: 12px; color: #94a3b8; font-style: italic; }
  .apply-to { font-size: 16px; font-weight: 700; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 2px; }
  .apply-kind { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #15803d; }
  .apply-val { color: #14532d; white-space: pre-wrap; }
  ol.steps { margin: 6px 0 0; padding-left: 20px; font-size: 13px; }
  ol.steps li { margin-bottom: 5px; }
  .print-btn { margin: 18px 0 0; padding: 8px 14px; font-size: 13px; border: 1px solid #6366f1; background: #6366f1; color: #fff; border-radius: 6px; cursor: pointer; }
  .foot { margin-top: 24px; font-size: 11px; color: #94a3b8; }
  @media print { .print-btn { display: none; } body { margin: 0; } }
</style>
</head>
<body>
  <h1>Application Packet</h1>
  <div class="sub">Generated ${escapeHtml(generatedAt)}</div>
  ${profileName ? `<p class="for">Application for: <strong>${escapeHtml(profileName)}</strong></p>` : ""}

  <h2>Funding source</h2>
  <p style="font-size:15px;font-weight:600;margin:0;">${escapeHtml(title)}${method ? `<span class="badge">Apply by ${escapeHtml(methodLabel(method) || method)}</span>` : ""}</p>
  ${pageUrl ? `<p class="source-page" style="font-size:12px;margin:4px 0 0;">Funder page: <a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pageUrl)}</a></p>` : ""}

  <h2>How to apply</h2>
  ${instructionHtml}

  <h2>Funder contact</h2>
  <div>${contactHtml}</div>

  <h2>Application steps</h2>
  ${stepsHtml}

  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <div class="foot">This is not a portal — there is no online login for this funder. Submit the application using the destination above.</div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
</body>
</html>`)
  win.document.close()
}

export default openApplicationPacket
