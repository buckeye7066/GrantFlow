// Cleanse bad matches from every profile's pipeline (and, by extension,
// Hamilton's derived mail/fax list), then refresh Hamilton's portal index.
//
// A pipeline grant is a BAD MATCH if, re-evaluated now, it is:
//   - a templated GEO-STUB ("Community Action Agency near X, TN", etc.), OR
//   - applicant-type ineligible for the profile (e.g. a professional-CE / nurse /
//     physician / nonprofit-only opportunity sitting in an individual student's
//     pipeline), with no overlap between the profile's applicant types and the
//     opportunity's inferred applicant types.
//
// User-progressed/awarded work (PROTECTED_PIPELINE_STATUSES) is NEVER purged.
// Removal is the canonical sticky-delete (recordDismissal + reconcile).
//
// In-container:
//   railway ssh "node backend/scripts/pipeline-cleanse.mjs --audit"     (list only)
//   railway ssh "node backend/scripts/pipeline-cleanse.mjs"             (purge + refresh)
//   railway ssh "node backend/scripts/pipeline-cleanse.mjs --profile=ID"

import { getDb } from '../db/index.js';
import { recordDismissal, reconcileDismissedGrants } from '../services/pipelineDismissals.js';
import { PROTECTED_PIPELINE_STATUSES } from '../startup/enforceInvariants.js';
import { isTemplatedGeoStub } from '../services/relevanceFilterRules.js';
import { buildThesis } from '../crawler-os/index.js';
import { inferCandidateProfile } from '../crawler-os/crawlerVocabulary.js';
import { profileContextToThesisInput } from '../services/crawlerOsPersistence.js';
import { loadProfileContext } from '../services/profileHelpers.js';
import { preResolveProfilePortals } from '../services/hamilton/profilePortalIndex.js';

const PROTECTED = new Set(PROTECTED_PIPELINE_STATUSES);
const AUDIT = process.argv.includes('--audit');
const oneArg = process.argv.find((a) => a.startsWith('--profile='));
const onlyId = oneArg ? oneArg.split('=')[1] : null;

// Org-only applicant types: an opportunity that ONLY serves these is ineligible
// for an individual/family/student profile.
const ORG_ONLY = new Set(['nonprofit', 'church', 'ministry', 'school', 'vfd', 'business', 'farm', 'government']);
const INDIVIDUAL_TYPES = new Set(['individual', 'family', 'student', 'veteran']);

function classifyBad(opp, thesis) {
  // 1) geo-stub
  if (isTemplatedGeoStub({ title: opp.title, record_type: opp.record_type, opportunity_kind: opp.opportunity_kind })) {
    return 'geo_stub';
  }
  // 2) applicant-type ineligibility for an individual/household profile
  const profileIsIndividual = thesis.applicant_types.some((t) => INDIVIDUAL_TYPES.has(t)) && !thesis.is_org;
  if (profileIsIndividual) {
    const raw = { title: opp.title, summary: opp.description || opp.summary, sponsor: opp.sponsor };
    const inferred = inferCandidateProfile(raw, {});
    const oppTypes = (inferred.applicant_types || []).filter((t) => t !== '*');
    if (oppTypes.length > 0) {
      const servesIndividual = oppTypes.some((t) => INDIVIDUAL_TYPES.has(t));
      const orgOnly = oppTypes.every((t) => ORG_ONLY.has(t));
      if (orgOnly && !servesIndividual) return 'applicant_type_mismatch';
    }
  }
  return null;
}

async function cleanseProfile(db, profileId) {
  const grants = await db
    .prepare(`SELECT g.id, g.status, g.title, g.funding_opportunity_id,
                     fo.title AS fo_title, fo.description, fo.sponsor, fo.record_type, fo.opportunity_kind
                FROM grants g LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
               WHERE g.profile_id = ?`)
    .all(profileId);
  if (!grants.length) return { scanned: 0, bad: [], dismissed: 0 };

  let thesis;
  try {
    thesis = buildThesis(profileContextToThesisInput(await loadProfileContext(db, profileId)));
  } catch {
    thesis = buildThesis({ id: profileId });
  }

  const bad = [];
  for (const g of grants) {
    if (g.status && PROTECTED.has(g.status)) continue; // never purge user-progressed work
    const opp = { title: g.fo_title || g.title, description: g.description, sponsor: g.sponsor, record_type: g.record_type, opportunity_kind: g.opportunity_kind };
    const reason = classifyBad(opp, thesis);
    if (reason) bad.push({ grantId: g.id, oppId: g.funding_opportunity_id, title: opp.title, status: g.status, reason });
  }

  let dismissed = 0;
  if (!AUDIT && bad.length) {
    for (const b of bad) {
      await recordDismissal(db, {
        profileId,
        opportunity: { id: b.oppId, title: b.title },
        reason: `pipeline_cleanse:${b.reason}`,
      });
      dismissed += 1;
    }
    await reconcileDismissedGrants(db);
    // Refresh Hamilton's portal index so his mail/fax list reflects the cleaned pipeline.
    try { await preResolveProfilePortals(db, profileId); } catch (e) { console.warn(`[cleanse] portal refresh failed for ${profileId}: ${e.message}`); }
  }
  return { scanned: grants.length, bad, dismissed };
}

async function main() {
  const db = getDb();
  let ids;
  if (onlyId) ids = [onlyId];
  else ids = (await db.prepare(`SELECT id FROM profiles WHERE status = 'active' OR status IS NULL`).all()).map((r) => r.id);

  console.log(`[cleanse] mode=${AUDIT ? 'AUDIT' : 'PURGE'} profiles=${ids.length}`);
  let totalBad = 0;
  let totalDismissed = 0;
  for (const id of ids) {
    const r = await cleanseProfile(db, id);
    if (r.bad.length) {
      console.log(`[cleanse] ${id}: scanned=${r.scanned} bad=${r.bad.length} dismissed=${r.dismissed}`);
      for (const b of r.bad) console.log(`    [${b.reason}] (${b.status}) ${b.title}`);
    }
    totalBad += r.bad.length;
    totalDismissed += r.dismissed;
  }
  console.log(`[cleanse] done — bad_matches=${totalBad} dismissed=${totalDismissed}`);
  process.exit(0);
}

main().catch((e) => { console.error('[cleanse] ERROR', e); process.exit(1); });
