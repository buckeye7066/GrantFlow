// In-container route-logic verifier (no HTTP/auth needed).
// railway ssh "node backend/scripts/verify-routes.mjs <profileId>"
import { getDb } from '../db/index.js';
import { filterOutPipelineMembers, dedupeOpportunityList } from '../services/pipelineExclusion.js';

const profileId = process.argv[2] || 'c4a92724-9cee-416f-ba30-e91b9b5cd885';

async function main() {
  const db = getDb();
  // 1) matching OS-first branch logic
  try {
    const osRows = await db.prepare(
      `SELECT o.*, m.match_score AS os_match_score, m.match_decision AS os_match_decision,
              m.match_explanation AS os_match_explanation, m.match_reasons AS os_match_reasons
         FROM profile_opportunity_matches m JOIN funding_opportunities o ON o.id = m.opportunity_id
        WHERE m.profile_id = ? AND m.matcher_version = 'crawler-os'
          AND (o.is_active IS NULL OR o.is_active = 1) ORDER BY m.match_score DESC`,
    ).all(profileId);
    let mapped = osRows.map((o) => ({ ...o, match_score: o.os_match_score, match_decision: o.os_match_decision }));
    mapped = dedupeOpportunityList(mapped).results;
    mapped = (await filterOutPipelineMembers(db, profileId, mapped)).results;
    const qualified = mapped.filter((o) => Number(o.match_score) >= 35);
    console.log(`[verify] matching OS branch OK — osRows=${osRows.length} qualified=${qualified.length}`);
  } catch (e) {
    console.log('[verify] matching OS branch THREW:', e.message);
  }
  // 2) foundations reverse-lookup
  try {
    const { findSimilarOrgsFunders } = await import('../services/reverseLookupService.js');
    const r = await findSimilarOrgsFunders(db, profileId, { maxResults: 20 });
    console.log('[verify] reverse-lookup OK — keys:', Object.keys(r || {}).join(','));
  } catch (e) {
    console.log('[verify] reverse-lookup THREW:', e.message);
    console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
  }
  process.exit(0);
}
main().catch((e) => { console.error('[verify] ERROR', e); process.exit(1); });
