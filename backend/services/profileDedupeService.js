import { safeParseJSON } from '../utils/safeJson.js'

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

function mergeValues(existingValue, incomingValue) {
  if (incomingValue === undefined || incomingValue === null) return existingValue

  if (typeof incomingValue === 'string') {
    const trimmed = incomingValue.trim()
    if (!trimmed) return existingValue
    if (existingValue === undefined || existingValue === null) return trimmed
    if (typeof existingValue !== 'string') return existingValue
    const existingTrimmed = existingValue.trim()
    if (!existingTrimmed) return trimmed
    if (existingTrimmed.toLowerCase().includes(trimmed.toLowerCase())) return existingTrimmed
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
      next[k] = mergeValues(next[k], v)
    }
    return next
  }

  return existingValue ?? incomingValue
}

function mergeSection(existingSection = {}, incomingSection = {}) {
  const merged = { ...(existingSection && typeof existingSection === 'object' ? existingSection : {}) }
  for (const [key, value] of Object.entries(incomingSection && typeof incomingSection === 'object' ? incomingSection : {})) {
    merged[key] = mergeValues(merged[key], value)
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

export async function findDuplicateProfileGroups(db, {
  strategy = 'exact_name',
  limitGroups = 50,
  minGroupSize = 2,
  includeInactive = false,
} = {}) {
  const where = includeInactive ? '' : "WHERE status IS NULL OR status <> 'deleted'"
  const profiles = await db
    .prepare(
      `
        SELECT id, display_name, primary_type, status, user_id, organization_id, created_at, updated_at
        FROM profiles
        ${where}
      `,
    )
    .all()

  if (!profiles || profiles.length === 0) return { groups: [] }

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

  const groups = []
  for (const [key, members] of groupsMap.entries()) {
    if (!members || members.length < minGroupSize) continue

    const candidates = members.map((profile) => ({ profile, meta: metaByProfile.get(profile.id) || { score: 0 } }))
    const winner = pickWinner(candidates)
    const losers = candidates.filter((c) => c.profile.id !== winner.profile.id)

    groups.push({
      key,
      winner: summarizeProfileRow(winner.profile, winner.meta),
      losers: losers.map((c) => summarizeProfileRow(c.profile, c.meta)),
      count: candidates.length,
    })
  }

  groups.sort((a, b) => (b.count - a.count) || String(a.key).localeCompare(String(b.key)))

  return { groups: groups.slice(0, limitGroups) }
}

async function tableExists(tx, tableName) {
  const name = String(tableName)
  // Dialect detection must not rely solely on tx.dialect. Some wrappers pass a client
  // without custom properties; in that case, probe Postgres first and fall back to SQLite.
  try {
    const row = await tx.prepare('SELECT to_regclass(?) as reg').get(name)
    // If this query succeeds, we are on Postgres.
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

  // Same approach as tableExists: probe Postgres and fall back to SQLite PRAGMA.
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
        await tx.prepare('UPDATE billing_accounts SET profile_id = ? WHERE id = ?').run(winnerId, loserAcct.id)
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
        try {
          if (await tableExists(tx, 'audit_logs')) {
            await tx.prepare('UPDATE audit_logs SET profile_id = ? WHERE profile_id = ?').run(winnerId, loserId)
          }
        } catch {
          // ignore
        }
      }

      if (dryRun) {
        changes.push({ type: 'profiles.delete', id: loserId })
      } else {
        try {
          await tx.prepare('DELETE FROM profiles WHERE id = ?').run(loserId)
          changes.push({ type: 'profiles.delete', id: loserId })
        } catch (deleteError) {
          // Postgres can enforce FK constraints that SQLite doesn't. If hard-delete fails,
          // soft-delete instead so the merge operation succeeds without leaving data inconsistent.
          await tx.prepare("UPDATE profiles SET status = 'deleted' WHERE id = ?").run(loserId)
          changes.push({
            type: 'profiles.soft_delete',
            id: loserId,
            reason: deleteError?.message || String(deleteError),
          })
        }
      }

      if (!dryRun && actorUserId) {
        try {
          if (await tableExists(tx, 'audit_logs')) {
            await tx
              .prepare(
                `
                  INSERT INTO audit_logs (category, action, severity, user_id, profile_id, resource_type, resource_id, details)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `,
              )
              .run(
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
        } catch {
          // ignore
        }
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

