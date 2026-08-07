import crypto from 'crypto'
import { safeParseJSON } from '../utils/safeJson.js'
import { dedupeProfileDisplayName } from '../../shared/nameParsing.js'

// Section fields that hold a person's name. Merging two profiles must NEVER
// concatenate two overlapping forms of the same name (the historic
// "Jordan Lane Jordan Michael Lane" doubling bug). For these fields we collapse
// the merge result back to the single most-complete name. Centralized so the
// producer (this merge) and the boot sweep (enforceInvariants) agree on which
// fields are name-shaped.
const PERSON_NAME_FIELDS = new Set(['full_name', 'display_name', 'name', 'legal_name'])

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripDiacritics(value) {
  try {
    return String(value ?? '')
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
  } catch {
    return String(value ?? '').normalize('NFKD')
  }
}

export function normalizeProfileNameKey(displayName) {
  const raw = normalizeWhitespace(stripDiacritics(displayName)).toLowerCase()
  return raw
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenizeProfileDisplayName(displayName) {
  const key = normalizeProfileNameKey(displayName)
  if (!key) return []
  return key.split(' ').filter(Boolean)
}

/** True when names likely refer to the same person (e.g. "Lina" vs "Lina S. Moreno"). */
export function profilesHaveSimilarNames(nameA, nameB) {
  const a = tokenizeProfileDisplayName(nameA)
  const b = tokenizeProfileDisplayName(nameB)
  if (!a.length || !b.length) return false

  if (a.join(' ') === b.join(' ')) return true

  const [short, long] = a.length <= b.length ? [a, b] : [b, a]

  // Token prefix: "demo_senior_family" is a prefix of "demo_senior_family s samoylenko".
  if (short.length < long.length && short.every((token, index) => long[index] === token)) {
    return true
  }

  // First + last token match when both names are multi-word (handles middle initials/names).
  if (short.length >= 2 && long.length >= 2) {
    if (short[0] === long[0] && short[short.length - 1] === long[long.length - 1]) {
      return true
    }
  }

  // Single given name vs fuller name that shares the first token.
  if (short.length === 1 && long.length >= 2 && short[0] === long[0]) {
    return true
  }

  return false
}

function buildDuplicateGroupsFromMembers(members, metaByProfile, { minGroupSize, bucketKey } = {}) {
  if (!members || members.length < minGroupSize) return null

  const candidates = members.map((profile) => ({
    profile,
    meta: metaByProfile.get(profile.id) || { score: 0 },
  }))
  const winner = pickWinner(candidates)
  const losers = candidates.filter((c) => c.profile.id !== winner.profile.id)

  // When the caller supplies the bucket key that actually grouped these profiles
  // (e.g. an email or phone signal), surface it as the group key so callers can
  // see *why* the rows were grouped. Fall back to a sorted name composite for
  // similarity-based clustering where no single bucket key exists.
  const key =
    bucketKey ||
    candidates
      .map((c) => normalizeProfileNameKey(c.profile.display_name) || c.profile.display_name)
      .filter(Boolean)
      .sort()
      .join(' | ')

  return {
    key,
    winner: summarizeProfileRow(winner.profile, winner.meta),
    losers: losers.map((c) => summarizeProfileRow(c.profile, c.meta)),
    count: candidates.length,
  }
}

function findSimilarNameClusters(profiles) {
  const n = profiles.length
  if (n < 2) return []

  const parent = Array.from({ length: n }, (_, index) => index)

  const find = (index) => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    let current = index
    while (parent[current] !== current) {
      const next = parent[current]
      parent[current] = root
      current = next
    }
    return root
  }

  const union = (left, right) => {
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft !== rootRight) parent[rootRight] = rootLeft
  }

  const byFirstToken = new Map()
  for (let index = 0; index < n; index += 1) {
    const tokens = tokenizeProfileDisplayName(profiles[index].display_name)
    if (!tokens.length) continue
    const bucketKey = tokens[0]
    if (!byFirstToken.has(bucketKey)) byFirstToken.set(bucketKey, [])
    byFirstToken.get(bucketKey).push(index)
  }

  for (const indices of byFirstToken.values()) {
    if (indices.length < 2) continue
    for (let left = 0; left < indices.length; left += 1) {
      for (let right = left + 1; right < indices.length; right += 1) {
        const i = indices[left]
        const j = indices[right]
        if (profilesHaveSimilarNames(profiles[i].display_name, profiles[j].display_name)) {
          union(i, j)
        }
      }
    }
  }

  const clustersMap = new Map()
  for (let index = 0; index < n; index += 1) {
    const tokens = tokenizeProfileDisplayName(profiles[index].display_name)
    if (!tokens.length) continue
    const root = find(index)
    if (!clustersMap.has(root)) clustersMap.set(root, [])
    clustersMap.get(root).push(profiles[index])
  }

  return Array.from(clustersMap.values())
}

function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (!email || !email.includes('@')) return null
  return email
}

function normalizePhone(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '')
  if (digits.length < 7) return null
  return digits
}

function isEmptyScalar(v) {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim().length === 0
  return false
}

