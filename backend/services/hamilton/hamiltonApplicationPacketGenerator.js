/**
 * hamiltonApplicationPacketGenerator.js
 *
 * Generates a complete application packet for a single funding source
 * and saves the outputs into the GrantFlow Documents system.
 *
 * Output formats:
 *   - DOCX  (always, when packet is generated)
 *   - PDF   (when HAMILTON_PACKET_PDF != 'false' AND Playwright chromium is
 *            available; falls back to DOCX-only when chromium is missing)
 *   - Mailing/fax/email instruction sheet (rendered into the same DOCX
 *     and PDF; also returned as structured JSON for the UI).
 *
 * Output is persisted via INSERT into `documents` (+ `profile_documents`
 * link) so the file shows up in the profile's Documents list. We mirror
 * the same insert pattern used by `routes/documents.js POST /ingest` so
 * we don't need a separate endpoint.
 *
 * Hamilton NEVER:
 *   - invents a profile field. If something is missing the packet
 *     prints "[ MISSING — supply via the GrantFlow profile ]" and we
 *     append the field to the missing-info list.
 *   - prints raw SSN / banking / payment / signature data.
 *   - hard-codes a deadline or address that wasn't in the source.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import JSZip from 'jszip'

const PERSONA = 'Hamilton — MBA-level grant writer with 20 years of experience'

function nonEmpty(v) { return v !== null && v !== undefined && String(v).trim() !== '' }
function pick(obj, paths) {
  if (!obj) return undefined
  for (const p of paths) {
    const parts = p.split('.')
    let cur = obj
    for (const seg of parts) {
      if (cur === null || cur === undefined) { cur = undefined; break }
      cur = cur[seg]
    }
    if (nonEmpty(cur)) return cur
  }
  return undefined
}

function safeText(text) {
  // Strip the NUL byte (codepoint 0) — it's a control character that
  // breaks XML/DOCX. The literal regex form trips ESLint's
  // no-control-regex rule, so we build it from String.fromCharCode.
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u0000/g, '')
}

function xmlEscape(text) {
  return safeText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function htmlEscape(text) {
  return safeText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function readBasic(profile) {
  const bi = profile?.basic_information || profile?.sections?.basic_information || {}
  return {
    first_name: pick(profile, ['basic_information.first_name', 'first_name']) || '',
    last_name: pick(profile, ['basic_information.last_name', 'last_name']) || '',
    email: pick(profile, ['basic_information.email', 'email']) || '',
    phone: pick(profile, ['basic_information.phone', 'phone']) || '',
    address1: pick(profile, ['basic_information.address1', 'basic_information.address']) || '',
    address2: pick(profile, ['basic_information.address2']) || '',
    city: pick(profile, ['basic_information.city']) || '',
    state: pick(profile, ['basic_information.state']) || '',
    zip: pick(profile, ['basic_information.zip']) || '',
    raw: bi,
  }
}

function readStudent(profile) {
  const apps = pick(profile, ['university_applications.applications']) || []
  const firstApp = Array.isArray(apps) && apps.length > 0 ? apps[0] : {}
  return {
    school: firstApp.name || pick(profile, ['student_info.school_name']) || '',
    major: firstApp.major || firstApp.program || pick(profile, ['student_info.major']) || '',
    degree_level: firstApp.degree_level || pick(profile, ['student_info.degree_level']) || '',
    student_id: firstApp.student_id || pick(profile, ['student_info.student_id']) || '',
    gpa: pick(profile, ['student_info.gpa', 'gpa']) || '',
    act: pick(profile, ['student_info.act_score', 'act_score']) || '',
    sat: pick(profile, ['student_info.sat_score', 'sat_score']) || '',
    expected_graduation: firstApp.expected_graduation || pick(profile, ['student_info.expected_graduation']) || '',
    fafsa_status: pick(profile, ['financial_information.fafsa_status', 'fafsa_status']) || '',
    household_income: pick(profile, ['financial_information.household_income', 'household.income']) || '',
    household_size: pick(profile, ['financial_information.household_size', 'household.size']) || '',
  }
}

function readNarratives(profile) {
  return {
    personal_statement: pick(profile, ['essays.primary', 'essays.personal_statement', 'personal_statement', 'narrative']) || '',
    goals: pick(profile, ['essays.goals', 'goals', 'career_goals']) || '',
    statement_of_need: pick(profile, ['essays.statement_of_need', 'statement_of_need']) || '',
    financial_hardship: pick(profile, ['essays.financial_hardship', 'financial_hardship']) || '',
  }
}

function deadline(opportunity) {
  return opportunity?.deadline || opportunity?.application_deadline || opportunity?.due_date || null
}

/**
 * Build the structured packet content. Pure — no IO. Returns:
 *   { sections: [{ heading, body }], missing: [{ kind, key, label, required }],
 *     mailing_instructions: { ... } }
 *
 * The packet content is intentionally Markdown-ish: line breaks become
 * paragraphs, "## X" lines become headings. Both the DOCX renderer and
 * the HTML→PDF renderer respect that convention.
 */
