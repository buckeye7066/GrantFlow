/**
 * yanaESignatureService.js
 *
 * Signature handling. Yana never forges signatures. She produces:
 *
 *   1. A printable signature packet (DOCX + PDF) containing every
 *      page that needs a wet signature, with explicit highlight on
 *      the signature line. Saved to profile Documents.
 *
 *   2. A structured list of e-sign "envelopes" the user/admin should
 *      route through a compliant external e-sign provider (DocuSign,
 *      Adobe Sign, etc.). Yana hands back the envelope description;
 *      the actual provider call is the host system's responsibility
 *      so we never touch private signing keys.
 *
 *   3. Print/mail/scan instructions that re-enter the upload flow
 *      after the signature is returned.
 *
 * NEVER:
 *   - paste a stored signature image into a portal
 *   - synthesise a signature
 *   - check a "by typing my name I am signing" attestation outside
 *     the standing-attestation allow-list
 */

import { generateAndSavePacket } from './yanaApplicationPacketGenerator.js'

/**
 * Figure out whether a portal/application accepts e-signature.
 * `opportunity` may carry `application_method` / `signature_method`
 * fields; we also fall back to the classification heuristic.
 */
export function determineSignatureRoute({ opportunity = {}, classification = {} } = {}) {
  const method = String(opportunity.signature_method || opportunity.signature || '').toLowerCase()
  if (/(docusign|adobe\s*sign|adobesign|hellosign|onespan|signnow|esign|electronic)/.test(method)) {
    return 'esign'
  }
  if (/(wet|hand[-\s]?written|notarized?|original|ink|mail\s*signed)/.test(method)) {
    return 'wet_signature_packet'
  }
  if (classification?.automation_type === 'mail') return 'wet_signature_packet'
  if (classification?.automation_type === 'fax') return 'wet_signature_packet'
  if (classification?.automation_type === 'portal') return 'esign_or_packet'
  return 'unknown'
}

/**
 * Build a signature packet for the application using the existing
 * packet generator and tag it as "signature ready". Saves it to the
 * profile's Documents and returns the result so the caller can wire
 * IDs into the application_task row.
 */
export async function buildSignaturePacket(db, {
  profile, opportunity = null, grant = null, taskId = null, userId = null,
} = {}) {
  return await generateAndSavePacket(db, {
    profile,
    opportunity,
    grant,
    automationType: 'pdf_docx',
    taskId,
    userId,
  })
}

/**
 * Build an e-sign envelope description Yana can hand to a downstream
 * provider integration. We never call a provider here — the host
 * service owns that integration so private keys / OAuth tokens stay
 * out of Yana's process.
 */
export function buildESignEnvelope({
  profile, opportunity = null, grant = null, documents = [],
} = {}) {
  const recipientName = [
    profile?.basic_information?.first_name || profile?.first_name,
    profile?.basic_information?.last_name || profile?.last_name,
  ].filter(Boolean).join(' ') || 'Applicant'
  const recipientEmail = profile?.basic_information?.email || profile?.email || null
  const subject = `Signature requested: ${opportunity?.title || grant?.title || 'GrantFlow application'}`
  return {
    subject,
    recipient: { name: recipientName, email: recipientEmail },
    documents: (documents || []).map((d) => ({
      name: d.name || 'Application packet',
      document_id: d.document_id || d.id || null,
      pages: d.pages || null,
    })),
    instructions:
      `Please review and sign the attached pages. Yana prepared the application; '
      + 'the only step left is your signature.`,
    routing_method: 'external_compliant_provider',
  }
}

/**
 * Build the mail/scan instructions packet for a wet-signature route.
 */
export function buildWetSignatureInstructions({ opportunity = null }) {
  return {
    method: 'wet_signature_packet',
    instructions: [
      'Print the signature packet from your profile Documents.',
      'Sign every page where Yana highlighted the signature line.',
      opportunity?.mailing_address
        ? `Mail the signed packet to: ${opportunity.mailing_address}.`
        : 'Mail or scan/upload the signed packet per the funder\'s instructions.',
      'Once you upload the scanned packet to the profile, click Resolve blocker and continue.',
    ],
  }
}
