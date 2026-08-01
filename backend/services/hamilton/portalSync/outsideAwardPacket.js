/**
 * outsideAwardPacket.js — when a portal cannot be submitted to online, Hamilton
 * produces the MAILABLE/FAXABLE package instead.
 *
 * OWNER RULE (2026-08-01): "Make sure Hamilton knows this and will create a
 * package with instructions that can be mailed or faxed, listed in the
 * documents section of the profile… and make sure the profile owner is alerted."
 *
 * WHY THIS EXISTS: the reporter already refuses to fake a submission — a portal
 * with no submit control returns `submitted:false` and says so. But an honest
 * "I could not do it" with no artifact just hands the work back to the family
 * with extra steps. Many schools and funders genuinely accept outside-award
 * reports only by mail, fax, or email, so the correct completion of that path
 * is a finished document they can send, not a dead end.
 *
 * WHAT IT PRODUCES: a dated report listing every award the household has
 * ACCEPTED in GrantFlow (name, amount, sponsor), a signature block, and
 * step-by-step instructions for mailing/faxing/emailing it — saved into the
 * profile's Documents (the same store, access rules, and download route as
 * every other Hamilton packet, so the owner and admins already have access).
 *
 * It reuses the shared packet primitives (buildHtml / buildDocxBuffer /
 * insertDocumentRecord) rather than growing a second document pipeline — the
 * idempotency safeguard inside insertDocumentRecord is what stops a nightly
 * sync from filling Documents with duplicates.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../../../utils/logger.js'
import {
  buildDocxBuffer,
  _internal as packetInternals,
} from '../hamiltonApplicationPacketGenerator.js'

const log = createLogger('service:outsideAwardPacket')

const { buildHtml, tryBuildPdfFromHtml, insertDocumentRecord } = packetInternals

function money(n) {
  const v = Number(n)
  return Number.isFinite(v) && v > 0
    ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : null
}

function today() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

/**
 * The report body. Deliberately plain: a financial-aid office should be able to
 * act on it without decoding our formatting.
 */
export function buildOutsideAwardReport({ profile, portalHost, sources = [], contact = null }) {
  const studentName = profile?.display_name || profile?.full_name || 'Student'
  const rows = sources.map((s) => {
    const amt = money(s?.amount)
    const sponsor = s?.sponsor ? ` — awarded by ${s.sponsor}` : ''
    return `• ${s.name}${amt ? `: ${amt}` : ' (amount not stated)'}${sponsor}`
  })

  const total = sources.reduce((sum, s) => sum + (Number(s?.amount) > 0 ? Number(s.amount) : 0), 0)
  const totalLine = total > 0
    ? `Total reported outside aid: ${money(total)}`
    : 'Total reported outside aid: amounts not stated for these awards.'

  const sections = [
    {
      heading: 'Outside scholarship / award report',
      body: [
        `Date: ${today()}`,
        `Student: ${studentName}`,
        `Institution / portal: ${portalHost}`,
        '',
        'Please add the following outside awards to this student\'s financial-aid record.',
      ].join('\n'),
    },
    {
      heading: 'Awards to report',
      body: rows.length ? `${rows.join('\n')}\n\n${totalLine}` : 'No awards listed.',
    },
    {
      heading: 'Why you are receiving this',
      body: [
        'This student is required to report outside scholarships and awards to the',
        'financial-aid office. Their online portal did not provide a form for',
        'submitting this information, so it is being reported on paper.',
      ].join(' '),
    },
    {
      heading: 'Student signature',
      body: [
        'I certify that the awards listed above are accurate and complete to the best of my knowledge.',
        '',
        'Signature: ______________________________    Date: ______________',
        '',
        `Printed name: ${studentName}`,
        'Student ID: ______________________________',
      ].join('\n'),
    },
  ]

  // Instructions are ONLY as specific as the evidence allows. Inventing a
  // mailing address for a financial-aid office would send a family's private
  // award data to a made-up destination — the packet asks them to confirm it
  // instead.
  const instructionLines = [
    'HOW TO SEND THIS REPORT',
    '',
    '1. Print this document and sign the signature block.',
    '2. Add the student ID number if you have one.',
  ]
  if (contact?.address) {
    instructionLines.push(`3. Mail it to: ${contact.address}`)
  } else {
    instructionLines.push(
      `3. Mail it to the ${portalHost} financial-aid office. Confirm the current mailing address`,
      `   on the school's financial-aid contact page before sending — GrantFlow does not have it on file`,
      '   and will not guess an address for your private award information.',
    )
  }
  if (contact?.fax) instructionLines.push(`4. Or fax it to: ${contact.fax}`)
  else instructionLines.push('4. Or fax it, if the office lists a fax number for financial-aid documents.')
  if (contact?.email) instructionLines.push(`5. Or email a scanned copy to: ${contact.email}`)
  else instructionLines.push('5. Or email a scanned copy to the financial-aid office address listed on their site.')
  instructionLines.push(
    '',
    'KEEP A COPY. Schools often ask for proof that an outside award was reported.',
    'Reporting outside awards is usually required — an unreported award can lead to a',
    'revised aid package or a request to repay funds later.',
  )

  return {
    title: `Outside award report — ${portalHost}`,
    sections,
    mailingInstructions: instructionLines.join('\n'),
  }
}

