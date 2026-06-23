// crawlerPlanService.js
//
// DB-bound wrapper around the pure crawler-os plan explainer. Lives OUTSIDE
// backend/crawler-os/ so the OS stays self-contained (the OS never imports app
// services). Loads a live profile, maps it to the crawler-os thesis input, and
// returns the explainable "which crawlers fire and why" plan.
//
// Used by Anya's `crawlers.planForProfile` tool so the operator can confirm
// coverage per profile — e.g. that a volunteer fire department reaches FEMA AFG.

import { explainCrawlerPlan } from '../crawler-os/crawlerPlanExplainer.js';
import { loadProfileContext } from './profileHelpers.js';
import { profileContextToThesisInput } from './crawlerOsPersistence.js';

/**
 * @param {object} db
 * @param {string} profileId
 * @returns {Promise<object>} explainCrawlerPlan(...) result + profile meta
 */
export async function explainCrawlerPlanForProfile(db, profileId) {
  if (!db || !profileId) throw new Error('explainCrawlerPlanForProfile: db and profileId required');
  let ctx;
  try {
    ctx = await loadProfileContext(db, profileId);
  } catch (err) {
    // loadProfileContext THROWS for an unknown id (it does not return null).
    // Treat that as a clean not-found so callers (the admin route, the Sam
    // coverage audit) return 404 / skip the row instead of a 500.
    if (/not found|no such|does not exist/i.test(String(err?.message || ''))) {
      return { profile_id: profileId, error: 'profile_not_found', selected_sources: [], excluded_sources: [] };
    }
    throw err;
  }
  if (!ctx?.profile) {
    return { profile_id: profileId, error: 'profile_not_found', selected_sources: [], excluded_sources: [] };
  }
  const thesisInput = profileContextToThesisInput(ctx);
  const plan = explainCrawlerPlan(thesisInput);
  return {
    ...plan,
    profile_id: profileId,
    display_name: ctx.profile.display_name ?? ctx.profile.name ?? null,
    primary_type: ctx.profile.primary_type ?? ctx.profile.applicant_type ?? null,
  };
}

/**
 * auditCrawlerCoverage — run the plan explainer across active profiles and
 * surface coverage gaps (mission: never zero; orgs must reach real funders).
 * Used by the Admin "Crawler Plan" panel (Scan all) and Sam's coverage check.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.limit=200]
 * @returns {Promise<{
 *   generated_at: string,
 *   total_profiles: number,
 *   scanned: number,
 *   zero_coverage: Array<object>,
 *   org_directory_only: Array<object>,
 *   healthy: number,
 *   profiles: Array<{profile_id, display_name, primary_type, applicant_types, is_org, selected_source_ids, funder_source_ids, directory_only, zero, keyword_triggers}>,
 * }>}
 */
export async function auditCrawlerCoverage(db, { limit = 200 } = {}) {
  if (!db) throw new Error('auditCrawlerCoverage: db required');
  const isPg = db?.dialect === 'postgres';
  let rows = [];
  try {
    rows = await db
      .prepare(
        `SELECT id, display_name, primary_type FROM profiles
          WHERE status = 'active' OR status IS NULL
          ORDER BY created_at DESC ${isPg ? 'LIMIT $1' : 'LIMIT ?'}`,
      )
      .all(limit);
  } catch {
    rows = [];
  }

  const out = {
    generated_at: new Date().toISOString(),
    total_profiles: Array.isArray(rows) ? rows.length : 0,
    scanned: 0,
    zero_coverage: [],
    org_directory_only: [],
    healthy: 0,
    profiles: [],
  };

  for (const r of rows || []) {
    let plan;
    try {
      plan = await explainCrawlerPlanForProfile(db, r.id);
    } catch {
      continue;
    }
    if (plan?.error) continue;
    out.scanned += 1;
    const entry = {
      profile_id: r.id,
      display_name: r.display_name ?? null,
      primary_type: r.primary_type ?? null,
      applicant_types: plan.applicant_types,
      is_org: plan.is_org,
      selected_source_ids: (plan.selected_sources || []).map((s) => s.source_id),
      funder_source_ids: plan.funder_source_ids || [],
      directory_only: Boolean(plan.coverage?.directory_only),
      zero: Boolean(plan.coverage?.zero),
      keyword_triggers: plan.keyword_triggers || [],
    };
    out.profiles.push(entry);
    if (entry.zero) {
      out.zero_coverage.push(entry);
    } else if (entry.directory_only && entry.is_org) {
      // Directory-only is EXPECTED for individuals; a RED FLAG for an org.
      out.org_directory_only.push(entry);
    } else {
      out.healthy += 1;
    }
  }
  return out;
}

export default { explainCrawlerPlanForProfile, auditCrawlerCoverage };