function deepNonEmptyCount(value) {
  if (isEmptyScalar(value)) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? 1 : 0
  if (typeof value === 'boolean') return 1
  if (typeof value === 'string') return value.trim().length > 0 ? 1 : 0
  if (Array.isArray(value)) {
    let sum = 0
    for (const item of value) sum += deepNonEmptyCount(item)
    return sum
  }
  if (value && typeof value === 'object') {
    let sum = 0
    for (const v of Object.values(value)) sum += deepNonEmptyCount(v)
    return sum
  }
  return 0
}

function mergeValues(existingValue, incomingValue, key = null) {
  if (incomingValue === undefined || incomingValue === null) return existingValue

  if (typeof incomingValue === 'string') {
    const trimmed = incomingValue.trim()
    if (!trimmed) return existingValue
    if (existingValue === undefined || existingValue === null) return trimmed
    if (typeof existingValue !== 'string') return existingValue
    const existingTrimmed = existingValue.trim()
    if (!existingTrimmed) return trimmed
    if (existingTrimmed.toLowerCase().includes(trimmed.toLowerCase())) return existingTrimmed
    // Person-name fields are SINGLE-VALUED: never accumulate two forms of the
    // same name as multi-line text (that synced into display_name and produced
    // the "Jordan Lane Jordan Michael Lane" double). Keep the most-complete
    // single name instead — prefer the longer form, then collapse defensively.
    if (key && PERSON_NAME_FIELDS.has(String(key).toLowerCase())) {
      const longer = trimmed.length > existingTrimmed.length ? trimmed : existingTrimmed
      return dedupeProfileDisplayName(longer)
    }
    return `${existingTrimmed}\n${trimmed}`.trim()
  }

  if (typeof incomingValue === 'number') {
    return Number.isFinite(incomingValue) ? incomingValue : existingValue
  }

  if (typeof incomingValue === 'boolean') {
    return incomingValue
  }

  if (Array.isArray(incomingValue)) {
    const existing = Array.isArray(existingValue) ? existingValue.slice() : []
    const set = new Set(existing.map((entry) => JSON.stringify(entry)))
    for (const entry of incomingValue) {
      const key = JSON.stringify(entry)
      if (!set.has(key)) {
        set.add(key)
        existing.push(entry)
      }
    }
    return existing
  }

  if (incomingValue && typeof incomingValue === 'object') {
    const next = { ...(existingValue && typeof existingValue === 'object' && !Array.isArray(existingValue) ? existingValue : {}) }
    for (const [k, v] of Object.entries(incomingValue)) {
      next[k] = mergeValues(next[k], v, k)
    }
    return next
  }

  return existingValue ?? incomingValue
}

function mergeSection(existingSection = {}, incomingSection = {}) {
  const merged = { ...(existingSection && typeof existingSection === 'object' ? existingSection : {}) }
  for (const [key, value] of Object.entries(incomingSection && typeof incomingSection === 'object' ? incomingSection : {})) {
    merged[key] = mergeValues(merged[key], value, key)
  }
  return merged
}

function summarizeProfileRow(profile, meta) {
  return {
    id: profile.id,
    display_name: profile.display_name,
    primary_type: profile.primary_type ?? null,
    status: profile.status ?? null,
    user_id: profile.user_id ?? null,
    organization_id: profile.organization_id ?? null,
    created_at: profile.created_at ?? null,
    updated_at: profile.updated_at ?? null,
    score: meta.score,
    section_count: meta.sectionCount,
    non_empty_fields: meta.nonEmptyFields,
    documents: meta.documentsCount,
    jobs: meta.jobsCount,
    sessions: meta.sessionsCount,
    billing: meta.billingCount,
  }
}

function pickWinner(candidates) {
  const sorted = candidates.slice().sort((a, b) => {
    if (b.meta.score !== a.meta.score) return b.meta.score - a.meta.score
    const aUpdated = Date.parse(a.profile.updated_at ?? '') || 0
    const bUpdated = Date.parse(b.profile.updated_at ?? '') || 0
    if (bUpdated !== aUpdated) return bUpdated - aUpdated
    return String(a.profile.id).localeCompare(String(b.profile.id))
  })
  return sorted[0]
}

// Hard ceiling on how many profiles a single dedup pass loads into memory. The
// scan loads all candidate profiles plus their sections/docs/jobs and clusters
// them in-process, so an unbounded load is what timed out GET
// /api/admin/profiles/duplicates (504). Far above the real profile count today,
// so behaviour is unchanged in practice — it just caps pathological growth. When
// the cap bites we scan the most-recently-updated profiles and report it.
const DEFAULT_MAX_DEDUP_PROFILES = 5000

