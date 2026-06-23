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
  const ctx = await loadProfileContext(db, profileId);
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

export default { explainCrawlerPlanForProfile };