/**
 * Build the packet and save it into the profile's Documents.
 * Best-effort: a failure here must never change the sync's reported outcome
 * (the sync already told the truth about not submitting).
 *
 * @returns {Promise<null|{documentIds:Array<string>, title:string, count:number}>}
 */
export async function generateOutsideAwardPacket(db, {
  profile, portalHost, sources = [], contact = null, userId = null,
} = {}) {
  if (!db || !profile?.id || !portalHost) return null
  if (!Array.isArray(sources) || sources.length === 0) return null

  try {
    const { title, sections, mailingInstructions } = buildOutsideAwardReport({ profile, portalHost, sources, contact })
    const html = buildHtml({ title, sections, mailingInstructions })
    const docxBuf = await buildDocxBuffer({ title, sections, mailingInstructions })
    const pdfBuf = await tryBuildPdfFromHtml(html)

    const dir = packetInternals.getPacketStorageDir
      ? packetInternals.getPacketStorageDir()
      : path.join(process.cwd(), 'uploads', 'packets')
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {})
    const slug = `outside-award-report-${String(portalHost).replace(/[^a-z0-9]+/gi, '-')}`.toLowerCase().slice(0, 60)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')

    const notes = `Generated by Hamilton because ${portalHost} offered no online way to submit an outside-award report. Lists ${sources.length} accepted award(s).`
    const extractedText = sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n')
    const documentIds = []

    const docxPath = path.join(dir, `${slug}_${stamp}.docx`)
    await fs.promises.writeFile(docxPath, docxBuf)
    const docxId = await insertDocumentRecord(db, {
      profileId: profile.id,
      grantId: null,
      opportunityId: null,
      name: `${title} — DOCX`,
      type: 'hamilton_outside_award_report',
      filePath: docxPath,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileSize: docxBuf.length,
      notes,
      extractedText,
      fileBytes: docxBuf,
    })
    if (docxId) documentIds.push(docxId)

    if (pdfBuf) {
      const pdfPath = path.join(dir, `${slug}_${stamp}.pdf`)
      await fs.promises.writeFile(pdfPath, pdfBuf)
      const pdfId = await insertDocumentRecord(db, {
        profileId: profile.id,
        grantId: null,
        opportunityId: null,
        name: `${title} — PDF (print this)`,
        type: 'hamilton_outside_award_report',
        filePath: pdfPath,
        mimeType: 'application/pdf',
        fileSize: pdfBuf.length,
        notes,
        extractedText,
        fileBytes: pdfBuf,
      })
      if (pdfId) documentIds.push(pdfId)
    }

    log.info('outside_award_packet_created', { profileId: profile.id, portalHost, docs: documentIds.length, awards: sources.length })
    return { documentIds, title, count: sources.length }
  } catch (err) {
    log.warn('outside_award_packet_failed', { portalHost, error: err?.message })
    return null
  }
}

export default { buildOutsideAwardReport, generateOutsideAwardPacket }
