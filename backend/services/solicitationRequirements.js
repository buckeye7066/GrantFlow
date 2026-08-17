/**
 * Durable NOFO/RFP ingestion and normalized requirement extraction.
 *
 * The source document is never clipped. Inputs above the explicit safety
 * ceiling fail loudly; accepted text is stored in ordered, overlapping chunks
 * whose ranges cover the complete document. Every requirement carries a quote
 * and an absolute character range back to one of those chunks.
 */
import { createHash, randomUUID } from 'node:crypto'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'
import { z } from 'zod'

export const SOLICITATION_MAX_BYTES = 20 * 1024 * 1024
export const SOLICITATION_MAX_TEXT_CHARS = 2_000_000
export const SOLICITATION_CHUNK_CHARS = 12_000
export const SOLICITATION_CHUNK_OVERLAP = 600

const SOURCE_KINDS = ['nofo', 'rfp', 'amendment', 'other']
export const REQUIREMENT_TYPES = [
  'eligibility', 'submission', 'narrative', 'budget', 'document', 'deadline',
  'format', 'evaluation', 'reporting', 'compliance', 'contact', 'other',
]

/** Model-facing shape. Source coordinates are assigned and verified server-side. */
export const ExtractedRequirementModelSchema = z.object({
  canonical_key: z.string().trim().min(1).max(240).optional(),
  requirement_type: z.enum(REQUIREMENT_TYPES),
  title: z.string().trim().max(500).nullable().optional(),
  requirement_text: z.string().trim().min(1).max(20_000),
  source_quote: z.string().min(1).max(8_000),
  normalized_value: z.record(z.string(), z.unknown()).default({}),
  mandatory: z.boolean().default(true),
  confidence: z.number().min(0).max(1).default(0.8),
})

const ExtractedRequirementWithChunkSchema = ExtractedRequirementModelSchema.extend({
  chunk_index: z.number().int().nonnegative(),
})

export const RequirementCitationInputSchema = z.object({
  chunk_index: z.number().int().nonnegative(),
  quote_text: z.string().trim().min(1).max(8_000),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().positive(),
  page_number: z.number().int().positive().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.char_end <= value.char_start) {
    ctx.addIssue({ code: 'custom', path: ['char_end'], message: 'char_end must be greater than char_start' })
  }
})

export const NormalizedRequirementInputSchema = z.object({
  canonical_key: z.string().trim().min(1).max(240),
  requirement_type: z.enum(REQUIREMENT_TYPES),
  title: z.string().trim().max(500).nullable().optional(),
  requirement_text: z.string().trim().min(1).max(20_000),
  normalized_value: z.record(z.string(), z.unknown()).default({}),
  mandatory: z.boolean().default(true),
  confidence: z.number().min(0).max(1).default(1),
  citations: z.array(RequirementCitationInputSchema).min(1).max(20),
})

export const IngestSolicitationSchema = z.object({
  profile_id: z.string().trim().min(1).max(240),
  opportunity_id: z.string().trim().min(1).max(240),
  solicitation_id: z.string().trim().min(1).max(240).nullable().optional(),
  document_id: z.string().trim().min(1).max(240).nullable().optional(),
  source_kind: z.enum(SOURCE_KINDS).default('nofo'),
  source_url: z.string().url().max(4_000).nullable().optional(),
  title: z.string().trim().max(500).nullable().optional(),
  source_filename: z.string().trim().max(500).nullable().optional(),
  mime_type: z.string().trim().max(200).nullable().optional(),
  text: z.string().nullable().optional(),
  buffer: z.instanceof(Buffer).nullable().optional(),
  published_at: z.string().datetime({ offset: true }).nullable().optional(),
  effective_at: z.string().datetime({ offset: true }).nullable().optional(),
  is_amendment: z.boolean().default(false),
  created_by_user_id: z.string().trim().max(240).nullable().optional(),
  requirements: z.array(NormalizedRequirementInputSchema).max(2_000).nullable().optional(),
}).superRefine((value, ctx) => {
  if (!value.text && !value.buffer) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: 'text or buffer is required' })
  }
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function makeError(message, code, status = 422) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function extensionOf(fileName) {
  const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] || ''
}

