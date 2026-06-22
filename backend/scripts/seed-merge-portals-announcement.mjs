// Seed the "merge your portals" login announcement (idempotent — keyed by title).
// Local: node backend/scripts/seed-merge-portals-announcement.mjs
// Prod:  railway ssh "node backend/scripts/seed-merge-portals-announcement.mjs"
import { getDb } from '../db/index.js'
import crypto from 'node:crypto'

const TITLE = 'New: merge your portals'
const BODY = [
  'We’ve made it easier to manage everything in one place. Here’s what **merging your portals** means and how to use it.',
  '',
  '### What it means',
  '- **One dashboard:** every funding portal tied to your profile (schools, benefits, grant sites) shows up together on your **Portals** page — no more hunting for links.',
  '- **One place to sign in:** log in to each portal once and GrantFlow remembers it, so the tile turns green and you can jump straight back in.',
  '- **A unified view:** when you have more than one profile, merging brings their portals and saved logins into a single, consolidated list.',
  '',
  '### How to merge',
  '1. Open your **Portals** page from your profile.',
  '2. Review the tiles — green means ready, red means it needs a one-time login.',
  '3. Use **Advanced → add a portal / saved logins & sessions** to bring in any portal that isn’t listed yet, or to consolidate logins across profiles.',
  '4. That’s it — your portals stay merged and ready next time you sign in.',
  '',
  'Questions? Just ask Anya, your administrative assistant.',
].join('\n')

async function main() {
  const db = getDb()
  const existing = await db.prepare('SELECT id FROM announcements WHERE title = ? LIMIT 1').get(TITLE)
  if (existing?.id) {
    console.log('[seed-announcement] already present:', existing.id)
    process.exit(0)
  }
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO announcements (id, created_by, title, body, audience, type, active)
     VALUES (?, ?, ?, ?, 'all', 'feature', 1)`,
  ).run(id, 'system_seed', TITLE, BODY)
  console.log('[seed-announcement] created:', id, '— shows to all users on next login')
  process.exit(0)
}
main().catch((e) => { console.error('[seed-announcement] ERROR', e); process.exit(1) })
