import { canonicalStage } from '../../shared/pipelineStages.js'

export function calendarDate(value) {
  if (!value) return null
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim())
  if (bare) {
    const date = new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]))
    return date.getFullYear() === Number(bare[1]) && date.getMonth() === Number(bare[2]) - 1 && date.getDate() === Number(bare[3]) ? date : null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const PRE_SUBMISSION = new Set(['discovered', 'saved', 'interested', 'gathering_documents', 'drafting', 'ready_to_submit'])
export function upcomingPipelineGrants(grants, profileId, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return grants.filter(grant => {
    if (profileId && String(grant.profile_id) !== String(profileId)) return false
    const date = calendarDate(grant.deadline)
    return date && date >= today && PRE_SUBMISSION.has(canonicalStage(grant.status))
  }).sort((a, b) => calendarDate(a.deadline) - calendarDate(b.deadline))
}

const escapeText = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
const dateKey = date => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
const utcStamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

// RFC 5545 physical lines are at most 75 UTF-8 octets, including continuation space.
function foldLine(line) {
  const lines = []; let current = ''; let bytes = 0
  for (const character of line) {
    const length = new TextEncoder().encode(character).length
    if (bytes + length > 75) { lines.push(current); current = ' '; bytes = 1 }
    current += character; bytes += length
  }
  lines.push(current)
  return lines.join('\r\n')
}

export function buildCalendarExport(events, { month, now = new Date() } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GrantFlow//Funding Calendar//EN', 'CALSCALE:GREGORIAN']
  const seen = new Set()
  for (const event of events) {
    const raw = event.deadline ?? event.dateKey
    const date = calendarDate(raw)
    if (!date || (month && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` !== month)) continue
    const id = String(event.id ?? `${raw}:${event.title}`)
    if (seen.has(id)) continue
    seen.add(id)
    lines.push('BEGIN:VEVENT', `UID:${encodeURIComponent(id)}@grantflow`, `DTSTAMP:${utcStamp(now)}`)
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw).trim())) {
      const end = new Date(date); end.setDate(end.getDate() + 1)
      lines.push(`DTSTART;VALUE=DATE:${dateKey(date)}`, `DTEND;VALUE=DATE:${dateKey(end)}`)
    } else {
      lines.push(`DTSTART:${utcStamp(date)}`)
    }
    lines.push(`SUMMARY:${escapeText(event.title || 'Funding deadline')}`)
    const description = [event.grantTitle, event.sponsor, event.description ?? event.detail].filter(Boolean).join('\n')
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

export function downloadCalendar(events, month) {
  const url = URL.createObjectURL(new Blob([buildCalendarExport(events, { month })], { type: 'text/calendar;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = `grantflow-${month}.ics`
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