/** Extract complete text from an accepted PDF, DOCX, or text input. */
export async function extractSolicitationText({
  text,
  buffer,
  mimeType,
  fileName,
  maxBytes = SOLICITATION_MAX_BYTES,
  maxTextChars = SOLICITATION_MAX_TEXT_CHARS,
} = {}) {
  let extracted = typeof text === 'string' ? text : null
  let method = extracted !== null ? 'provided_text' : null
  const bytes = Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(String(extracted || ''), 'utf8')

  if (bytes > maxBytes) {
    throw makeError(
      `Solicitation is ${bytes} bytes; the explicit limit is ${maxBytes} bytes. Nothing was clipped or ingested.`,
      'SOLICITATION_BYTES_LIMIT',
      413,
    )
  }

  if (extracted === null) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw makeError('A non-empty document buffer or text is required.', 'SOLICITATION_CONTENT_REQUIRED', 400)
    }
    const mime = String(mimeType || '').toLowerCase()
    const ext = extensionOf(fileName)
    if (mime === 'application/pdf' || ext === 'pdf') {
      const parsed = await pdfParse(buffer)
      extracted = String(parsed?.text || '')
      method = 'pdf-parse'
    } else if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || ext === 'docx'
    ) {
      const result = await mammoth.extractRawText({ buffer })
      extracted = String(result?.value || '')
      method = 'mammoth'
    } else if (mime.startsWith('text/') || ['txt', 'md', 'html', 'htm'].includes(ext)) {
      extracted = buffer.toString('utf8')
      method = 'utf8'
    } else {
      throw makeError(`Unsupported solicitation type: ${mime || ext || 'unknown'}`, 'SOLICITATION_TYPE_UNSUPPORTED', 415)
    }
  }

  const normalized = String(extracted || '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) {
    throw makeError('The document contained no extractable text.', 'SOLICITATION_TEXT_EMPTY')
  }
  if (normalized.length > maxTextChars) {
    throw makeError(
      `Extracted text is ${normalized.length} characters; the explicit limit is ${maxTextChars}. Nothing was clipped or ingested.`,
      'SOLICITATION_TEXT_LIMIT',
      413,
    )
  }
  return { text: normalized, method, bytes, chars: normalized.length }
}

/**
 * Split a document into overlapping ranges. Ranges are absolute, end-exclusive,
 * and collectively cover every accepted source character.
 */
export function chunkSolicitationText(
  text,
  { maxChars = SOLICITATION_CHUNK_CHARS, overlapChars = SOLICITATION_CHUNK_OVERLAP } = {},
) {
  const source = String(text || '')
  if (!source) return []
  if (!Number.isInteger(maxChars) || maxChars < 1_000) throw new Error('maxChars must be an integer >= 1000')
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error('overlapChars must be >= 0 and smaller than maxChars')
  }

  const chunks = []
  let start = 0
  while (start < source.length) {
    let end = Math.min(source.length, start + maxChars)
    if (end < source.length) {
      const floor = start + Math.floor(maxChars * 0.7)
      const newline = source.lastIndexOf('\n', end)
      if (newline >= floor) end = newline + 1
    }
    const content = source.slice(start, end)
    chunks.push({
      chunk_index: chunks.length,
      char_start: start,
      char_end: end,
      content,
      content_sha256: sha256(content),
      page_start: null,
      page_end: null,
    })
    if (end >= source.length) break
    const nextStart = Math.max(start + 1, end - overlapChars)
    start = nextStart
  }
  return chunks
}

const REQUIREMENT_SIGNAL = /\b(must|shall|required|requirement|deadline|due\s+(?:by|on)|submit|provide|attach|include|not\s+exceed|page\s+limit|eligible)\b/i
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'must', 'shall', 'will', 'are', 'your', 'you'])

function requirementType(text) {
  const value = String(text || '').toLowerCase()
  if (/deadline|due\s+(?:by|on)|no later than/.test(value)) return 'deadline'
  if (/budget|cost share|matching funds|indirect cost/.test(value)) return 'budget'
  if (/attach|document|letter|resume|transcript|certificat|form 990/.test(value)) return 'document'
  if (/page limit|font|margin|word limit|format/.test(value)) return 'format'
  if (/eligible|eligibility|applicant must|may apply/.test(value)) return 'eligibility'
  if (/narrative|essay|statement|project description/.test(value)) return 'narrative'
  if (/evaluate|selection criteria|scored|review criteria/.test(value)) return 'evaluation'
  if (/report|reporting|audit|record retention/.test(value)) return 'reporting'
  if (/submit|portal|email|mail/.test(value)) return 'submission'
  return 'other'
}

function significantTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
}

function deterministicRequirementKey(type, text) {
  const stem = significantTokens(text).slice(0, 10).join('-').slice(0, 150) || 'requirement'
  return `${type}:${stem}`
}

/**
 * Convert mechanically validated model candidates into persistence input.
 * Quotes must be exact substrings of the declared source chunk; absolute
 * coordinates are derived here rather than trusted from model output.
 */
export function normalizeModelRequirementCandidates(chunks, rawCandidates = []) {
  const byIndex = new Map((chunks || []).map((chunk) => [chunk.chunk_index, chunk]))
  const results = []
  const byKey = new Map()

  for (const raw of rawCandidates || []) {
    const candidate = ExtractedRequirementWithChunkSchema.parse(raw)
    const chunk = byIndex.get(candidate.chunk_index)
    if (!chunk) {
      throw makeError(
        `Model requirement references missing chunk ${candidate.chunk_index}.`,
        'SOLICITATION_MODEL_REQUIREMENT_INVALID',
      )
    }
    const relativeStart = chunk.content.indexOf(candidate.source_quote)
    if (relativeStart < 0) {
      throw makeError(
        `Model requirement quote was not found verbatim in chunk ${candidate.chunk_index}.`,
        'SOLICITATION_MODEL_QUOTE_MISMATCH',
      )
    }
    const baseKey = candidate.canonical_key
      || deterministicRequirementKey(candidate.requirement_type, candidate.requirement_text)
    const signature = `${candidate.requirement_type}\u0000${normalizeForRequirementIdentity(candidate.requirement_text)}`
    const prior = byKey.get(baseKey)
    if (prior?.signature === signature) continue
    const canonicalKey = prior
      ? `${baseKey.slice(0, 220)}:${sha256(signature).slice(0, 12)}`
      : baseKey
    byKey.set(canonicalKey, { signature })
    const charStart = chunk.char_start + relativeStart
    results.push({
      canonical_key: canonicalKey,
      requirement_type: candidate.requirement_type,
      title: candidate.title ?? null,
      requirement_text: candidate.requirement_text,
      normalized_value: candidate.normalized_value,
      mandatory: candidate.mandatory,
      confidence: candidate.confidence,
      citations: [{
        chunk_index: candidate.chunk_index,
        quote_text: candidate.source_quote,
        char_start: charStart,
        char_end: charStart + candidate.source_quote.length,
        page_number: null,
      }],
    })
  }
  return results
}

