/**
 * Seed database on startup
 * This runs automatically when the server starts to ensure data persists
 * across Railway deploys (since Railway uses ephemeral storage)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { computeMatchDecision, MATCHER_VERSION, normalizeProfile, normalizeOpportunity, computeProfileFingerprint, computeOpportunityFingerprint } from '../services/matchEngine.js';
import { evaluatePipelineSource } from '../config/pipelineAllowedSources.js';
import { saveToProfilePipeline } from '../services/opportunityMatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Returns true if this process should NOT run any seeding.
 * Blocked when NODE_ENV=production OR DISABLE_SEEDING=true.
 */
function isSeedingBlocked() {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
  if (nodeEnv === 'production') return true
  const disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
  return disableSeeding === 'true' || disableSeeding === '1'
}

function loadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`[seedOnStartup] Could not load ${path}:`, error.message);
    return null;
  }
}

function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

export function seedFundingOpportunities(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] seedFundingOpportunities: blocked (production or DISABLE_SEEDING)')
    return 0
  }
  console.log('[seedOnStartup] Seeding funding opportunities...');
  
  const REAL_OPPS_PATH = join(__dirname, '../data/crawlers/real_funding_opportunities.json');
  const LOCAL_OPPS_PATH = join(__dirname, '../data/crawlers/local_opportunities.json');
  const SCHOLARSHIP_OPPS_PATH = join(__dirname, '../data/crawlers/scholarship_opportunities.json');
  const ITEM_OPPS_PATH = join(__dirname, '../data/crawlers/item_funding_sources.json');
  
  const realOpps = loadJSON(REAL_OPPS_PATH) || {};
  const localOpps = loadJSON(LOCAL_OPPS_PATH) || [];
  const scholarshipOpps = loadJSON(SCHOLARSHIP_OPPS_PATH) || [];
  const itemOpps = loadJSON(ITEM_OPPS_PATH) || [];
  
  const allOpportunities = [
    ...(realOpps.federal_grants || []),
    ...(realOpps.foundation_grants || []),
    ...(realOpps.state_programs || []),
    ...(realOpps.disability_assistance || []),
    ...(realOpps.veteran_benefits || []),
    ...(realOpps.nonprofit_grants || []),
    ...(realOpps.individual_assistance || []),
    ...(realOpps.healthcare_grants || []),
    ...(realOpps.senior_programs || []),
    ...(realOpps.emergency_assistance || []),
    ...(realOpps.scholarships || []),
    ...localOpps,
    ...scholarshipOpps,
    ...itemOpps,
  ].filter(Boolean);
  
  console.log(`[seedOnStartup] Found ${allOpportunities.length} opportunities to seed`);
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO funding_opportunities (
      id, title, sponsor, description, deadline, amount_min, amount_max,
      application_url, source_url, eligibility_summary, eligibility_bullets,
      categories, keywords, source, source_id, opportunity_type,
      requires_501c3, requires_match, is_national, state, is_active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  
  let seeded = 0;
  for (const opp of allOpportunities) {
    try {
      const id = opp.id || crypto.randomUUID();
      stmt.run(
        id,
        opp.title || 'Untitled',
        opp.sponsor || opp.funder || 'Unknown',
        opp.description || '',
        opp.deadline || null,
        opp.amount_min || opp.min_amount || null,
        opp.amount_max || opp.max_amount || null,
        opp.application_url || opp.url || null,
        opp.source_url || opp.url || null,
        opp.eligibility_summary || '',
        JSON.stringify(ensureArray(opp.eligibility_bullets)),
        JSON.stringify(ensureArray(opp.categories)),
        JSON.stringify(ensureArray(opp.keywords)),
        opp.source || 'seeded',
        opp.source_id || id,
        opp.opportunity_type || 'grant',
        opp.requires_501c3 ? 1 : 0,
        opp.requires_match ? 1 : 0,
        opp.is_national || opp.state === 'nationwide' ? 1 : 0,
        opp.state || null
      );
      seeded++;
    } catch (error) {
      // Ignore duplicates
    }
  }
  
  console.log(`[seedOnStartup] Seeded ${seeded} funding opportunities`);
  return seeded;
}

