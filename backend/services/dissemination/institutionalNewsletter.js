import { createHash } from 'node:crypto'

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PLACEHOLDER_DOMAIN_RX = /\.(?:invalid|test)$|@(?:example\.(?:com|org|net)|localhost)$/i
const WORD_RX = /[a-z][a-z0-9-]*/g
const SHORT_RESEARCH_TERMS = new Set(['ai', 'ml', 'r'])
const STOP_WORDS = new Set(['and', 'for', 'from', 'grant', 'grants', 'funding', 'the', 'with'])
const MAX_GROUPS = 500
const MAX_RECIPIENTS = 20_000
const MAX_OPPORTUNITIES = 10_000
const MAX_GROUP_MEMBERSHIPS = 50_000

function text(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function htmlEscape(value) {
  return text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function headerText(value, fallback = '') {
  return text(value, fallback).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function fileSafe(value) {
  return text(value, 'group').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group'
}

function validEditionDate(value) {
  const date = text(value)
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const parsed = match ? new Date(`${date}T00:00:00Z`) : null
  if (
    !match
    || Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
  ) {
    throw new Error('editionDate must be an ISO calendar date')
  }
  return date
}

function httpsUrl(value) {
  try {
    const parsed = new URL(text(value))
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function tokens(...values) {
  return new Set(values.flatMap((value) => text(value).toLowerCase().match(WORD_RX) || [])
    .filter((value) => (value.length >= 3 || SHORT_RESEARCH_TERMS.has(value)) && !STOP_WORDS.has(value)))
}

function overlap(left, right) {
  let count = 0
  for (const value of left) if (right.has(value)) count += 1
  return count
}

function firstEmail(recipient) {
  const candidates = [
    recipient?.email,
    ...(Array.isArray(recipient?.emails)
      ? recipient.emails.map((entry) => typeof entry === 'string' ? entry : entry?.email)
      : []),
  ]
  return candidates.map((value) => text(value).toLowerCase())
    .find((value) => EMAIL_RX.test(value) && !PLACEHOLDER_DOMAIN_RX.test(value)) || null
}

function consentDate(recipient) {
  const value = text(recipient?.email_consent_at ?? recipient?.consent_at)
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null
}

function normalizeRecipients(recipients) {
  const eligible = []
  const suppressed = []
  const seenProfiles = new Set()
  const seenEmails = new Set()
  for (const recipient of Array.isArray(recipients) ? recipients : []) {
    const profileId = text(recipient?.profile_id ?? recipient?.id)
    if (!profileId || seenProfiles.has(profileId)) {
      suppressed.push({ profile_id: profileId || null, reason: profileId ? 'duplicate_profile' : 'missing_profile_id' })
      continue
    }
    seenProfiles.add(profileId)
    const email = firstEmail(recipient)
    const consentAt = consentDate(recipient)
    if (recipient?.active === false) suppressed.push({ profile_id: profileId, reason: 'inactive_profile' })
    else if (recipient?.email_opt_in !== true) suppressed.push({ profile_id: profileId, reason: 'email_consent_not_recorded' })
    else if (!consentAt) suppressed.push({ profile_id: profileId, reason: 'email_consent_timestamp_missing' })
    else if (!email) suppressed.push({ profile_id: profileId, reason: 'deliverable_email_missing' })
    else if (seenEmails.has(email)) suppressed.push({ profile_id: profileId, reason: 'duplicate_email' })
    else {
      seenEmails.add(email)
      eligible.push({
        profile_id: profileId,
        display_name: text(recipient?.display_name ?? recipient?.name, profileId),
        email,
        email_consent_at: consentAt,
      })
    }
  }
  return { eligible, suppressed }
}

function normalizeOpportunity(opportunity) {
  const id = text(opportunity?.id)
  const title = text(opportunity?.title)
  const url = httpsUrl(opportunity?.application_url ?? opportunity?.apply_url ?? opportunity?.source_url ?? opportunity?.url)
  if (!id || !title || !url) return null
  const deadlineInput = text(opportunity?.deadline)
  const deadlineMatch = deadlineInput.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/)
  const deadline = deadlineMatch ? `${deadlineMatch[1]}-${deadlineMatch[2]}-${deadlineMatch[3]}` : ''
  const parsedDeadline = deadlineMatch ? new Date(`${deadline}T00:00:00Z`) : null
  const validDeadline = Boolean(
    deadlineMatch
    && !Number.isNaN(parsedDeadline.getTime())
    && parsedDeadline.getUTCFullYear() === Number(deadlineMatch[1])
    && parsedDeadline.getUTCMonth() + 1 === Number(deadlineMatch[2])
    && parsedDeadline.getUTCDate() === Number(deadlineMatch[3]),
  )
  return {
    id,
    title,
    funder: text(opportunity?.funder ?? opportunity?.sponsor, 'Funding source'),
    deadline: validDeadline ? deadline : null,
    url,
    score: Number.isFinite(Number(opportunity?.score)) ? Number(opportunity.score) : 0,
    profile_ids: new Set((Array.isArray(opportunity?.profile_ids) ? opportunity.profile_ids : []).map(String)),
    topic_tokens: tokens(opportunity?.title, opportunity?.description, opportunity?.topics, opportunity?.categories),
  }
}

function groupOpportunities(group, candidates, maxOpportunities) {
  const savedIds = new Set((Array.isArray(group?.saved_opportunity_ids) ? group.saved_opportunity_ids : []).map(String))
  const recipientIds = new Set((Array.isArray(group?.recipient_profile_ids) ? group.recipient_profile_ids : []).map(String))
  const groupTokens = tokens(group?.name, group?.topic_terms, group?.description)
  return candidates
    .map((opportunity) => {
      const saved = savedIds.has(opportunity.id)
      const assigned = [...opportunity.profile_ids].some((profileId) => recipientIds.has(profileId))
      const topicHits = overlap(groupTokens, opportunity.topic_tokens)
      if (!saved && !assigned && topicHits === 0) return null
      return { opportunity, saved, assigned, topicHits }
    })
    .filter(Boolean)
    .sort((left, right) =>
      Number(right.saved) - Number(left.saved)
      || Number(right.assigned) - Number(left.assigned)
      || right.topicHits - left.topicHits
      || right.opportunity.score - left.opportunity.score
      || String(left.opportunity.deadline || '9999-12-31').localeCompare(String(right.opportunity.deadline || '9999-12-31'))
      || left.opportunity.id.localeCompare(right.opportunity.id))
    .slice(0, maxOpportunities)
    .map(({ opportunity, saved, assigned, topicHits }) => ({
      id: opportunity.id,
      title: opportunity.title,
      funder: opportunity.funder,
      deadline: opportunity.deadline,
      url: opportunity.url,
      reasons: [saved ? 'saved_list' : null, assigned ? 'profile_match' : null, topicHits ? 'topic_match' : null].filter(Boolean),
    }))
}

function renderEdition({ institutionName, groupName, editionDate, opportunities }) {
  const subject = `${headerText(institutionName)} funding opportunities — ${headerText(groupName)} — ${editionDate}`
  const lines = opportunities.length > 0
    ? opportunities.map((opportunity, index) => {
      const deadline = opportunity.deadline ? ` — deadline ${opportunity.deadline}` : ''
      return `${index + 1}. ${opportunity.title} (${opportunity.funder})${deadline}\n   ${opportunity.url}`
    })
    : ['No matching opportunities were available for this edition.']
  const plain = [subject, '', ...lines].join('\n')
  const list = opportunities.length > 0
    ? `<ol>${opportunities.map((opportunity) => `<li><a href="${htmlEscape(opportunity.url)}">${htmlEscape(opportunity.title)}</a> — ${htmlEscape(opportunity.funder)}${opportunity.deadline ? ` — deadline ${htmlEscape(opportunity.deadline)}` : ''}</li>`).join('')}</ol>`
    : '<p>No matching opportunities were available for this edition.</p>'
  const html = `<!doctype html><html><body><h1>${htmlEscape(institutionName)} funding opportunities</h1><h2>${htmlEscape(groupName)}</h2><p>${htmlEscape(editionDate)}</p>${list}</body></html>`
  return { subject, text: plain, html }
}

function csvCell(value) {
  const raw = text(value)
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function recipientsCsv(rows) {
  const columns = ['Group ID', 'Profile ID', 'Display Name', 'Email', 'Email Consent At']
  return `${[
    columns.join(','),
    ...rows.map((row) => [row.group_id, row.profile_id, row.display_name, row.email, row.email_consent_at].map(csvCell).join(',')),
  ].join('\r\n')}\r\n`
}

function checksum(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function buildInstitutionalNewsletterBundle({
  institutionName,
  editionDate,
  groups = [],
  recipients = [],
  opportunities = [],
  maxOpportunities = 10,
}) {
  if (!Array.isArray(groups) || groups.length > MAX_GROUPS) {
    throw new Error(`groups must be an array of at most ${MAX_GROUPS} records`)
  }
  if (!Array.isArray(recipients) || recipients.length > MAX_RECIPIENTS) {
    throw new Error(`recipients must be an array of at most ${MAX_RECIPIENTS} records`)
  }
  if (!Array.isArray(opportunities) || opportunities.length > MAX_OPPORTUNITIES) {
    throw new Error(`opportunities must be an array of at most ${MAX_OPPORTUNITIES} records`)
  }
  const membershipCount = groups.reduce(
    (count, group) => count + (Array.isArray(group?.recipient_profile_ids) ? group.recipient_profile_ids.length : 0),
    0,
  )
  if (membershipCount > MAX_GROUP_MEMBERSHIPS) {
    throw new Error(`group memberships exceed ${MAX_GROUP_MEMBERSHIPS} records`)
  }
  const institution = text(institutionName)
  if (!institution) throw new Error('institutionName is required')
  const date = validEditionDate(editionDate)
  const limit = Math.max(1, Math.min(25, Number(maxOpportunities) || 10))
  const { eligible, suppressed } = normalizeRecipients(recipients)
  const eligibleById = new Map(eligible.map((recipient) => [recipient.profile_id, recipient]))
  const normalizedOpportunities = (Array.isArray(opportunities) ? opportunities : [])
    .map(normalizeOpportunity)
    .filter((opportunity) => opportunity && (!opportunity.deadline || opportunity.deadline >= date))
  const seenGroups = new Set()
  const recipientRows = []
  const editions = []
  const files = []

  for (const group of Array.isArray(groups) ? groups : []) {
    const groupId = text(group?.id)
    if (!groupId || seenGroups.has(groupId)) throw new Error('group ids must be present and unique')
    seenGroups.add(groupId)
    const groupName = text(group?.name, groupId)
    const memberIds = [...new Set((Array.isArray(group?.recipient_profile_ids) ? group.recipient_profile_ids : []).map(String))]
    const groupRecipients = memberIds.map((profileId) => eligibleById.get(profileId)).filter(Boolean)
      .sort((left, right) => left.email.localeCompare(right.email))
    groupRecipients.forEach((recipient) => recipientRows.push({ group_id: groupId, ...recipient }))
    const selected = groupOpportunities(group, normalizedOpportunities, limit)
    const rendered = renderEdition({ institutionName: institution, groupName, editionDate: date, opportunities: selected })
    const groupFileKey = `${fileSafe(groupId)}-${checksum(groupId).slice(0, 12)}`
    const baseName = `${date}-${groupFileKey}`
    const editionFiles = [
      { name: `${baseName}.txt`, media_type: 'text/plain', content: rendered.text },
      { name: `${baseName}.html`, media_type: 'text/html', content: rendered.html },
    ].map((file) => ({ ...file, sha256: checksum(file.content) }))
    files.push(...editionFiles)
    editions.push({
      group_id: groupId,
      group_name: groupName,
      recipient_count: groupRecipients.length,
      opportunity_count: selected.length,
      opportunity_ids: selected.map((opportunity) => opportunity.id),
      subject: rendered.subject,
      files: editionFiles.map(({ name, media_type, sha256 }) => ({ name, media_type, sha256 })),
    })
  }

  recipientRows.sort((left, right) => left.group_id.localeCompare(right.group_id) || left.email.localeCompare(right.email))
  const recipientFileContent = recipientsCsv(recipientRows)
  files.push({
    name: `${date}-recipients.csv`,
    media_type: 'text/csv',
    content: recipientFileContent,
    sha256: checksum(recipientFileContent),
  })

  return {
    schema_version: 'grantflow-institutional-newsletter-v1',
    institution_name: institution,
    edition_date: date,
    editions,
    eligible_recipient_count: eligible.length,
    suppressed_recipients: suppressed,
    files,
  }
}