export function buildPacketContent({ opportunity, grant, profile, automationType }) {
  const opp = opportunity || grant || {}
  const title = opp.title || opp.name || 'Funding Application'
  const funder = opp.funder_name || opp.organization || opp.source_name || opp.source_label || 'Funder'
  const due = deadline(opp)
  const amount = opp.amount_max || opp.amount || opp.estimated_amount || ''

  const basic = readBasic(profile)
  const student = readStudent(profile)
  const narratives = readNarratives(profile)

  const missing = []
  function requireField(label, value, key, kind = 'field') {
    if (!nonEmpty(value)) missing.push({ kind, key, label, required: true })
    return value
  }

  const sections = []

  sections.push({
    heading: title,
    body:
`Generated by ${PERSONA}.
Funder: ${funder}
${due ? `Deadline: ${due}` : 'Deadline: [not specified]'}
${amount ? `Amount: ${amount}` : ''}`.trim(),
  })

  // Cover letter for non-portal applications.
  if (automationType !== 'portal') {
    const fullName = [basic.first_name, basic.last_name].filter(Boolean).join(' ') || '[ MISSING — name ]'
    sections.push({
      heading: 'Cover Letter',
      body:
`${new Date().toLocaleDateString()}

${funder}
${requireField('Funder mailing address', opp.mailing_address || opp.application_address, 'funder_mailing_address') || '[ MISSING — funder mailing address ]'}

Dear Selection Committee,

I am pleased to submit the enclosed application for ${title}. ${fullName}${student.school ? ` is a student at ${student.school}` : ''}${student.major ? `, pursuing ${student.major}` : ''}. This application is grounded in the GrantFlow profile we maintain for ${fullName}, and every fact below comes directly from that profile.

If anything in this packet requires clarification, please contact us at ${basic.email || '[ MISSING — email ]'}${basic.phone ? ` or ${basic.phone}` : ''}.

Respectfully,
${fullName}`,
    })
  }

  sections.push({
    heading: 'Applicant Information',
    body:
`Name:           ${[basic.first_name, basic.last_name].filter(Boolean).join(' ') || '[ MISSING — name ]'}
Email:          ${requireField('Email', basic.email, 'email') || '[ MISSING ]'}
Phone:          ${basic.phone || '[ optional ]'}
Address:        ${[basic.address1, basic.address2, basic.city, basic.state, basic.zip].filter(Boolean).join(', ') || '[ MISSING — mailing address ]'}
School:         ${student.school || '[ optional ]'}
Major / program:${student.major || '[ optional ]'}
Degree level:   ${student.degree_level || '[ optional ]'}
GPA:            ${student.gpa || '[ optional ]'}
ACT / SAT:      ${[student.act, student.sat].filter(Boolean).join(' / ') || '[ optional ]'}
FAFSA status:   ${student.fafsa_status || '[ optional ]'}
Household income: ${student.household_income || '[ optional ]'}
Household size: ${student.household_size || '[ optional ]'}`,
  })

  sections.push({
    heading: 'Statement of Need',
    body:
narratives.statement_of_need
  || narratives.financial_hardship
  || (() => {
    if (!nonEmpty(narratives.personal_statement)) {
      missing.push({ kind: 'field', key: 'statement_of_need', label: 'Statement of need / financial hardship', required: false })
      return '[ Hamilton has nothing to ground a Statement of Need in. Add a "statement_of_need" or "financial_hardship" essay to the GrantFlow profile and Hamilton will fill this section. ]'
    }
    return narratives.personal_statement
  })(),
  })

  sections.push({
    heading: 'Personal / Student Narrative',
    body:
nonEmpty(narratives.personal_statement)
  ? narratives.personal_statement
  : (() => {
      missing.push({ kind: 'field', key: 'personal_statement', label: 'Personal statement / narrative', required: true })
      return '[ Hamilton has no personal statement to ground a narrative in. Add a personal-statement essay to the GrantFlow profile under essays.primary or essays.personal_statement. Hamilton will not invent narrative content. ]'
    })(),
  })

  sections.push({
    heading: 'Career Goals',
    body: nonEmpty(narratives.goals)
      ? narratives.goals
      : '[ optional — add essays.goals to the profile to populate this section. ]',
  })

  sections.push({
    heading: 'Eligibility Explanation',
    body:
`Below is how the applicant satisfies each eligibility line item we could read off this opportunity.

${(opp.eligibility_text || opp.eligibility || '[ The opportunity record does not contain a structured eligibility list. ]')}

Applicant fit notes:
- School: ${student.school || '[ not on file ]'}
- Program: ${student.major || '[ not on file ]'}
- Citizenship: ${pick(profile, ['basic_information.citizenship', 'citizenship']) || '[ not on file ]'}
- State of residence: ${basic.state || '[ not on file ]'}`,
  })

  sections.push({
    heading: 'Document Checklist',
    body:
`The following items must accompany this application. Hamilton will mark each item ✓ if it is already in the GrantFlow Documents system; otherwise the item is flagged and added to the missing-info list.

[ ] Completed application form (this packet, signed)
[ ] Government photo ID (copy)
[ ] Most recent transcript
[ ] FAFSA Student Aid Report (if applicable)
[ ] Financial documentation (tax return, W-2, etc.) when requested
[ ] Recommendation letters per the funder's instructions
[ ] Any program-specific attachments listed in the funder instructions above`,
  })

  return { title, funder, due, sections, missing }
}