export async function seedProfileGrants(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] seedProfileGrants: blocked (production or DISABLE_SEEDING)')
    return 0
  }
  console.log('[seedOnStartup] Seeding profile grants...');
  
  // Get all profiles
  const profiles = db.prepare('SELECT * FROM profiles WHERE status = ?').all('active');
  console.log(`[seedOnStartup] Found ${profiles.length} active profiles`);
  
  // Get all opportunities
  const opportunities = db.prepare(`
    SELECT * FROM funding_opportunities 
    WHERE is_active = 1 
    LIMIT 500
  `).all();
  
  console.log(`[seedOnStartup] Found ${opportunities.length} opportunities to match`);
  
  let totalGrantsAdded = 0;
  
  for (const profile of profiles) {
    // Get profile sections
    const sectionsObj = {};
    const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
    sectionRows.forEach(row => {
      try { sectionsObj[row.section_key] = JSON.parse(row.data || '{}'); } catch (e) { sectionsObj[row.section_key] = {}; }
    });
    
    // Adjudicate the complete SQL-bounded candidate set before ranking. A
    // candidate that throws is attempted and then fails closed; no heuristic
    // score or route-local relevance filter gets a preliminary vote.
    const acceptedMatches = [];
    for (const opp of opportunities) {
      try {
        const decision = computeMatchDecision(profile, opp, { profileSections: sectionsObj });
        if (decision.decision === 'ACCEPT') acceptedMatches.push({ opp, decision });
      } catch (error) {
        console.warn(
          `[seedOnStartup] Canonical adjudication failed for opportunity ${opp.id || opp.title || 'unknown'}:`,
          error?.message || error,
        );
      }
    }
    const topMatches = acceptedMatches
      .sort((a, b) => Number(b.decision.score || 0) - Number(a.decision.score || 0))
      .slice(0, 50);
    
    // Ensure organization exists
    let orgId = profile.organization_id;
    if (!orgId) {
      orgId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
        VALUES (?, ?, 'individual_need', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(orgId, profile.display_name || 'My Organization');
      db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id);
    }

    // Add grants to pipeline.
    //
    // Route every seed insert through the canonical gated saver
    // (saveToProfilePipeline) instead of inserting directly. This guarantees
    // the seed path honors the SAME gates as every other pipeline write:
    // source allowlist, the DISMISSED tombstone (a user-deleted grant must not
    // be resurrected by a startup re-seed), the decision engine, exclusion
    // rules, dedup, and the relevance floor. Seeding is non-production only —
    // isSeedingBlocked guards the caller — but it must still preserve the same
    // single-authority contract as a clean install.
    const seedProfileContext = { profile, sections: sectionsObj };
    let added = 0;
    for (const { opp } of topMatches) {
      try {
        // Let the saver re-verify the canonical decision at the write boundary.
        const result = await saveToProfilePipeline(
          db,
          opp,
          profile.id,
          seedProfileContext,
          null,
          undefined,
        );
        if (result?.saved) added++;
      } catch (e) {
        // Ignore errors — one bad row must not abort the whole seed.
      }
    }
    
    if (added > 0) {
      console.log(`[seedOnStartup] Added ${added} grants for ${profile.display_name}`);
    }
    totalGrantsAdded += added;
  }
  
  console.log(`[seedOnStartup] Total grants added: ${totalGrantsAdded}`);
  return totalGrantsAdded;
}

/**
 * Remove grants from profile pipelines that fail the relevance filter.
 * This is a one-time cleanup that runs on startup (non-production) to remove
 * grants inserted by previous buggy seeding paths.
 * Only removes grants that have a profile_id set (profile-scoped grants).
 */
