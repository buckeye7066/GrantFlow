#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Client } = pg
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const MAX_PROFILES = 10

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

export function normalizeRequestedScope({ profileIds, profileNames } = {}) {
  const ids = [...new Set(csv(profileIds))]
  const names = [...new Set(csv(profileNames))]
  if ((ids.length === 0) === (names.length === 0)) {
    throw new Error('Provide exactly one of profile_ids or profile_names.')
  }
  const selected = ids.length > 0 ? ids : names
  if (selected.length > MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} profiles may be audited.`)
  if (ids.some((id) => !PROFILE_ID_RE.test(id))) throw new Error('One or more profile ids are malformed.')
  if (names.some((name) => name.length > 128 || /[\u0000-\u001f\u007f]/.test(name))) {
    throw new Error('One or more profile names are malformed.')
  }
  return { ids, names }
}

export function resolveUniqueProfileIds(names, rows) {
  return names.map((name) => {
    const requested = name.toLocaleLowerCase('en-US')
    const candidates = (rows || []).filter((row) => {
      const displayName = String(row?.display_name || '').trim().toLocaleLowerCase('en-US')
      return displayName === requested || displayName.split(/\s+/u)[0] === requested
    })
    const exact = candidates.filter((row) => (
      String(row?.display_name || '').trim().toLocaleLowerCase('en-US') === requested
    ))
    const matches = exact.length > 0 ? exact : candidates
    if (matches.length === 0) throw new Error(`No active non-synthetic profile matches ${JSON.stringify(name)}.`)
    if (matches.length > 1) throw new Error(`Profile selector ${JSON.stringify(name)} is ambiguous; use the full display name or an explicit profile id.`)
    return String(matches[0].id)
  })
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function writeScopeFile(file, ids) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const handle = await fs.promises.open(file, 'wx', 0o600)
  try {
    await handle.writeFile(`${ids.join(',')}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

export async function main() {
  const requested = normalizeRequestedScope({
    profileIds: process.env.PROFILE_IDS,
    profileNames: process.env.PROFILE_NAMES,
  })
  let ids = requested.ids
  if (requested.names.length > 0) {
    const client = new Client({
      connectionString: requireEnv('GRANTFLOW_PROD_AUDIT_DATABASE_URL'),
      ssl: { rejectUnauthorized: false },
      application_name: 'grantflow-production-audit-scope-resolver',
      connectionTimeoutMillis: 20_000,
      statement_timeout: 30_000,
    })
    await client.connect()
    try {
      await client.query('BEGIN TRANSACTION READ ONLY')
      const result = await client.query(
        `SELECT id, display_name
           FROM profiles
          WHERE (
            LOWER(TRIM(display_name)) = ANY($1::text[])
            OR LOWER(SPLIT_PART(TRIM(display_name), ' ', 1)) = ANY($1::text[])
          )
            AND COALESCE(status, 'active') = 'active'
            AND COALESCE(created_by, '') <> 'agent:amy'`,
        [requested.names.map((name) => name.toLocaleLowerCase('en-US'))],
      )
      ids = resolveUniqueProfileIds(requested.names, result.rows)
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end().catch(() => {})
    }
  }
  for (const id of ids) process.stdout.write(`::add-mask::${id}\n`)
  await writeScopeFile(requireEnv('PROFILE_SCOPE_FILE'), ids)
  console.log(`[production-audit] resolved ${ids.length} explicitly requested profile(s); identifiers were masked.`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[production-audit] profile scope resolution failed: ${error?.message || error}`)
    process.exitCode = 1
  })
}