function normalizeForRequirementIdentity(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Conservative offline fallback: only imperative/requirement-bearing lines. */
export function extractRequirementsDeterministically(chunks) {
  const seen = new Set()
  const requirements = []
  for (const chunk of chunks || []) {
    const segments = String(chunk.content || '')
      .split(/\n+|(?<=[.;!?])\s+(?=[A-Z0-9])/)
      .map((value) => value.trim())
      .filter((value) => value.length >= 12 && value.length <= 4_000 && REQUIREMENT_SIGNAL.test(value))

    for (const segment of segments) {
      const relativeStart = chunk.content.indexOf(segment)
      if (relativeStart < 0) continue
      const type = requirementType(segment)
      const key = deterministicRequirementKey(type, segment)
      if (seen.has(key)) continue
      seen.add(key)
      const charStart = chunk.char_start + relativeStart
      requirements.push({
        canonical_key: key,
        requirement_type: type,
        title: segment.split(/[:.;]/, 1)[0].slice(0, 180),
        requirement_text: segment,
        normalized_value: {},
        mandatory: /\b(must|shall|required|requirement)\b/i.test(segment),
        confidence: 0.7,
        citations: [{
          chunk_index: chunk.chunk_index,
          quote_text: segment,
          char_start: charStart,
          char_end: charStart + segment.length,
          page_number: null,
        }],
      })
    }
  }
  return requirements
}

function validateRequirementCitations(requirements, chunks, sourceText) {
  const byIndex = new Map(chunks.map((chunk) => [chunk.chunk_index, chunk]))
  return requirements.map((raw) => {
    const requirement = NormalizedRequirementInputSchema.parse(raw)
    for (const citation of requirement.citations) {
      const chunk = byIndex.get(citation.chunk_index)
      if (!chunk) {
        throw makeError(`Citation references missing chunk ${citation.chunk_index}.`, 'SOLICITATION_CITATION_INVALID')
      }
      if (citation.char_start < chunk.char_start || citation.char_end > chunk.char_end) {
        throw makeError('Citation range falls outside its referenced chunk.', 'SOLICITATION_CITATION_INVALID')
      }
      const exact = sourceText.slice(citation.char_start, citation.char_end)
      if (exact !== citation.quote_text) {
        throw makeError('Citation quote does not exactly match the source range.', 'SOLICITATION_CITATION_MISMATCH')
      }
    }
    return requirement
  })
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function comparableRequirement(row) {
  return {
    canonical_key: row.canonical_key,
    requirement_type: row.requirement_type,
    title: row.title || null,
    requirement_text: row.requirement_text,
    normalized_value: parseJson(row.normalized_value_json, {}),
    mandatory: row.mandatory === true || row.mandatory === 1,
  }
}

function jaccard(left, right) {
  const a = new Set(significantTokens(left))
  const b = new Set(significantTokens(right))
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/** Compare normalized requirement sets and name added/removed/modified facts. */
export function computeAmendmentDiff(previousRows, nextRows) {
  const previous = (previousRows || []).map(comparableRequirement)
  const next = (nextRows || []).map((row) => comparableRequirement({
    ...row,
    normalized_value_json: row.normalized_value_json ?? JSON.stringify(row.normalized_value ?? {}),
    mandatory: row.mandatory,
  }))
  const oldByKey = new Map(previous.map((row) => [row.canonical_key, row]))
  const newByKey = new Map(next.map((row) => [row.canonical_key, row]))
  const changes = []
  const consumedOld = new Set()
  const consumedNew = new Set()

  for (const [key, after] of newByKey) {
    const before = oldByKey.get(key)
    if (!before) continue
    consumedOld.add(key)
    consumedNew.add(key)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ canonical_key: key, change_type: 'modified', before, after })
    }
  }

  const unmatchedOld = previous.filter((row) => !consumedOld.has(row.canonical_key))
  const unmatchedNew = next.filter((row) => !consumedNew.has(row.canonical_key))
  for (const after of unmatchedNew) {
    let best = null
    for (const before of unmatchedOld) {
      if (consumedOld.has(before.canonical_key) || before.requirement_type !== after.requirement_type) continue
      const score = jaccard(before.requirement_text, after.requirement_text)
      if (!best || score > best.score) best = { before, score }
    }
    if (best && best.score >= 0.6) {
      consumedOld.add(best.before.canonical_key)
      consumedNew.add(after.canonical_key)
      changes.push({ canonical_key: after.canonical_key, change_type: 'modified', before: best.before, after })
    }
  }

  for (const before of previous) {
    if (!consumedOld.has(before.canonical_key)) {
      changes.push({ canonical_key: before.canonical_key, change_type: 'removed', before, after: null })
    }
  }
  for (const after of next) {
    if (!consumedNew.has(after.canonical_key)) {
      changes.push({ canonical_key: after.canonical_key, change_type: 'added', before: null, after })
    }
  }
  return changes
}

async function runInTransaction(db, work) {
  if (typeof db?.withTransaction === 'function') return db.withTransaction(work)
  return work(db)
}

function dbBoolean(db, value) {
  return db?.dialect === 'postgres' ? Boolean(value) : (value ? 1 : 0)
}

async function loadRequirementsForVersion(db, versionId) {
  if (!versionId) return []
  return db.prepare(
    `SELECT id, canonical_key, requirement_type, title, requirement_text,
            normalized_value_json, mandatory, confidence, status
       FROM solicitation_requirements
      WHERE version_id = ?
      ORDER BY requirement_type, canonical_key`,
  ).all(versionId)
}