export function cleanupIrrelevantGrants(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] cleanupIrrelevantGrants: blocked (production or DISABLE_SEEDING)')
    return 0
  }
  console.log('[seedOnStartup] Running cleanup of irrelevant profile grants...');

  // Phase 1: Remove pipeline entries whose linked opportunity has a denied
  // source or untrusted record_origin. The previous implementation issued a
  // raw SQL `NOT IN (PIPELINE_ALLOWED_SOURCES)` clause, which would delete
  // every legitimate domain-crawler row (e.g. "Student Endowments",
  // "Trade School Grants") because those labels were never in the static
  // allowlist. We now evaluate each row in JS using `evaluatePipelineSource`
  // so the same denylist + provenance logic applies as the route gate.
  let removedBySource = 0;
  try {
    const candidates = db.prepare(`
      SELECT g.id, g.title, fo.source, fo.record_origin
      FROM grants g
      JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
      WHERE g.profile_id IS NOT NULL
        AND g.funding_opportunity_id IS NOT NULL
    `).all();

    for (const grant of candidates) {
      const gate = evaluatePipelineSource({
        source: grant.source,
        record_origin: grant.record_origin,
      });
      if (gate.allowed) continue;
      try {
        db.prepare('DELETE FROM grants WHERE id = ?').run(grant.id);
        console.log(
          `[seedOnStartup] Removed disallowed-source grant "${grant.title}" ` +
          `(reason=${gate.reason}, source="${grant.source}", record_origin="${grant.record_origin}")`
        );
        removedBySource++;
      } catch (e) {
        // Ignore per-row errors
      }
    }
    if (removedBySource > 0) {
      console.log(`[seedOnStartup] Removed ${removedBySource} pipeline row(s) from disallowed sources`);
    }
  } catch (e) {
    console.warn('[seedOnStartup] Phase 1 source cleanup failed (non-fatal):', e?.message || e);
  }

  // Do not run the retired route-local relevance/eligibility cleanup here.
  // Canonical re-evaluation is handled below by
  // reEvaluateStalePipelineEntries(), and production convergence is owned by
  // the catalog/pipeline integrity services. This cleanup retains only the
  // explicit source-denylist removal above.
  console.log(`[seedOnStartup] Cleanup complete: removed ${removedBySource} disallowed-source grant(s)`)
  return removedBySource
}

export async function seedOnStartup(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] seedOnStartup: blocked (production or DISABLE_SEEDING)')
    return
  }
  console.log('[seedOnStartup] Starting database seeding...');
  
  // Check if we need to seed
  const grantCount = db.prepare('SELECT COUNT(*) as c FROM grants').get().c;
  const oppCount = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c;
  
  console.log(`[seedOnStartup] Current state: ${oppCount} opportunities, ${grantCount} grants`);

  // Always run cleanup on startup to remove stale irrelevant grants from prior seeding runs
  cleanupIrrelevantGrants(db);
  
  // Seed opportunities if needed
  if (oppCount < 50) {
    seedFundingOpportunities(db);
  }
  
  // Seed grants if needed
  const grantCountAfterCleanup = db.prepare('SELECT COUNT(*) as c FROM grants').get().c;
  if (grantCountAfterCleanup < 50) {
    await seedProfileGrants(db);
  }
  
  console.log('[seedOnStartup] Database seeding complete');

  // Re-evaluate stale pipeline entries: fingerprint or matcher_version changed.
  // Fire-and-forget: startup should not block on potentially long re-evaluation.
  reEvaluateStalePipelineEntries(db).catch(err => {
    console.error('[seedOnStartup] reEvaluateStalePipelineEntries failed:', err)
  })
}

/**
 * Re-evaluate profile pipeline grants whose profile fingerprint, opportunity
 * fingerprint, or matcher_version no longer match the current engine.
 *
 * Stale grants are re-evaluated via computeMatchDecision():
 *   - If the decision is now REJECT, the grant is removed from the pipeline.
 *   - If decision changes to ACCEPT/REVIEW, the stored metadata is updated.
 *
 * This runs on every non-production startup to keep the pipeline consistent
 * after profile changes, opportunity updates, or engine upgrades.
 */
