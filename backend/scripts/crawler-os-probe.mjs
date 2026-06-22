// Read-only prod schema probe for the Crawler OS cutover.
// In-container: railway ssh "node backend/scripts/crawler-os-probe.mjs"
import { getDb } from '../db/index.js';
const db = getDb();
console.log('dialect:', db.dialect);
async function has(table, col) {
  const r = await db
    .prepare(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = ? AND column_name = ? LIMIT 1`)
    .get(table, col);
  return Boolean(r);
}
async function tableExists(table) {
  const r = await db
    .prepare(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = ? LIMIT 1`)
    .get(table);
  return Boolean(r);
}
console.log('fo.canonical_opportunity_key:', await has('funding_opportunities', 'canonical_opportunity_key'));
console.log('opportunity_sources table:', await tableExists('opportunity_sources'));
console.log('pom.matcher_version:', await has('profile_opportunity_matches', 'matcher_version'));
console.log('pom.match_explain_json:', await has('profile_opportunity_matches', 'match_explain_json'));
console.log('pom.match_decision:', await has('profile_opportunity_matches', 'match_decision'));
const p = await db.prepare('SELECT COUNT(*) AS c FROM profiles').get();
console.log('prod profiles:', p.c ?? p.C);
try {
  const m = await db.prepare(`SELECT COUNT(*) AS c FROM profile_opportunity_matches WHERE matcher_version = 'crawler-os'`).get();
  console.log('crawler-os matches on prod:', m.c ?? m.C);
} catch (e) {
  console.log('crawler-os matches query err:', e.message);
}
process.exit(0);
