import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { buildIsolatedTestEnv } from '../../scripts/test-environment.mjs'

// This fixture always uses a newly-created local directory and a loopback listener.
// It cannot connect to a deployed database or make paid model calls.
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-ux-'))
const isolatedEnv = buildIsolatedTestEnv(process.env)
for (const key of Object.keys(process.env)) if (!(key in isolatedEnv)) delete process.env[key]
Object.assign(process.env, isolatedEnv)
Object.assign(process.env, {
  NODE_ENV: 'test', SMOKE_MODE: 'true', GRANTFLOW_TEST_RUNNER: '1', DB_AUTO_MIGRATE: 'true',
  // Multiple authorized fixture accounts share one loopback IP. Production defaults are unchanged.
  AUTH_PASSWORD_RATE_LIMIT: '100', API_AUTH_RATE_LIMIT_MAX: '300',
  SQLITE_DB_PATH: path.join(runtime, 'test.sqlite'), DB_PROVIDER: 'sqlite', DB_DIALECT: 'sqlite',
  DATA_DIR: runtime, UPLOADS_DIR: path.join(runtime, 'uploads'),
  ANYA_AUTONOMOUS_ENABLED: 'false', NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
  DISABLE_BACKGROUND_SERVICES: 'true', ENABLE_REGISTRY_VERIFICATION: 'false', ENABLE_CENSUS_GEO: 'false',
  JWT_SECRET: crypto.randomBytes(48).toString('hex'), ADMIN_EMAIL: 'admin-e2e@example.invalid',
})
for (const args of [['backend/db/migrate.js'], ['backend/scripts/seed-deterministic.mjs', '--reset']]) {
  const result = spawnSync(process.execPath, args, { env: process.env, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) throw new Error('Local UX fixture preparation failed')
}
const { default: app } = await import('../../backend/server.js')
const { db } = await import('../../backend/db/index.js')
const { default: bcrypt } = await import('bcryptjs')
const users = await db.prepare('SELECT id, primary_email FROM users').all()
for (const user of users) {
  await db.prepare('UPDATE users SET password_hash = ?, metadata = ? WHERE id = ?').run(
    await bcrypt.hash('UxFixture-Only-2026!', 10), JSON.stringify({ seeded: true }), user.id)
}
const { ensureBillingSchema, ensureBillingAccount } = await import('../../backend/services/billingAccounts.js')
await ensureBillingSchema(db)
for (const type of ['individual', 'family', 'college_student']) {
  const userId = crypto.randomUUID(), profileId = crypto.randomUUID()
  await db.prepare('INSERT INTO users (id, primary_email, display_name, is_admin, password_hash) VALUES (?, ?, ?, 0, ?)').run(userId, 'ux-' + type + '@example.invalid', 'UX ' + type, await bcrypt.hash('UxFixture-Only-2026!', 10))
  await db.prepare("INSERT INTO profiles (id, display_name, primary_type, status, user_id, tags) VALUES (?, ?, ?, 'active', ?, '[]')").run(profileId, 'UX ' + type, type, userId)
  await db.prepare("INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, 'basic_information', ?)").run(crypto.randomUUID(), profileId, JSON.stringify({ full_name: 'UX ' + type, state: 'TN', city: 'Cleveland', zip: '37311', email: 'ux-' + type + '@example.invalid' }))
}
const profiles = await db.prepare('SELECT id, primary_type FROM profiles').all()
for (const profile of profiles) {
  await ensureBillingAccount(db, profile.id, { defaultTier: 'large_org', assignedBy: 'local-ux-fixture' })
  await db.prepare('UPDATE billing_accounts SET is_pro_bono=1, pro_bono_reason=? WHERE profile_id=?').run('Isolated UX fixture, never production', profile.id)
  const sections = {
    organization_details: { organization_type: profile.primary_type === 'nonprofit' ? 'nonprofit' : 'business' },
    narrative: { mission: 'Provide community services and practical assistance.' },
    programs_services: { focus_areas: ['community services'] },
    financial_information: { assistance_needs: ['equipment'], financial_need_level: 'moderate' },
    education: { highest_level: 'college sophomore', intended_major: 'Biology', field_of_study: 'Biology' },
  }
  for (const [key, data] of Object.entries(sections)) await db.prepare(
    "INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by) VALUES (?, ?, ?, ?, 'ux-fixture') ON CONFLICT(profile_id, section_key) DO UPDATE SET data=excluded.data"
  ).run(crypto.randomUUID(), profile.id, key, JSON.stringify(data))
}
const port = 18133
const server = app.listen(port, '127.0.0.1', () => console.log('UX fixture ready on loopback port ' + port))
const close = () => server.close(() => process.exit(0))
process.on('SIGTERM', close)
process.on('SIGINT', close)
