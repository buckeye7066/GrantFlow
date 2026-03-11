/**
 * profileSignals/index.js
 *
 * THE single canonical module for extracting profile signals.
 * Uses loadProfileContext (the unified pipeline) and adapts its output
 * to the shape crawlerManager / matchEngine expect.
 *
 * Every crawler MUST use this module; duplicate extraction logic is forbidden.
 */

import { loadProfileContext } from '../profileHelpers.js';

/**
 * Detect high-level intents from analyzed signals.
 * Used by strategy registry to select/weight data sources.
 */
function deriveIntents(analysis) {
  const intents = new Set();
  const occ = analysis.occupation || new Set();
  const needs = analysis.needs || new Set();
  const health = analysis.health || new Set();
  const military = analysis.military || new Set();
  const family = analysis.family || new Set();

  if (occ.has?.('small_business_owner')
    || occ.has?.('minority_owned_business')
    || occ.has?.('women_owned_business')
    || needs.has?.('business')
    || (analysis.keywords || []).some(k => /business|entrepreneur|startup|self.?employ|microenterprise/i.test(k))) {
    intents.add('business');
  }

  if (analysis.applicantType === 'student' || needs.has?.('scholarship') || needs.has?.('education')) {
    intents.add('education');
  }

  if (health.size > 0 || needs.has?.('healthcare') || needs.has?.('disability')) {
    intents.add('healthcare');
  }

  if (military.size > 0) {
    intents.add('military');
  }

  if (needs.has?.('housing') || family.has?.('homeless')) {
    intents.add('housing');
  }

  if (needs.has?.('employment') && !intents.has('business')) {
    intents.add('workforce');
  }

  if (needs.has?.('utilities') || needs.has?.('weatherization')) {
    intents.add('utilities');
  }

  if (needs.has?.('food')) {
    intents.add('food');
  }

  if (needs.has?.('childcare')) {
    intents.add('childcare');
  }

  if (needs.has?.('transportation')) {
    intents.add('transportation');
  }

  if (needs.has?.('internet')) {
    intents.add('broadband');
  }

  if (needs.has?.('legal')) {
    intents.add('legal');
  }

  if (health.has?.('disability') || health.has?.('physical_disability')
    || health.has?.('developmental_disability') || health.has?.('visual_impairment')
    || health.has?.('hearing_impairment') || needs.has?.('disability')) {
    intents.add('special_needs');
  }

  if (needs.has?.('mental_health') || health.has?.('mental_health')) {
    intents.add('mental_health');
  }

  if (needs.has?.('substance_recovery') || health.has?.('substance_recovery')) {
    intents.add('substance_recovery');
  }

  return intents;
}

/**
 * Extract government assistance programs the profile is currently enrolled in.
 */
function extractAssistancePrograms(sections) {
  const gov = sections.government_assistance || {};
  const comp = sections.comprehensive_application || {};
  const medAlt = sections.medical || {};
  const programs = [];

  if (gov.medicaid_enrolled || comp.medicaid_enrolled) programs.push('medicaid');
  if (gov.medicare_recipient || comp.medicare_recipient) programs.push('medicare');
  if (gov.ssi_recipient || comp.ssi_recipient) programs.push('ssi');
  if (gov.ssdi_recipient || comp.ssdi_recipient) programs.push('ssdi');
  if (gov.snap_recipient || comp.snap_recipient) programs.push('snap');
  if (gov.tanf_recipient || comp.tanf_recipient) programs.push('tanf');
  if (gov.section8_housing || comp.section8_housing) programs.push('section8');
  if (gov.liheap_recipient || comp.liheap_recipient) programs.push('liheap');
  if (gov.wic_recipient || comp.wic_recipient) programs.push('wic');
  if (gov.medicaid_waiver_program && gov.medicaid_waiver_program !== 'none') programs.push('medicaid_waiver');

  // Extract from alternate-schema medical.assistance_programs array
  if (Array.isArray(medAlt.assistance_programs)) {
    for (const prog of medAlt.assistance_programs) {
      const p = String(prog).toLowerCase().trim();
      if (p.includes('ssdi') && !programs.includes('ssdi')) programs.push('ssdi');
      if (p.includes('ssi') && !programs.includes('ssi')) programs.push('ssi');
      if (p.includes('medicaid') && !programs.includes('medicaid')) programs.push('medicaid');
      if (p.includes('medicare') && !programs.includes('medicare')) programs.push('medicare');
      if (p.includes('snap') && !programs.includes('snap')) programs.push('snap');
      if (p.includes('tanf') && !programs.includes('tanf')) programs.push('tanf');
      if (p.includes('liheap') && !programs.includes('liheap')) programs.push('liheap');
      if (p.includes('wic') && !programs.includes('wic')) programs.push('wic');
    }
  }

  return programs;
}