export async function reEvaluateStalePipelineEntries(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] reEvaluateStalePipelineEntries: blocked (production or DISABLE_SEEDING)')
    return { reEvaluated: 0, removed: 0 }
  }

  // Check whether decision columns exist (pre-migration DBs may not have them)
  let hasDecisionColumns = false
  try {
    const dialect = db?.dialect || 'sqlite'
    if (dialect === 'postgres') {
      const row = await db
        .prepare(
          `SELECT 1 AS ok FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = ? AND column_name = ? LIMIT 1`,
        )
        .get('grants', 'matcher_version')
      hasDecisionColumns = Boolean(row?.ok)
    } else {
      const cols = db.prepare('PRAGMA table_info(grants)').all()
      hasDecisionColumns = cols.some(c => c.name === 'matcher_version')
    }
  } catch { /* ignore */ }

  if (!hasDecisionColumns) {
    console.info('[seedOnStartup] reEvaluateStalePipelineEntries: decision columns not present, skipping')
    return { reEvaluated: 0, removed: 0 }
  }

  console.log('[seedOnStartup] Re-evaluating stale profile pipeline entries...')

  // Find all profile-scoped grants where matcher_version differs from the current version
  // OR where profile_fingerprint / opportunity_fingerprint is null (never evaluated by current engine)
  const staleGrants = db.prepare(`
    SELECT g.id AS grant_id, g.profile_id, g.funding_opportunity_id, g.title,
           g.matcher_version, g.profile_fingerprint, g.opportunity_fingerprint,
           fo.id AS fo_id, fo.title AS fo_title, fo.description, fo.keywords,
           fo.categories, fo.state AS fo_state, fo.is_national, fo.sponsor,
           fo.eligibility_bullets, fo.application_url, fo.source_url,
           fo.requires_501c3, fo.requires_match, fo.is_loan, fo.deadline,
           fo.deadline_type, fo.is_active, fo.record_origin, fo.amount_min, fo.amount_max
    FROM grants g
    LEFT JOIN funding_opportunities fo ON g.funding_opportunity_id = fo.id
    WHERE g.profile_id IS NOT NULL
      AND (
        g.matcher_version IS NULL
        OR g.matcher_version <> ?
        OR g.profile_fingerprint IS NULL
        OR g.opportunity_fingerprint IS NULL
      )
    LIMIT 500
  `).all(MATCHER_VERSION)

  if (staleGrants.length === 0) {
    console.log('[seedOnStartup] No stale pipeline entries found.')
    return { reEvaluated: 0, removed: 0 }
  }

  console.log(`[seedOnStartup] Found ${staleGrants.length} stale pipeline entries to re-evaluate.`)

  // Cache profile data to avoid re-querying per grant
  const profileCache = new Map()
  const getProfileWithSections = (profileId) => {
    if (profileCache.has(profileId)) return profileCache.get(profileId)
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profile) { profileCache.set(profileId, null); return null }
    const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
    const sections = {}
    sectionRows.forEach(row => {
      try { sections[row.section_key] = JSON.parse(row.data || '{}') } catch { sections[row.section_key] = {} }
    })
    const result = { profile, sections }
    profileCache.set(profileId, result)
    return result
  }

  let reEvaluated = 0
  let removed = 0

  for (const row of staleGrants) {
    const profileData = getProfileWithSections(row.profile_id)
    if (!profileData) continue

    // Reconstruct the opportunity object for the decision engine
    const opp = {
      id: row.fo_id,
      title: row.fo_title || row.title,
      description: row.description,
      keywords: row.keywords,
      categories: row.categories,
      state: row.fo_state,
      is_national: row.is_national,
      sponsor: row.sponsor,
      eligibility_bullets: row.eligibility_bullets,
      application_url: row.application_url,
      source_url: row.source_url,
      requires_501c3: row.requires_501c3,
      requires_match: row.requires_match,
      is_loan: row.is_loan,
      deadline: row.deadline,
      deadline_type: row.deadline_type,
      is_active: row.is_active,
      record_origin: row.record_origin,
      amount_min: row.amount_min,
      amount_max: row.amount_max,
    }

    const decision = computeMatchDecision(profileData.profile, opp, { profileSections: profileData.sections })

    if (decision.decision === 'REJECT') {
      // Remove from pipeline — this opportunity is now hard-ineligible
      try {
        db.prepare('DELETE FROM grants WHERE id = ?').run(row.grant_id)
        console.log(`[seedOnStartup] Re-eval removed "${opp.title}" from profile ${row.profile_id}: ${(decision.ineligibilityReasons ?? []).join('; ')}`)
        removed++
      } catch { /* ignore */ }
    } else {
      // Update decision metadata and fingerprints
      try {
        const profileFingerprint = computeProfileFingerprint(normalizeProfile(profileData.profile, profileData.sections))
        const opportunityFingerprint = computeOpportunityFingerprint(normalizeOpportunity(opp))
        db.prepare(`
          UPDATE grants SET
            match_decision = ?,
            match_explanation = ?,
            eligibility_status = ?,
            ineligibility_reasons = ?,
            matched_needs = ?,
            match_confidence = ?,
            profile_fingerprint = ?,
            opportunity_fingerprint = ?,
            matcher_version = ?,
            evaluated_at = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          decision.decision,
          decision.explanation ?? null,
          String(decision.eligible),
          JSON.stringify(decision.ineligibilityReasons ?? []),
          JSON.stringify(decision.matchedNeeds ?? []),
          decision.confidence ?? null,
          profileFingerprint ?? null,
          opportunityFingerprint ?? null,
          decision.matcherVersion,
          decision.evaluatedAt,
          row.grant_id,
        )
        reEvaluated++
      } catch { /* ignore — old schema without all columns */ }
    }
  }

  console.log(`[seedOnStartup] Re-evaluation complete: ${reEvaluated} updated, ${removed} removed.`)
  return { reEvaluated, removed }
}

export default seedOnStartup;