export async function findDuplicateProfileGroups(db, {
  strategy = 'exact_name',
  limitGroups = 50,
  minGroupSize = 2,
  includeInactive = false,
  maxProfiles = DEFAULT_MAX_DEDUP_PROFILES,
} = {}) {
  const cap = Math.max(1, Math.min(Number(maxProfiles) || DEFAULT_MAX_DEDUP_PROFILES, 50000))
  const where = includeInactive ? '' : "WHERE status IS NULL OR status <> 'deleted'"
  const profiles = await db
    .prepare(
      `
        SELECT id, display_name, primary_type, status, user_id, organization_id, created_at, updated_at
        FROM profiles
        ${where}
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(cap)

  if (!profiles || profiles.length === 0) return { groups: [], scanned: 0, capped: false }
  const capped = profiles.length >= cap

  const profileIds = profiles.map((p) => p.id)
  const placeholders = profileIds.map(() => '?').join(',')

  const sectionsRows = await db
    .prepare(
      `
        SELECT profile_id, section_key, data
        FROM profile_sections
        WHERE profile_id IN (${placeholders})
      `,
    )
    .all(...profileIds)

  const docsRows = await db
    .prepare(
      `
        SELECT profile_id, COUNT(*) as count
        FROM documents
        WHERE profile_id IN (${placeholders})
        GROUP BY profile_id
      `,
    )
    .all(...profileIds)

  const jobsRows = await db
    .prepare(
      `
        SELECT profile_id, COUNT(*) as count
        FROM crawler_jobs
        WHERE profile_id IN (${placeholders})
        GROUP BY profile_id
      `,
    )
    .all(...profileIds)

  const sessionsRows = await db
    .prepare(
      `
        SELECT profile_id, COUNT(*) as count
        FROM anya_sessions
        WHERE profile_id IN (${placeholders})
        GROUP BY profile_id
      `,
    )
    .all(...profileIds)

  const billingRows = await db
    .prepare(
      `
        SELECT profile_id, COUNT(*) as count
        FROM billing_accounts
        WHERE profile_id IN (${placeholders})
        GROUP BY profile_id
      `,
    )
    .all(...profileIds)

  const sectionsByProfile = new Map()
  for (const row of sectionsRows || []) {
    if (!sectionsByProfile.has(row.profile_id)) sectionsByProfile.set(row.profile_id, [])
    sectionsByProfile.get(row.profile_id).push(row)
  }

  const countsToMap = (rows) => {
    const map = new Map()
    for (const row of rows || []) map.set(row.profile_id, Number(row.count || 0))
    return map
  }

  const docsByProfile = countsToMap(docsRows)
  const jobsByProfile = countsToMap(jobsRows)
  const sessionsByProfile = countsToMap(sessionsRows)
  const billingByProfile = countsToMap(billingRows)

  const signalByProfile = new Map()
  for (const p of profiles) {
    const rows = sectionsByProfile.get(p.id) || []
    let email = null
    let phone = null
    for (const r of rows) {
      const obj = safeParseJSON(r.data, {})
      email = email || normalizeEmail(obj?.email || obj?.primary_email || obj?.contact_email)
      phone = phone || normalizePhone(obj?.phone || obj?.primary_phone)
      if (email && phone) break
    }
    signalByProfile.set(p.id, { email, phone })
  }

  const metaByProfile = new Map()
  for (const p of profiles) {
    const rows = sectionsByProfile.get(p.id) || []
    let nonEmptyFields = 0
    for (const r of rows) nonEmptyFields += deepNonEmptyCount(safeParseJSON(r.data, {}))
    const sectionCount = rows.length
    const documentsCount = docsByProfile.get(p.id) || 0
    const jobsCount = jobsByProfile.get(p.id) || 0
    const sessionsCount = sessionsByProfile.get(p.id) || 0
    const billingCount = billingByProfile.get(p.id) || 0

    const score =
      sectionCount * 50 +
      nonEmptyFields +
      documentsCount * 25 +
      jobsCount * 2 +
      sessionsCount * 2 +
      billingCount * 40 +
      (p.user_id ? 10 : 0) +
      (p.organization_id ? 10 : 0)

    metaByProfile.set(p.id, { score, nonEmptyFields, sectionCount, documentsCount, jobsCount, sessionsCount, billingCount })
  }

  let groups = []

  if (strategy === 'similar_name') {
    const clusters = findSimilarNameClusters(profiles)
    groups = clusters
      .map((members) => buildDuplicateGroupsFromMembers(members, metaByProfile, { minGroupSize }))
      .filter(Boolean)
  } else {
    const makeKey = (p) => {
      const nameKey = normalizeProfileNameKey(p.display_name)
      const signals = signalByProfile.get(p.id) || {}

      if (strategy === 'email_or_phone') {
        return signals.email || signals.phone || nameKey
      }

      return nameKey
    }

    const groupsMap = new Map()
    for (const p of profiles) {
      const key = makeKey(p)
      if (!key) continue
      if (!groupsMap.has(key)) groupsMap.set(key, [])
      groupsMap.get(key).push(p)
    }

    for (const [bucketKey, members] of groupsMap.entries()) {
      const group = buildDuplicateGroupsFromMembers(members, metaByProfile, { minGroupSize, bucketKey })
      if (group) groups.push(group)
    }
  }

  groups.sort((a, b) => (b.count - a.count) || String(a.key).localeCompare(String(b.key)))

  return { groups: groups.slice(0, limitGroups), scanned: profiles.length, capped }
}

let bestEffortSavepointSeq = 0

/**
 * Run a BEST-EFFORT (swallow-on-failure) statement block inside a SAVEPOINT.
 *
 * Why this exists (production 500, 2026-08-06): on PostgreSQL a single failed
 * statement aborts the ENTIRE transaction — every subsequent command then fails
 * with `current transaction is aborted, commands ignored until end of
 * transaction block`. SQLite has no such rule, so a `try { … } catch {}`
 * around an optional write is harmless locally and catastrophic in prod: the
 * swallowed error leaves the connection poisoned and the NEXT (unrelated,
 * non-optional) statement is what surfaces the 500. Wrapping each optional
 * block in a savepoint makes "best effort" actually mean best effort on both
 * dialects — the failed block is rolled back, the outer transaction survives.
 *
 * Returns `{ ok, value, error }` and never throws.
 */
async function runBestEffort(tx, fn) {
  const name = `gf_dedupe_sp_${++bestEffortSavepointSeq}`
  let savepointOpen = false
  try {
    await tx.exec(`SAVEPOINT ${name}`)
    savepointOpen = true
  } catch {
    // No savepoint support (or a mock tx without exec): degrade to a plain
    // guarded call rather than failing the merge outright.
  }

  try {
    const value = await fn()
    if (savepointOpen) {
      try { await tx.exec(`RELEASE SAVEPOINT ${name}`) } catch { /* ignore */ }
    }
    return { ok: true, value, error: null }
  } catch (error) {
    if (savepointOpen) {
      try {
        await tx.exec(`ROLLBACK TO SAVEPOINT ${name}`)
        await tx.exec(`RELEASE SAVEPOINT ${name}`)
      } catch { /* ignore */ }
    }
    return { ok: false, value: undefined, error }
  }
}

async function tableExists(tx, tableName) {
  const name = String(tableName)
  // Dialect detection must not rely on tx.dialect because some transaction wrappers
  // return a client without custom properties. Try Postgres first, then fall back to SQLite.
  try {
    const row = await tx.prepare('SELECT to_regclass(?) as reg').get(name)
    // If this query succeeded, we are on Postgres.
    return Boolean(row?.reg)
  } catch {
    // fall through to SQLite detection
  }

  const row = await tx
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type='table' AND name=?
        LIMIT 1
      `,
    )
    .get(name)
  return Boolean(row?.name)
}