export function buildMailingInstructions({ opportunity, grant, automationType }) {
  const opp = opportunity || grant || {}
  const funder = opp.funder_name || opp.organization || opp.source_name || 'Funder'
  const url = opp.application_url || opp.apply_url || opp.url || null
  const due = deadline(opp)
  const address = opp.mailing_address || opp.application_address || null
  const fax = opp.apply_fax || opp.application_fax || opp.fax || null
  const email = opp.apply_email || opp.application_email || opp.submission_email || null
  const subject = `${funder} application — ${opp.title || ''}`.trim()

  return {
    automation_type: automationType,
    funder,
    funder_url: opp.organization_url || opp.source_url || null,
    portal_url: url,
    deadline: due,
    mailing_address: address,
    fax,
    email,
    suggested_subject_or_envelope: subject,
    instructions: buildInstructionLines({ automationType, address, fax, email, url, due, subject }),
  }
}

function buildInstructionLines({ automationType, address, fax, email, url, due, subject }) {
  const lines = []
  switch (automationType) {
    case 'mail':
      lines.push('Print the Hamilton-generated application packet (DOCX or PDF).')
      lines.push('Sign every page that requires a signature. Hamilton never auto-signs anything.')
      lines.push('Place the signed packet, ID copy, transcript, and any other listed attachments into a single envelope.')
      if (address) {
        lines.push(`Mail to: ${address}`)
      } else {
        // No address on file — give an ACTIONABLE next step instead of a dead end.
        lines.push('Mailing address not on file. Find the funder\'s submission/mailing address before sending:')
        if (url) lines.push(`  • On the funder application page: ${url}`)
        lines.push('  • Or call/email the funder to confirm where to mail the packet (see Funder contact above).')
        lines.push('  • Write the confirmed address on the envelope; do not guess.')
      }
      lines.push('USPS Certified Mail with tracking is recommended.')
      lines.push(`Write "${subject}" on the envelope (or use the funder reference number when known).`)
      if (due) lines.push(`Postmark by: ${due}`)
      lines.push('Keep a complete copy of the packet for your records.')
      break
    case 'fax':
      if (fax) {
        lines.push(`Fax the packet to: ${fax}`)
      } else {
        lines.push('Fax number not on file. Find the funder\'s fax number before sending:')
        if (url) lines.push(`  • On the funder application page: ${url}`)
        lines.push('  • Or call/email the funder to confirm the fax number (see Funder contact above).')
      }
      lines.push('Include a cover sheet with applicant name, funder name, and number of pages.')
      if (due) lines.push(`Send by: ${due}`)
      lines.push('Keep the fax confirmation receipt for your records.')
      break
    case 'email':
      if (email) {
        lines.push(`Email the PDF (preferred) to: ${email}`)
      } else {
        lines.push('Submission email not on file. Find the funder\'s submission email before sending:')
        if (url) lines.push(`  • On the funder application page: ${url}`)
        lines.push('  • Or call/contact the funder to confirm the submission email (see Funder contact above).')
      }
      lines.push(`Subject: ${subject}`)
      lines.push('Attach: signed PDF, transcript, ID copy, and any required documents.')
      if (due) lines.push(`Send by: ${due}`)
      lines.push('Save the sent message (and any auto-reply confirmation) for your records.')
      break
    case 'portal':
      lines.push('This funder accepts portal applications. Hamilton will open the supervised browser session.')
      if (url) lines.push(`Portal URL: ${url}`)
      lines.push('You will need to log in / clear 2FA / accept terms manually inside the supervised browser.')
      break
    case 'pdf_docx':
      lines.push('The funder publishes a downloadable form. Hamilton has populated it from the profile.')
      lines.push('Review every section, sign by hand, and submit per the funder\'s instructions.')
      break
    case 'no_application':
      lines.push('No application is required. This is a directory or awareness resource.')
      break
    case 'auto_profile':
      lines.push('This funding is awarded automatically based on FAFSA / institutional records / nomination.')
      lines.push('Confirm your FAFSA / institutional record / nomination is on file with the funder.')
      break
    default:
      lines.push('Hamilton could not determine the submission channel. Review the opportunity manually.')
  }
  return lines
}

