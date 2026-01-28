import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

export const TEST_ADMIN_TOKEN = "test-admin-token"
export const TEST_ADMIN_AUTH_HEADER = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` }

let cached = null

export async function getAppAndDb() {
  if (cached) return cached

  process.env.NODE_ENV = "test"
  process.env.PORT = "0"
  process.env.DB_AUTO_MIGRATE = "true"
  process.env.ADMIN_TOKEN = TEST_ADMIN_TOKEN
  process.env.ANYA_ADMIN_TOKEN = TEST_ADMIN_TOKEN
  process.env.SQLITE_DB_PATH = ":memory:"

  const mod = await import("../server.js")
  const dbMod = await import("../db/index.js")
  cached = { app: mod.default, db: dbMod.db }
  return cached
}

export function resetDb(db) {
  // Best-effort cleanup for isolation across tests.
  // Keep order from most-dependent to least-dependent.
  const statements = [
    "DELETE FROM profile_documents",
    "DELETE FROM documents",
    "DELETE FROM profile_sections",
    "DELETE FROM billing_account_events",
    "DELETE FROM billing_accounts",
    "DELETE FROM grant_pipeline_events",
    "DELETE FROM milestones",
    "DELETE FROM expenses",
    "DELETE FROM application_drafts",
    "DELETE FROM budgets",
    "DELETE FROM grants",
    "DELETE FROM funding_opportunities",
    "DELETE FROM crawler_jobs",
    "DELETE FROM user_verification_codes",
    "DELETE FROM user_credentials",
    "DELETE FROM user_providers",
    "DELETE FROM user_sessions",
    "DELETE FROM oauth_states",
    "DELETE FROM anya_messages",
    "DELETE FROM anya_tasks",
    "DELETE FROM anya_sessions",
    "DELETE FROM profiles",
    "DELETE FROM organizations",
    "DELETE FROM users",
  ]

  statements.forEach((sql) => {
    try {
      db.prepare(sql).run()
    } catch {
      // ignore missing tables in older schemas
    }
  })
}

export async function waitForCrawlerJob(db, jobId, { timeoutMs = 15_000 } = {}) {
  const start = Date.now()
  // polling loop
  while (Date.now() - start < timeoutMs) {
    const row = db.prepare("SELECT * FROM crawler_jobs WHERE id = ?").get(jobId)
    if (!row) {
      throw new Error(`crawler_jobs row missing for job ${jobId}`)
    }
    if (["completed", "failed", "cancelled"].includes(row.status)) {
      return row
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for crawler job ${jobId}`)
}

export function pickAnyZipFromSeed() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const zipPath = path.join(__dirname, "..", "data", "crawlers", "zip_coordinates.json")
  const raw = fs.readFileSync(zipPath, "utf8")
  const json = JSON.parse(raw)
  const zips = Object.keys(json).filter((zip) => /^\d{5}$/.test(zip))
  zips.sort()
  if (zips.length === 0) {
    throw new Error("zip_coordinates.json contains no ZIP entries")
  }
  return zips[0]
}