async function columnExists(tx, tableName, columnName) {
  const table = String(tableName)
  const col = String(columnName)
  if (!table || !col) return false

  // Same as tableExists: do not assume tx.dialect exists.
  try {
    const row = await tx
      .prepare(
        `
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = ?
            AND column_name = ?
          LIMIT 1
        `,
      )
      .get(table, col)
    return Boolean(row)
  } catch {
    // fall through to SQLite PRAGMA
  }

  // SQLite: PRAGMA table_info doesn't accept bound params, so we must validate the identifier.
  if (!/^[a-zA-Z0-9_]+$/.test(table)) return false
  // Use allowlist validation instead of regex for critical security
const ALLOWED_TABLES = ['profiles', 'profile_sections', 'documents', 'crawler_jobs', 'anya_sessions', 'billing_accounts', 'profile_emails', 'profile_documents', 'anya_brain_memory', 'service_applications', 'crawler_schedules', 'anya_tasks', 'anya_tool_usage', 'funding_opportunities', 'audit_logs', 'grants'];
if (!ALLOWED_TABLES.includes(table)) return false;
const rows = await tx.prepare(`PRAGMA table_info(${table})`).all()
  return (rows || []).some((r) => String(r?.name || '') === col)
}

async function safeRepointProfileId(tx, {
  table,
  idColumn = 'profile_id',
  fromId,
  toId,
  whereExtraSql = '',
  whereExtraArgs = [],
}) {
  if (!fromId || !toId) return { skipped: true, reason: 'missing ids' }
  if (!(await tableExists(tx, table))) return { skipped: true, reason: `missing table ${table}` }
  if (!(await columnExists(tx, table, idColumn))) return { skipped: true, reason: `missing column ${table}.${idColumn}` }

  const where = `${idColumn} = ?${whereExtraSql ? ` AND (${whereExtraSql})` : ''}`
  const sql = `UPDATE ${table} SET ${idColumn} = ? WHERE ${where}`
  await tx.prepare(sql).run(toId, fromId, ...(whereExtraArgs || []))
  return { skipped: false }
}

async function mergeProfileEmails(tx, { winnerId, loserId, dryRun }) {
  // Merge `profile_emails` (additional access emails) if present.
  if (!(await tableExists(tx, 'profile_emails'))) {
    return { type: 'profile_emails.merge', from: loserId, to: winnerId, skipped: true, reason: 'profile_emails table missing' }
  }
  const okCols =
    (await columnExists(tx, 'profile_emails', 'profile_id')) &&
    (await columnExists(tx, 'profile_emails', 'email'))
  if (!okCols) {
    return { type: 'profile_emails.merge', from: loserId, to: winnerId, skipped: true, reason: 'profile_emails schema missing' }
  }

  if (dryRun) {
    return { type: 'profile_emails.merge', from: loserId, to: winnerId }
  }

  const rows = await tx
    .prepare(
      `
        SELECT email
        FROM profile_emails
        WHERE profile_id = ?
      `,
    )
    .all(loserId)

  const emails = Array.from(new Set((rows || [])
    .map((r) => String(r?.email || '').trim().toLowerCase())
    .filter(Boolean)))

  if (emails.length === 0) {
    await tx.prepare('DELETE FROM profile_emails WHERE profile_id = ?').run(loserId)
    return { type: 'profile_emails.merge', from: loserId, to: winnerId, skipped: true, reason: 'no emails to merge' }
  }

  // Dialect-specific ignore/upsert.
  const isPostgres = String(tx?.dialect || '').toLowerCase() === 'postgres'
  if (isPostgres) {
    for (const email of emails) {
      await tx
        .prepare(
          `
            INSERT INTO profile_emails (id, profile_id, email, added_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (profile_id, email) DO NOTHING
          `,
        )
        .run(crypto.randomUUID(), winnerId, email, 'profile_merge')
    }
  } else {
    for (const email of emails) {
      await tx
        .prepare(
          `
            INSERT OR IGNORE INTO profile_emails (id, profile_id, email, added_by)
            VALUES (?, ?, ?, ?)
          `,
        )
        .run(crypto.randomUUID(), winnerId, email, 'profile_merge')
    }
  }

  await tx.prepare('DELETE FROM profile_emails WHERE profile_id = ?').run(loserId)
  return { type: 'profile_emails.merge', from: loserId, to: winnerId, count: emails.length }
}