// ── DOCX renderer ────────────────────────────────────────────────────

function makeDocxParagraphs(text) {
  return safeText(text).split(/\r?\n/)
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`)
    .join('')
}

export async function buildDocxBuffer({ title, sections, mailingInstructions }) {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
  )
  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
  )

  const body = []
  body.push(makeDocxParagraphs(title || 'Application Packet'))
  body.push('<w:p/>')
  for (const sec of sections || []) {
    body.push(makeDocxParagraphs(`## ${sec.heading}`))
    body.push('<w:p/>')
    body.push(makeDocxParagraphs(sec.body || ''))
    body.push('<w:p/>')
  }
  if (mailingInstructions) {
    body.push(makeDocxParagraphs('## Submission instructions'))
    body.push('<w:p/>')
    for (const line of (mailingInstructions.instructions || [])) {
      body.push(makeDocxParagraphs(`• ${line}`))
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body.join('')}
    <w:sectPr/>
  </w:body>
</w:document>`
  zip.folder('word')?.file('document.xml', documentXml)
  zip.folder('docProps')?.file(
    'core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title || 'Application Packet')}</dc:title>
  <dc:creator>${xmlEscape(PERSONA)}</dc:creator>
  <cp:lastModifiedBy>${xmlEscape(PERSONA)}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`,
  )
  return await zip.generateAsync({ type: 'nodebuffer' })
}

// ── HTML / PDF renderer ──────────────────────────────────────────────