/**
 * Build a safe raw-inputs snapshot for debugging (no PII beyond what the profile already has).
 */
function buildRawInputs(profile, sections) {
  const sectionKeys = Object.keys(sections);
  const fieldCounts = {};
  for (const key of sectionKeys) {
    const data = sections[key];
    fieldCounts[key] = data && typeof data === 'object' ? Object.keys(data).length : 0;
  }

  return {
    profileId: profile.id,
    displayName: profile.display_name || profile.name || null,
    primaryType: profile.primary_type || null,
    tags: (() => {
      let t = profile.tags;
      if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = []; } }
      return Array.isArray(t) ? t : [];
    })(),
    sectionKeys,
    fieldCounts,
    hasNarrative: !!(sections.narrative?.barriers_faced || sections.narrative?.special_circumstances),
    hasComprehensiveApp: !!sections.comprehensive_application,
    hasUniversityApps: !!(sections.university_applications?.applications?.length),
  };
}

/**
 * Adapt loadProfileContext signals to the analysis shape crawlerManager expects.
 * This is the bridge that lets us use ONE extraction pipeline everywhere.
 */
function toAnalysisShape(profileContext) {
  const s = profileContext.signals || {}
  return {
    profileId: profileContext.profile_id || profileContext.profile?.id,
    profileName: profileContext.profile?.display_name || profileContext.profile?.name || null,
    location: s.location || {},
    applicantType: s.applicantType || 'individual',
    needs: s.needs || new Set(),
    demographics: s.demographics || new Set(),
    health: s.health || new Set(),
    family: s.family || new Set(),
    military: s.military || new Set(),
    occupation: s.occupation || new Set(),
    immigration: s.immigration || new Set(),
    geographic: s.geographic || new Set(),
    income: s.financial || {},
    education: s.education || {},
    interests: s.interests || new Set(),
    sports: s.sports || new Set(),
    schools: s.schools || [],
    organization: s.organization || {},
    keywords: s.keywords || [],
    keywordSet: s.keywordSet || new Set(),
    phrases: s.phrases || new Set(),
    intentPhrases: s.intentPhrases || new Set(),
    applicantTypes: s.applicantTypes || new Set(),
    assistance: s.assistance || new Set(),
    genders: s.genders || new Set(),
    academics: s.academics || {},
    proBonoTerms: s.proBonoTerms || new Set(),
    coverage: s.coverage || {},
    rawSections: s.rawSections || {},
  }
}

/**
 * Load ALL profile data and produce canonical signals.
 *
 * @param {Object} db - Database handle
 * @param {string} profileId
 * @returns {{ signals, intents, assistancePrograms, rawInputs }}
 */
export async function loadProfileSignals(db, profileId) {
  const profileContext = await loadProfileContext(db, profileId)
  const signals = toAnalysisShape(profileContext)
  const sections = profileContext.sections || {}
  const profile = profileContext.profile || {}

  const intents = deriveIntents(signals)
  const assistancePrograms = extractAssistancePrograms(sections)
  const rawInputs = buildRawInputs(profile, sections)

  return { signals, intents, assistancePrograms, rawInputs, profileContext }
}

export default { loadProfileSignals };