/** Persist one immutable version, complete chunks, requirements, and diffs. */
export async function ingestSolicitationVersion(db, rawInput) {
  if (!db?.prepare) throw new Error('db is required')
  const input = IngestSolicitationSchema.parse(rawInput)
  const extracted = await extractSolicitationText({
    text: input.text,
    buffer: input.buffer,
    mimeType: input.mime_type,
    fileName: input.source_filename,
  })
  const chunks = chunkSolicitationText(extracted.text)
  if (!chunks.length) throw makeError('No solicitation chunks were produced.', 'SOLICITATION_CHUNKS_EMPTY')
  const sourceHash = sha256(extracted.text)
  const candidates = input.requirements ?? extractRequirementsDeterministically(chunks)
  const requirements = validateRequirementCitations(candidates, chunks, extracted.text)

  return runInTransaction(db, async (tx) => {
    let solicitation = null
    if (input.solicitation_id) {
      solicitation = await tx.prepare(
        `SELECT * FROM opportunity_solicitations
          WHERE id = ? AND profile_id = ? AND opportunity_id = ?`,
      ).get(input.solicitation_id, input.profile_id, input.opportunity_id)
      if (!solicitation) throw makeError('Solicitation does not belong to this profile/opportunity.', 'SOLICITATION_SCOPE_MISMATCH', 403)
    } else {
      solicitation = await tx.prepare(
        `SELECT * FROM opportunity_solicitations
          WHERE profile_id = ? AND opportunity_id = ? AND source_kind = ?
            AND COALESCE(source_url, '') = COALESCE(?, '')
          LIMIT 1`,
      ).get(input.profile_id, input.opportunity_id, input.source_kind, input.source_url ?? null)
    }

    if (!solicitation) {
      const id = randomUUID()
      await tx.prepare(
        `INSERT INTO opportunity_solicitations
          (id, profile_id, opportunity_id, document_id, source_kind, source_url, title, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.profile_id, input.opportunity_id, input.document_id ?? null,
        input.source_kind, input.source_url ?? null, input.title ?? null,
        input.created_by_user_id ?? null,
      )
      solicitation = { id, profile_id: input.profile_id, opportunity_id: input.opportunity_id }
    }

    const duplicate = await tx.prepare(
      `SELECT id, version_number FROM solicitation_versions
        WHERE solicitation_id = ? AND source_sha256 = ? LIMIT 1`,
    ).get(solicitation.id, sourceHash)
    if (duplicate) {
      return {
        solicitation_id: solicitation.id,
        version_id: duplicate.id,
        version_number: Number(duplicate.version_number),
        duplicate: true,
        extracted_chars: extracted.chars,
        chunk_count: chunks.length,
        requirement_count: requirements.length,
        amendment_changes: [],
      }
    }

    const previousVersion = await tx.prepare(
      `SELECT id, version_number FROM solicitation_versions
        WHERE solicitation_id = ? ORDER BY version_number DESC LIMIT 1`,
    ).get(solicitation.id)
    const versionNumber = Number(previousVersion?.version_number || 0) + 1
    const versionId = randomUUID()
    await tx.prepare(
      `INSERT INTO solicitation_versions
        (id, solicitation_id, version_number, source_sha256, source_filename, mime_type,
         extracted_chars, chunk_count, published_at, effective_at, is_amendment,
         supersedes_version_id, ingestion_status, validation_errors_json, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', '[]', ?)`,
    ).run(
      versionId, solicitation.id, versionNumber, sourceHash,
      input.source_filename ?? null, input.mime_type ?? null, extracted.chars, chunks.length,
      input.published_at ?? null, input.effective_at ?? null,
      dbBoolean(tx, input.is_amendment || versionNumber > 1), previousVersion?.id ?? null,
      input.created_by_user_id ?? null,
    )

    const chunkIds = new Map()
    for (const chunk of chunks) {
      const chunkId = randomUUID()
      chunkIds.set(chunk.chunk_index, chunkId)
      await tx.prepare(
        `INSERT INTO solicitation_chunks
          (id, version_id, chunk_index, char_start, char_end, page_start, page_end, content, content_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        chunkId, versionId, chunk.chunk_index, chunk.char_start, chunk.char_end,
        chunk.page_start, chunk.page_end, chunk.content, chunk.content_sha256,
      )
    }

    const insertedRequirements = []
    for (const requirement of requirements) {
      const requirementId = randomUUID()
      const row = {
        ...requirement,
        id: requirementId,
        version_id: versionId,
        normalized_value_json: JSON.stringify(requirement.normalized_value || {}),
      }
      await tx.prepare(
        `INSERT INTO solicitation_requirements
          (id, version_id, canonical_key, requirement_type, title, requirement_text,
           normalized_value_json, mandatory, confidence, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      ).run(
        requirementId, versionId, requirement.canonical_key, requirement.requirement_type,
        requirement.title ?? null, requirement.requirement_text,
        row.normalized_value_json, dbBoolean(tx, requirement.mandatory), requirement.confidence,
      )
      insertedRequirements.push(row)
      for (const citation of requirement.citations) {
        await tx.prepare(
          `INSERT INTO requirement_citations
            (id, requirement_id, chunk_id, quote_text, char_start, char_end, page_number, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(), requirementId, chunkIds.get(citation.chunk_index), citation.quote_text,
          citation.char_start, citation.char_end, citation.page_number ?? null, input.source_url ?? null,
        )
      }
    }

    const previousRequirements = previousVersion
      ? await loadRequirementsForVersion(tx, previousVersion.id)
      : []
    const changes = previousVersion
      ? computeAmendmentDiff(previousRequirements, insertedRequirements)
      : insertedRequirements.map((row) => ({ canonical_key: row.canonical_key, change_type: 'added', before: null, after: comparableRequirement(row) }))

    if (previousVersion) {
      for (const change of changes) {
        await tx.prepare(
          `INSERT INTO solicitation_amendment_diffs
            (id, solicitation_id, from_version_id, to_version_id, canonical_key, change_type, before_json, after_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(), solicitation.id, previousVersion.id, versionId,
          change.canonical_key, change.change_type,
          change.before ? JSON.stringify(change.before) : null,
          change.after ? JSON.stringify(change.after) : null,
        )
      }
    }

    await tx.prepare(
      `UPDATE opportunity_solicitations
          SET document_id = COALESCE(?, document_id),
              title = COALESCE(?, title),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(input.document_id ?? null, input.title ?? null, solicitation.id)

    return {
      solicitation_id: solicitation.id,
      version_id: versionId,
      version_number: versionNumber,
      duplicate: false,
      extraction_method: extracted.method,
      extracted_chars: extracted.chars,
      chunk_count: chunks.length,
      requirement_count: requirements.length,
      amendment_changes: previousVersion ? changes : [],
    }
  })
}

export async function listSolicitationsForOpportunity(db, { profileId, opportunityId } = {}) {
  if (!profileId || !opportunityId) throw new Error('profileId and opportunityId are required')
  const solicitations = await db.prepare(
    `SELECT s.*,
            v.id AS latest_version_id, v.version_number, v.source_sha256,
            v.extracted_chars, v.chunk_count, v.created_at AS version_created_at
       FROM opportunity_solicitations s
       LEFT JOIN solicitation_versions v ON v.id = (
         SELECT v2.id FROM solicitation_versions v2
          WHERE v2.solicitation_id = s.id
          ORDER BY v2.version_number DESC LIMIT 1
       )
      WHERE s.profile_id = ? AND s.opportunity_id = ?
      ORDER BY s.updated_at DESC`,
  ).all(profileId, opportunityId)

  for (const solicitation of solicitations || []) {
    solicitation.requirements = solicitation.latest_version_id
      ? await db.prepare(
          `SELECT r.*,
                  c.id AS citation_id, c.quote_text, c.char_start, c.char_end,
                  c.page_number, c.source_url, ch.chunk_index
             FROM solicitation_requirements r
             LEFT JOIN requirement_citations c ON c.requirement_id = r.id
             LEFT JOIN solicitation_chunks ch ON ch.id = c.chunk_id
            WHERE r.version_id = ?
            ORDER BY r.requirement_type, r.canonical_key, c.char_start`,
        ).all(solicitation.latest_version_id)
      : []
    solicitation.amendment_changes = solicitation.latest_version_id
      ? await db.prepare(
          `SELECT * FROM solicitation_amendment_diffs
            WHERE to_version_id = ? ORDER BY change_type, canonical_key`,
        ).all(solicitation.latest_version_id)
      : []
  }
  return solicitations || []
}

export const _internal = {
  sha256,
  requirementType,
  deterministicRequirementKey,
  validateRequirementCitations,
}

export default {
  ingestSolicitationVersion,
  listSolicitationsForOpportunity,
  extractSolicitationText,
  chunkSolicitationText,
  extractRequirementsDeterministically,
  normalizeModelRequirementCandidates,
  computeAmendmentDiff,
}