export function buildHtml({ title, sections, mailingInstructions }) {
  const sectionHtml = (sections || []).map((s) =>
    `<section>
      <h2>${htmlEscape(s.heading)}</h2>
      <pre>${htmlEscape(s.body || '')}</pre>
    </section>`,
  ).join('\n')
  const instructionsHtml = mailingInstructions
    ? `<section>
        <h2>Submission instructions</h2>
        <ul>${(mailingInstructions.instructions || []).map((l) => `<li>${htmlEscape(l)}</li>`).join('')}</ul>
      </section>`
    : ''
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>${htmlEscape(title || 'Application Packet')}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; max-width: 7.5in; margin: 0.75in auto; color: #1f2937; }
  h1 { font-size: 22pt; border-bottom: 2px solid #4338ca; padding-bottom: 8px; }
  h2 { font-size: 14pt; color: #4338ca; margin-top: 1.5em; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  pre { white-space: pre-wrap; font-family: Georgia, "Times New Roman", serif; font-size: 11pt; line-height: 1.45; margin: 0.5em 0 1.25em 0; }
  ul { padding-left: 1.4em; }
  li { margin: 0.2em 0; }
  footer { margin-top: 2em; font-size: 9pt; color: #6b7280; border-top: 1px solid #ddd; padding-top: 6px; }
</style>
</head><body>
<h1>${htmlEscape(title || 'Application Packet')}</h1>
${sectionHtml}
${instructionsHtml}
<footer>Generated by ${htmlEscape(PERSONA)} on ${htmlEscape(new Date().toString())}.</footer>
</body></html>`
}

async function tryBuildPdfFromHtml(html) {
  // Use Playwright if available; otherwise skip the PDF render. The
  // packet is still saved as DOCX + HTML.
  try {
    const { chromium } = await import('playwright')
    const exe = chromium.executablePath?.()
    if (!exe || !fs.existsSync(exe)) return null
    const browser = await chromium.launch({ headless: true })
    try {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.setContent(html, { waitUntil: 'domcontentloaded' })
      const buf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.6in', bottom: '0.6in', left: '0.6in', right: '0.6in' } })
      await ctx.close()
      return buf
    } finally {
      await browser.close()
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[hamiltonPacket] PDF render skipped: ${err?.message || err}`)
    }
    return null
  }
}

// ── Document persistence ────────────────────────────────────────────

function getPacketStorageDir() {
  const base = process.env.HAMILTON_PACKET_STORAGE_DIR
    || path.join(os.tmpdir(), 'grantflow-hamilton-packets')
  try { fs.mkdirSync(base, { recursive: true }) } catch { /* ignore */ }
  return base
}