export async function mergeProfiles(db, {
  winnerId,
  loserIds,
  dryRun = true,
  actorUserId = null,
} = {}) {
  if (!winnerId || !Array.isArray(loserIds) || loserIds.length === 0) {
    throw new Error('mergeProfiles requires winnerId and loserIds[]')
  }
  const uniqueLoserIds = Array.from(new Set(loserIds.filter(Boolean).map(String)))
  if (uniqueLoserIds.includes(String(winnerId))) {
    throw new Error('loserIds must not include winnerId')
  }

  return await db.withTransaction(async (tx) => {
    const winner = await tx
        .prepare('SELECT id, display_name, user_id, organization_id FROM profiles WHERE id = ?')
        .get(winnerId)
      if (!winner) throw new Error(`Winner profile not found: ${winnerId}`)

    const changes = []

    const winnerSectionsRows = await tx
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(winnerId)
    const winnerSections = new Map()
    for (const row of winnerSectionsRows || []) {
      winnerSections.set(row.section_key, safeParseJSON(row.data, {}))
    }

    const ensureProfileFields = async (loserProfile) => {
      const updates = {}
      if (!winner.user_id && loserProfile?.user_id) updates.user_id = loserProfile.user_id
      if (!winner.organization_id && loserProfile?.organization_id) updates.organization_id = loserProfile.organization_id
      const keys = Object.keys(updates)
      if (keys.length === 0) return null
      if (dryRun) return { type: 'profiles.update', winnerId, set: updates }

      // Clear transferred fields on the loser FIRST to avoid unique constraint violations
      // (e.g., ux_profiles_user_id requires user_id to be unique across all profiles)
      if (updates.user_id) {
        await tx.prepare('UPDATE profiles SET user_id = NULL WHERE id = ?').run(loserProfile.id)
      }
      if (updates.organization_id) {
        await tx.prepare('UPDATE profiles SET organization_id = NULL WHERE id = ?').run(loserProfile.id)
      }

      const sets = keys.map((k) => `${k} = ?`).join(', ')
      await tx.prepare(`UPDATE profiles SET ${sets} WHERE id = ?`).run(...keys.map((k) => updates[k]), winnerId)
      Object.assign(winner, updates)
      return { type: 'profiles.update', winnerId, set: updates }
    }

    const mergeSectionsFromLoser = async (loserId) => {
      const rows = await tx
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(loserId)

      const sectionOps = []
      for (const row of rows || []) {
        const key = row.section_key
        const incoming = safeParseJSON(row.data, {})
        const existing = winnerSections.get(key)
        if (!existing) {
          if (!dryRun) {
            await tx
              .prepare(
                `
                  INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
                  VALUES (?, ?, ?, ?)
                `,
              )
              .run(winnerId, key, JSON.stringify(incoming), 'profile_merge')
          }
          winnerSections.set(key, incoming)
          sectionOps.push({ section_key: key, action: 'insert' })
          continue
        }

        const merged = mergeSection(existing, incoming)
        if (!dryRun) {
          await tx
            .prepare(
              `
                UPDATE profile_sections
                SET data = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
                WHERE profile_id = ? AND section_key = ?
              `,
            )
            .run(JSON.stringify(merged), 'profile_merge', winnerId, key)
        }
        winnerSections.set(key, merged)
        sectionOps.push({ section_key: key, action: 'merge' })
      }

      return sectionOps
    }

    const mergeProfileDocuments = async (loserId) => {
      if (dryRun) return { type: 'profile_documents.repoint', from: loserId, to: winnerId }
      if (!(await tableExists(tx, 'profile_documents'))) {
        return { type: 'profile_documents.repoint', from: loserId, to: winnerId, skipped: true, reason: 'profile_documents table missing' }
      }
      const isPostgres = String(tx?.dialect || db?.dialect || '').toLowerCase() === 'postgres'
      if (isPostgres) {
        await tx
          .prepare(
            `
              INSERT INTO profile_documents (profile_id, document_id)
              SELECT ?, document_id
              FROM profile_documents
              WHERE profile_id = ?
              ON CONFLICT DO NOTHING
            `,
          )
          .run(winnerId, loserId)
      } else {
        await tx
          .prepare(
            `
              INSERT OR IGNORE INTO profile_documents (profile_id, document_id)
              SELECT ?, document_id
              FROM profile_documents
              WHERE profile_id = ?
            `,
          )
          .run(winnerId, loserId)
      }
      await tx.prepare('DELETE FROM profile_documents WHERE profile_id = ?').run(loserId)
      return { type: 'profile_documents.repoint', from: loserId, to: winnerId }
    }

    const mergeBillingAccounts = async (loserId) => {
      if (!(await tableExists(tx, 'billing_accounts'))) return null
      const winnerAcct = await tx.prepare('SELECT id, metadata FROM billing_accounts WHERE profile_id = ?').get(winnerId)
      const loserAcct = await tx.prepare('SELECT id, metadata FROM billing_accounts WHERE profile_id = ?').get(loserId)
      if (!winnerAcct && !loserAcct) return null
      if (dryRun) {
        return {
          type: 'billing.merge',
          winnerAccountId: winnerAcct?.id ?? null,
          loserAccountId: loserAcct?.id ?? null,
        }
      }

      if (loserAcct && !winnerAcct) {
        const result = await tx.prepare('UPDATE billing_accounts SET profile_id = ? WHERE id = ?').run(winnerId, loserAcct.id)
        if (result.changes === 0) {
          throw new Error(`Failed to transfer billing account ${loserAcct.id} to winner ${winnerId}`)
        }
        return { type: 'billing.transfer', accountId: loserAcct.id, to: winnerId }
      }

      if (loserAcct && winnerAcct) {
        if (await tableExists(tx, 'billing_account_events')) {
          await tx.prepare('UPDATE billing_account_events SET account_id = ? WHERE account_id = ?').run(winnerAcct.id, loserAcct.id)
        }

        const mergedMeta = mergeSection(
          safeParseJSON(winnerAcct.metadata, {}),
          safeParseJSON(loserAcct.metadata, {}),
        )
        await tx.prepare('UPDATE billing_accounts SET metadata = ? WHERE id = ?').run(JSON.stringify(mergedMeta), winnerAcct.id)

        await tx.prepare('DELETE FROM billing_accounts WHERE id = ?').run(loserAcct.id)
        return { type: 'billing.merge', winnerAccountId: winnerAcct.id, deletedAccountId: loserAcct.id }
      }

      return null
    }

    for (const loserId of uniqueLoserIds) {
      const loser = await tx
        .prepare('SELECT id, display_name, user_id, organization_id FROM profiles WHERE id = ?')
        .get(loserId)
      if (!loser) continue

      const profileFieldUpdate = await ensureProfileFields(loser)
      if (profileFieldUpdate) changes.push(profileFieldUpdate)

      // Preserve access emails (board members, alternates, etc.) by merging `profile_emails` first.
      const emailsOutcome = await runBestEffort(tx, () => mergeProfileEmails(tx, { winnerId, loserId, dryRun }))
      if (emailsOutcome.ok) {
        changes.push(emailsOutcome.value)
      } else {
        changes.push({
          type: 'profile_emails.merge',
          from: loserId,
          to: winnerId,
          skipped: true,
          reason: emailsOutcome.error?.message || String(emailsOutcome.error),
        })
      }

      const sectionOps = await mergeSectionsFromLoser(loserId)
      changes.push({ type: 'profile_sections.merge', from: loserId, to: winnerId, ops: sectionOps })

      changes.push(await mergeProfileDocuments(loserId))

      if (dryRun) {
        changes.push({ type: 'documents.repoint', from: loserId, to: winnerId })
        changes.push({ type: 'crawler_jobs.repoint', from: loserId, to: winnerId })
        changes.push({ type: 'crawler_schedules.repoint', from: loserId, to: winnerId })
        changes.push({ type: 'anya_sessions.repoint', from: loserId, to: winnerId })
        changes.push({ type: 'anya_tasks.repoint', from: loserId, to: winnerId })
        changes.push({ type: 'anya_tool_usage.repoint', from: loserId, to: winnerId })
        changes.push({ type: 'service_applications.repoint', from: loserId, to: winnerId })
        changes.push({ type: 'funding_opportunities.repoint', from: loserId, to: winnerId })
        changes.push({ type: 'anya_brain_memory.repoint', from: loserId, to: winnerId })
      } else {
        // Check for active applications before merge (only if table+column exist)
        if (await tableExists(tx, 'service_applications') && await columnExists(tx, 'service_applications', 'status')) {
          const activeApps = await tx.prepare('SELECT COUNT(*) as count FROM service_applications WHERE profile_id = ? AND status IN (?, ?, ?)').get(loserId, 'submitted', 'under_review', 'approved')
          if (activeApps?.count > 0 && !dryRun) {
            throw new Error(`Cannot merge profile ${loserId} - has ${activeApps.count} active funding applications`)
          }
        }
        const repoints = [
          { table: 'documents', idColumn: 'profile_id' },
          { table: 'crawler_jobs', idColumn: 'profile_id' },
          { table: 'crawler_schedules', idColumn: 'profile_id' },
          { table: 'anya_sessions', idColumn: 'profile_id' },
          { table: 'anya_tasks', idColumn: 'profile_id' },
          { table: 'anya_tool_usage', idColumn: 'profile_id' },
          { table: 'service_applications', idColumn: 'profile_id' },
          { table: 'funding_opportunities', idColumn: 'profile_id' },
        ]

        for (const repoint of repoints) {
          const outcome = await safeRepointProfileId(tx, {
            table: repoint.table,
            idColumn: repoint.idColumn,
            fromId: loserId,
            toId: winnerId,
          })
          if (outcome?.skipped) {
            changes.push({ type: `${repoint.table}.repoint`, from: loserId, to: winnerId, skipped: true, reason: outcome.reason })
          }
        }

        // Anya brain memory uses scope_id instead of profile_id.
        if (await tableExists(tx, 'anya_brain_memory')) {
          const okCols =
            (await columnExists(tx, 'anya_brain_memory', 'scope')) &&
            (await columnExists(tx, 'anya_brain_memory', 'scope_id'))
          if (okCols) {
            await tx
              .prepare("UPDATE anya_brain_memory SET scope_id = ? WHERE scope = 'profile' AND scope_id = ?")
              .run(winnerId, loserId)
          } else {
            changes.push({ type: 'anya_brain_memory.repoint', from: loserId, to: winnerId, skipped: true, reason: 'missing anya_brain_memory columns' })
          }
        } else {
          changes.push({ type: 'anya_brain_memory.repoint', from: loserId, to: winnerId, skipped: true, reason: 'missing anya_brain_memory table' })
        }
      }

      const billingOp = await mergeBillingAccounts(loserId)
      if (billingOp) changes.push(billingOp)

      if (!dryRun) {
        await runBestEffort(tx, async () => {
          if (await tableExists(tx, 'audit_logs')) {
            await tx.prepare('UPDATE audit_logs SET profile_id = ? WHERE profile_id = ?').run(winnerId, loserId)
          }
        })
      }

      if (dryRun) {
        changes.push({ type: 'profiles.delete', id: loserId })
      } else {
        // Clear user_id on loser before deletion to prevent unique constraint violations
        // (ux_profiles_user_id) if the loser still has a user_id at this point
        await runBestEffort(tx, () =>
          tx.prepare('UPDATE profiles SET user_id = NULL WHERE id = ? AND user_id IS NOT NULL').run(loserId))

        // The hard-delete is attempted inside a savepoint precisely so the
        // documented FK fallback below can run: on Postgres an FK violation
        // aborts the transaction, so without the savepoint the "soft-delete
        // instead" recovery statement could never execute.
        const deleteOutcome = await runBestEffort(tx, async () => {
          const deleteResult = await tx.prepare('DELETE FROM profiles WHERE id = ?').run(loserId)
          return Number(deleteResult?.changes ?? 0)
        })

        if (deleteOutcome.ok && deleteOutcome.value > 0) {
          changes.push({ type: 'profiles.delete', id: loserId })
        } else {
          // Postgres can enforce FK constraints that SQLite doesn't. If hard-delete fails
          // (or removed nothing), soft-delete instead so the merge operation succeeds
          // without leaving data inconsistent.
          const softResult = await tx
            .prepare("UPDATE profiles SET status = 'deleted', user_id = NULL WHERE id = ?")
            .run(loserId)
          if (Number(softResult?.changes ?? 0) === 0) {
            if (deleteOutcome.error) throw deleteOutcome.error
            throw new Error(`Merged profile ${loserId} could not be deleted or soft-deleted`)
          }
          changes.push({
            type: 'profiles.soft_delete',
            id: loserId,
            reason: deleteOutcome.error
              ? (deleteOutcome.error?.message || String(deleteOutcome.error))
              : 'hard delete removed 0 rows',
          })
        }
      }

      if (!dryRun && actorUserId) {
        // `audit_logs.id` is `TEXT PRIMARY KEY` with NO default on BOTH dialects.
        // SQLite tolerates a NULL in a non-INTEGER PRIMARY KEY column, so omitting
        // `id` inserted a NULL row locally and threw
        // `null value in column "id" ... violates not-null constraint` on
        // Postgres — which aborted the merge transaction and made the NEXT
        // loser's SELECT fail with "current transaction is aborted" (the
        // observed prod 500). Supply the id explicitly, like every other
        // audit_logs writer in this repo.
        await runBestEffort(tx, async () => {
          if (await tableExists(tx, 'audit_logs')) {
            await tx
              .prepare(
                `
                  INSERT INTO audit_logs (id, category, action, severity, user_id, profile_id, resource_type, resource_id, details)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
              )
              .run(
                crypto.randomUUID(),
                'admin',
                'profile_merge',
                'info',
                actorUserId,
                winnerId,
                'profile',
                loserId,
                JSON.stringify({ winner_id: winnerId, loser_id: loserId }),
              )
          }
        })
      }
    }

    return {
      dry_run: dryRun,
      winner_id: winnerId,
      merged_loser_ids: uniqueLoserIds,
      changes,
    }
  })
}

export function coerceDryRun(value, defaultDryRun = true) {
  if (value === false || value === 0) return false
  if (value === true || value === 1) return true
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'false' || text === '0' || text === 'apply') return false
  if (text === 'true' || text === '1' || text === 'dry-run' || text === 'dry_run') return true
  return defaultDryRun
}

function normalizeProfileEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (!email || !email.includes('@')) return null
  return email
}

async function loadProfileEmailSignals(db, profileIds) {
  const ids = Array.from(new Set((profileIds || []).filter(Boolean).map(String)))
  const byProfile = new Map(ids.map((id) => [id, new Set()]))
  if (ids.length === 0) return byProfile

  const placeholders = ids.map(() => '?').join(', ')
  const sectionRows = await db
    .prepare(
      `
        SELECT profile_id, data
        FROM profile_sections
        WHERE profile_id IN (${placeholders})
      `,
    )
    .all(...ids)

  for (const row of sectionRows || []) {
    const pid = String(row.profile_id || '')
    if (!pid || !byProfile.has(pid)) continue
    const obj = safeParseJSON(row.data, null)
    if (!obj || typeof obj !== 'object') continue
    for (const candidate of [obj.email, obj.primary_email, obj.contact_email, obj.contactEmail]) {
      const email = normalizeProfileEmail(candidate)
      if (email) byProfile.get(pid).add(email)
    }
  }

  try {
    const emailRows = await db
      .prepare(
        `
          SELECT profile_id, email
          FROM profile_emails
          WHERE profile_id IN (${placeholders})
        `,
      )
      .all(...ids)
    for (const row of emailRows || []) {
      const pid = String(row.profile_id || '')
      if (!pid || !byProfile.has(pid)) continue
      const email = normalizeProfileEmail(row.email)
      if (email) byProfile.get(pid).add(email)
    }
  } catch {
    // ignore missing table/schema
  }

  return byProfile
}

export async function chooseWinnerForProfileGroup(db, memberIds) {
  const ids = Array.from(new Set((memberIds || []).filter(Boolean).map(String)))
  if (ids.length < 2) return ids[0] ?? null

  const placeholders = ids.map(() => '?').join(', ')
  const profiles = await db
    .prepare(
      `
        SELECT id, user_id, display_name, updated_at
        FROM profiles
        WHERE id IN (${placeholders})
      `,
    )
    .all(...ids)

  const metricsRows = await db
    .prepare(
      `
        SELECT profile_id, COUNT(*) as section_count, COALESCE(SUM(LENGTH(data)), 0) as data_bytes
        FROM profile_sections
        WHERE profile_id IN (${placeholders})
        GROUP BY profile_id
      `,
    )
    .all(...ids)

  const metricsByProfile = new Map()
  for (const row of metricsRows || []) {
    metricsByProfile.set(String(row.profile_id), {
      sectionCount: Number(row.section_count ?? row.count ?? 0) || 0,
      dataBytes: Number(row.data_bytes ?? 0) || 0,
    })
  }

  const emailsByProfile = await loadProfileEmailSignals(db, ids)

  const userIds = Array.from(new Set((profiles || []).map((p) => p.user_id).filter(Boolean).map(String)))
  const usersById = new Map()
  if (userIds.length > 0) {
    const userPlaceholders = userIds.map(() => '?').join(', ')
    const users = await db
      .prepare(
        `
          SELECT id, primary_email, is_admin
          FROM users
          WHERE id IN (${userPlaceholders})
        `,
      )
      .all(...userIds)
    for (const u of users || []) usersById.set(String(u.id), u)
  }

  let best = null
  let bestScore = -Infinity

  for (const p of profiles || []) {
    const pid = String(p.id)
    const metrics = metricsByProfile.get(pid) || { sectionCount: 0, dataBytes: 0 }
    const updated = Date.parse(p.updated_at ?? '') || 0
    const emails = emailsByProfile.get(pid) || new Set()
    const user = p.user_id ? usersById.get(String(p.user_id)) : null
    const userEmail = normalizeProfileEmail(user?.primary_email)
    const isAdmin = Boolean(user?.is_admin === true || user?.is_admin === 1)
    const ownerEmailMatchesProfile = Boolean(userEmail && emails.has(userEmail))
    const hasNonAdminOwner = Boolean(user && !isAdmin)

    const ownershipWeight =
      ownerEmailMatchesProfile && hasNonAdminOwner ? 1_000_000_000 :
      hasNonAdminOwner ? 1_000_000 :
      isAdmin ? 10_000 :
      0

    const completenessWeight = metrics.sectionCount * 10_000 + Math.floor(metrics.dataBytes / 10)
    const score = ownershipWeight + completenessWeight + Math.floor(updated / 1_000_000)

    if (score > bestScore) {
      bestScore = score
      best = pid
    }
  }

  return best ?? ids[0] ?? null
}

export const PROFILE_DEDUPE_STRATEGIES = Object.freeze(['similar_name', 'exact_name', 'email_or_phone'])

export async function deduplicateProfileGroups(db, {
  strategies = PROFILE_DEDUPE_STRATEGIES,
  limitGroups = 500,
  minGroupSize = 2,
  includeInactive = false,
  dryRun = false,
  actorUserId = null,
} = {}) {
  const strategyList = Array.from(
    new Set((strategies || PROFILE_DEDUPE_STRATEGIES).map((s) => String(s || '').trim()).filter(Boolean)),
  )

  const results = []
  for (const strategy of strategyList) {
    const report = await findDuplicateProfileGroups(db, { strategy, limitGroups, minGroupSize, includeInactive })
    for (const group of report?.groups || []) {
      const memberIds = [group?.winner?.id, ...(group?.losers || []).map((l) => l?.id)].filter(Boolean)
      if (memberIds.length < minGroupSize) continue

      const winnerId = await chooseWinnerForProfileGroup(db, memberIds)
      const loserIds = memberIds.filter((id) => String(id) !== String(winnerId))
      if (!winnerId || loserIds.length === 0) continue

      const merged = await mergeProfiles(db, { winnerId, loserIds, dryRun, actorUserId })
      results.push({
        strategy,
        key: group.key,
        winnerId,
        loserIds,
        dry_run: merged?.dry_run ?? dryRun,
        changes: merged?.changes ?? [],
      })
    }
  }

  return {
    strategies: strategyList,
    merged_groups: results.length,
    results,
  }
}
