/**
 * Deterministic local seed for GrantFlow.
 *
 * Requirements (PHASE 0):
 * - one admin user
 * - two non-admin users
 * - one profile per user
 * - baseline "Source Directory" entries (type=PROGRAM/DIRECTORY)
 * - no grant opportunities (type=OPPORTUNITY) created by this seed
 *
 * Safety:
 * - refuses to run destructively in production unless ALLOW_DESTRUCTIVE_SEED=true
 */

import process from 'node:process'
import { getDb } from '../db/index.js'

function isTruthy(value) {
  const v = String(value || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on'
}

function nowIso() {
  return new Date().toISOString()
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2))
  return {
    reset: !args.has('--no-reset'),
  }
}

async function main() {
  const { reset } = parseArgs(process.argv)

  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
  const isProd = nodeEnv === 'production'
  if (isProd && !isTruthy(process.env.ALLOW_DESTRUCTIVE_SEED)) {
    console.error(
      '[seed] Refusing to run destructive seed in production.\n' +
        'Set ALLOW_DESTRUCTIVE_SEED=true ONLY if you understand the impact.',
    )
    process.exit(1)
  }

  const db = getDb()
  console.log('[seed] Dialect:', db.dialect)

  const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@grantflow.app').trim().toLowerCase()
  const ADMIN_NAME = String(process.env.ADMIN_NAME || 'Admin User').trim()

  const ids = Object.freeze({
    adminUser: '00000000-0000-0000-0000-000000000001',
    user1: '00000000-0000-0000-0000-000000000002',
    user2: '00000000-0000-0000-0000-000000000003',
    org1: '00000000-0000-0000-0000-000000000011',
    org2: '00000000-0000-0000-0000-000000000012',
    profile1: '00000000-0000-0000-0000-000000000021',
    profile2: '00000000-0000-0000-0000-000000000022',
    directory1: '00000000-0000-0000-0000-000000000101',
    directory2: '00000000-0000-0000-0000-000000000102',
  })

  const seedUsers = [
    { id: ids.adminUser, display_name: ADMIN_NAME, primary_email: ADMIN_EMAIL, is_admin: 1 },
    { id: ids.user1, display_name: 'Seed User One', primary_email: 'user1@grantflow.local', is_admin: 0 },
    { id: ids.user2, display_name: 'Seed User Two', primary_email: 'user2@grantflow.local', is_admin: 0 },
  ]

  const seedOrgs = [
    { id: ids.org1, name: 'Seed Org One', applicant_type: 'nonprofit', state: 'OH', city: 'Columbus' },
    { id: ids.org2, name: 'Seed Org Two', applicant_type: 'small_business', state: 'CA', city: 'San Francisco' },
  ]

  const seedProfiles = [
    { id: ids.profile1, display_name: 'Seed Profile One', primary_type: 'nonprofit', user_id: ids.user1, organization_id: ids.org1 },
    { id: ids.profile2, display_name: 'Seed Profile Two', primary_type: 'small_business', user_id: ids.user2, organization_id: ids.org2 },
  ]

  const seedProfileSections = [
    {
      profile_id: ids.profile1,
      section_key: 'basic_information',
      data: {
        legal_name: 'Seed Org One',
        state: 'OH',
        city: 'Columbus',
        applicant_type: 'nonprofit',
      },
    },
    {
      profile_id: ids.profile2,
      section_key: 'basic_information',
      data: {
        legal_name: 'Seed Org Two',
        state: 'CA',
        city: 'San Francisco',
        applicant_type: 'small_business',
      },
    },
  ]

  const seedDirectories = [
    {
      id: ids.directory1,
      title: '211 State Assistance Programs (Directory)',
      sponsor: '211',
      source: 'state_211',
      url: 'https://www.211.org/',
      type: 'DIRECTORY',
      is_national: 1,
      state: 'nationwide',
    },
    {
      id: ids.directory2,
      title: 'SBA Programs (Program Directory)',
      sponsor: 'U.S. Small Business Administration',
      source: 'sba',
      url: 'https://www.sba.gov/funding-programs',
      type: 'PROGRAM',
      is_national: 1,
      state: 'nationwide',
    },
  ]

  async function wipeAllData(tx) {
    if (tx.dialect === 'postgres') {
      const rows = await tx
        .prepare(
          `
            SELECT tablename
            FROM pg_tables
            WHERE schemaname = 'public'
          `,
        )
        .all()

      const tables = (rows || [])
        .map((r) => r?.tablename)
        .filter(Boolean)
        .filter((name) => name !== '_migrations')

      if (tables.length === 0) return

      // TRUNCATE is faster and handles FK graph via CASCADE.
      // RESTART IDENTITY keeps deterministic IDs for SERIAL tables (Postgres schema uses SERIAL for _migrations only).
      await tx.exec(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE;`)
      return
    }

    // sqlite: delete from every user table except migrations bookkeeping.
    // Temporarily disable FK enforcement so ordering doesn't matter.
    try {
      await tx.exec('PRAGMA foreign_keys = OFF;')
    } catch {
      // ignore
    }

    const rows = await tx
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
        `,
      )
      .all()

    const tables = (rows || [])
      .map((r) => r?.name)
      .filter(Boolean)
      .filter((name) => name !== '_migrations' && name !== 'sqlite_sequence')

    for (const table of tables) {
      // eslint-disable-next-line no-await-in-loop
      await tx.exec(`DELETE FROM "${table}";`)
    }

    try {
      await tx.exec('PRAGMA foreign_keys = ON;')
    } catch {
      // ignore
    }
  }

  await db.withTransaction(async (tx) => {
    if (reset) {
      await wipeAllData(tx)
    }

    const upsertUser = tx.prepare(`
      INSERT INTO users (id, display_name, primary_email, is_admin, metadata, created_at, updated_at)
      VALUES (@id, @display_name, @primary_email, @is_admin, @metadata, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_email = excluded.primary_email,
        is_admin = excluded.is_admin,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `)

    const upsertOrg = tx.prepare(`
      INSERT INTO organizations (id, name, applicant_type, state, city, updated_at)
      VALUES (@id, @name, @applicant_type, @state, @city, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        applicant_type = excluded.applicant_type,
        state = excluded.state,
        city = excluded.city,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertUserOrg = tx.prepare(`
      INSERT INTO user_organizations (user_id, organization_id, created_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, organization_id) DO NOTHING
    `)

    const upsertProfile = tx.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, status, tags, avatar_url, organization_id, user_id, updated_at)
      VALUES (@id, @display_name, @primary_type, 'active', '[]', NULL, @organization_id, @user_id, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_type = excluded.primary_type,
        organization_id = excluded.organization_id,
        user_id = excluded.user_id,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertSection = tx.prepare(`
      INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by, updated_at)
      VALUES (@id, @profile_id, @section_key, @data, 'deterministic-seed', CURRENT_TIMESTAMP)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertDirectory = tx.prepare(`
      INSERT INTO funding_opportunities (
        id, title, sponsor, source, source_id, source_url, application_url,
        record_origin, type, is_national, state, is_active, updated_at
      ) VALUES (
        @id, @title, @sponsor, @source, @source_id, @source_url, @application_url,
        'curated_verified', @type, @is_national, @state, 1, CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        sponsor = excluded.sponsor,
        source = excluded.source,
        source_id = excluded.source_id,
        source_url = excluded.source_url,
        application_url = excluded.application_url,
        record_origin = excluded.record_origin,
        type = excluded.type,
        is_national = excluded.is_national,
        state = excluded.state,
        is_active = excluded.is_active,
        updated_at = CURRENT_TIMESTAMP
    `)

    const timestamp = nowIso()
    for (const u of seedUsers) {
      await upsertUser.run({
        ...u,
        metadata: JSON.stringify({ seeded: true }),
        created_at: timestamp,
        updated_at: timestamp,
      })
    }

    for (const o of seedOrgs) {
      await upsertOrg.run(o)
    }

    // Memberships: both users are members of their org; admin is member of both.
    await upsertUserOrg.run(ids.user1, ids.org1)
    await upsertUserOrg.run(ids.user2, ids.org2)
    await upsertUserOrg.run(ids.adminUser, ids.org1)
    await upsertUserOrg.run(ids.adminUser, ids.org2)

    for (const p of seedProfiles) {
      await upsertProfile.run(p)
    }

    for (const s of seedProfileSections) {
      await upsertSection.run({
        id: `${s.profile_id}:${s.section_key}`,
        profile_id: s.profile_id,
        section_key: s.section_key,
        data: JSON.stringify(s.data ?? {}),
      })
    }

    for (const d of seedDirectories) {
      await upsertDirectory.run({
        id: d.id,
        title: d.title,
        sponsor: d.sponsor ?? null,
        source: d.source,
        source_id: d.id,
        source_url: d.url,
        application_url: d.url,
        type: d.type,
        is_national: d.is_national ? 1 : 0,
        state: d.state ?? null,
      })
    }

    // Enforce: this seed creates no OPPORTUNITY rows.
    await tx.exec("DELETE FROM funding_opportunities WHERE type = 'OPPORTUNITY';")
  })

  const counts = {
    users: Number((await db.prepare('SELECT COUNT(*) as c FROM users').get())?.c || 0),
    orgs: Number((await db.prepare('SELECT COUNT(*) as c FROM organizations').get())?.c || 0),
    profiles: Number((await db.prepare('SELECT COUNT(*) as c FROM profiles').get())?.c || 0),
    directories: Number(
      (await db.prepare("SELECT COUNT(*) as c FROM funding_opportunities WHERE type IN ('PROGRAM','DIRECTORY')").get())?.c || 0,
    ),
    opportunities: Number(
      (await db.prepare("SELECT COUNT(*) as c FROM funding_opportunities WHERE type = 'OPPORTUNITY'").get())?.c || 0,
    ),
  }

  console.log('[seed] Done:', counts)
  if (counts.opportunities !== 0) {
    console.error('[seed] Expected 0 OPPORTUNITY rows; got:', counts.opportunities)
    process.exit(1)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error('[seed] Failed:', err?.stack || err?.message || String(err))
  process.exit(1)
})