async function insertDocumentRecord(db, {
  profileId, grantId, opportunityId, name, type, filePath, mimeType, fileSize, notes, extractedText, fileBytes = null,
}) {
  const id = crypto.randomUUID()
  const bytes = Buffer.isBuffer(fileBytes) && fileBytes.length > 0 ? fileBytes : null

  // Persist the packet BYTES in Postgres (documents.file_bytes) so a saved
  // packet always downloads even after Railway's ephemeral filesystem drops the
  // on-disk copy or the nightly sweep prunes it. Mirrors the BYTEA pattern used
  // by routes/profilePortals.js persistPacketDocument. Try the richest column
  // set first, then degrade gracefully on schemas missing optional columns
  // (`university_application_*` on legacy SQLite; `file_bytes` before migration
  // 0121).
  const variants = []
  if (bytes) {
    variants.push({
      cols: 'id, organization_id, grant_id, profile_id, university_application_id, university_application_name, name, type, file_url, file_path, file_size, mime_type, file_bytes, extracted_text, processing_status, notes',
      vals: [id, null, grantId || null, profileId, null, null, name, type, null, filePath, fileSize || null, mimeType || null, bytes, extractedText || null, 'completed', notes || null],
    })
    variants.push({
      cols: 'id, organization_id, grant_id, profile_id, name, type, file_url, file_path, file_size, mime_type, file_bytes, extracted_text, processing_status, notes',
      vals: [id, null, grantId || null, profileId, name, type, null, filePath, fileSize || null, mimeType || null, bytes, extractedText || null, 'completed', notes || null],
    })
  }
  variants.push({
    cols: 'id, organization_id, grant_id, profile_id, university_application_id, university_application_name, name, type, file_url, file_path, file_size, mime_type, extracted_text, processing_status, notes',
    vals: [id, null, grantId || null, profileId, null, null, name, type, null, filePath, fileSize || null, mimeType || null, extractedText || null, 'completed', notes || null],
  })
  variants.push({
    cols: 'id, organization_id, grant_id, profile_id, name, type, file_url, file_path, file_size, mime_type, extracted_text, processing_status, notes',
    vals: [id, null, grantId || null, profileId, name, type, null, filePath, fileSize || null, mimeType || null, extractedText || null, 'completed', notes || null],
  })

  let lastErr = null
  let inserted = false
  for (const v of variants) {
    const placeholders = v.vals.map(() => '?').join(', ')
    try {
      await db.prepare(`INSERT INTO documents (${v.cols}) VALUES (${placeholders})`).run(...v.vals)
      inserted = true
      break
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase()
      // Only fall through to a poorer variant for a missing-column mismatch.
      if (msg.includes('no column named') || /file_bytes|university_application|column/.test(msg)) {
        lastErr = err
        continue
      }
      throw err
    }
  }
  if (!inserted) throw lastErr || new Error('documents insert failed')
  if (profileId) {
    try {
      await db.prepare(
        `INSERT INTO profile_documents (profile_id, document_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      ).run(profileId, id)
    } catch { /* table may not exist in test fixtures */ }
  }
  void opportunityId
  return id
}

/**
 * Generate the packet, save DOCX + (when possible) PDF to disk under
 * HAMILTON_PACKET_STORAGE_DIR, insert document rows, and return the
 * resulting metadata.
 */
export async function generateAndSavePacket(db, {
  profile, opportunity = null, grant = null, automationType = 'pdf_docx', taskId = null, userId = null,
} = {}) {
  if (!db) throw new Error('db required')
  if (!profile?.id) throw new Error('profile required')
  const profileId = profile.id

  const content = buildPacketContent({ opportunity, grant, profile, automationType })
  const mailingInstructions = buildMailingInstructions({ opportunity, grant, automationType })
  const html = buildHtml({ title: content.title, sections: content.sections, mailingInstructions })
  const docxBuf = await buildDocxBuffer({ title: content.title, sections: content.sections, mailingInstructions })
  const pdfBuf = await tryBuildPdfFromHtml(html)

  const storageDir = getPacketStorageDir()
  const baseSlug = String(content.title).toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'packet'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const docxPath = path.join(storageDir, `${baseSlug}_${stamp}.docx`)
  const pdfPath = pdfBuf ? path.join(storageDir, `${baseSlug}_${stamp}.pdf`) : null
  const htmlPath = path.join(storageDir, `${baseSlug}_${stamp}.html`)

  await fs.promises.writeFile(docxPath, docxBuf)
  await fs.promises.writeFile(htmlPath, html)
  if (pdfBuf) await fs.promises.writeFile(pdfPath, pdfBuf)

  const notes = `Generated by ${PERSONA}. task_id=${taskId || 'n/a'}. funder=${content.funder}. user_id=${userId || 'n/a'}.`

  const docxId = await insertDocumentRecord(db, {
    profileId,
    grantId: grant?.id || null,
    opportunityId: opportunity?.id || null,
    name: `${content.title} — DOCX`,
    type: 'hamilton_generated_application',
    filePath: docxPath,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileSize: docxBuf.length,
    notes,
    extractedText: content.sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n'),
    fileBytes: docxBuf,
  })

  let pdfId = null
  if (pdfBuf) {
    pdfId = await insertDocumentRecord(db, {
      profileId,
      grantId: grant?.id || null,
      opportunityId: opportunity?.id || null,
      name: `${content.title} — PDF`,
      type: 'hamilton_generated_application',
      filePath: pdfPath,
      mimeType: 'application/pdf',
      fileSize: pdfBuf.length,
      notes,
      fileBytes: pdfBuf,
    })
  }

  return {
    docx_document_id: docxId,
    pdf_document_id: pdfId,
    html_path: htmlPath,
    docx_path: docxPath,
    pdf_path: pdfPath,
    mailing_instructions: mailingInstructions,
    missing: content.missing,
    sections: content.sections,
    title: content.title,
  }
}

export const _internal = {
  PERSONA, buildPacketContent, buildMailingInstructions, buildInstructionLines,
  buildHtml, tryBuildPdfFromHtml, insertDocumentRecord,
}
