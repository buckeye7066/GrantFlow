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
 * Normalize Set-like profile signals after JSON snapshot round-trip or legacy shapes.
 * Plain objects (e.g. { scholarship: true }) and arrays become a Set; null/undefined → empty Set.
 */
export function toSignalSet(value) {
  if (value == null) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) {
    return new Set(value.map((v) => String(v).trim()).filter(Boolean));
  }
  if (typeof value === 'object') {
    return new Set(
      Object.entries(value)
        .filter(([, v]) => v !== false && v != null && v !== '' && v !== 0)
        .map(([k]) => k),
    );
  }
  return new Set();
}

/**
 * Detect high-level intents from analyzed signals.
 * Used by strategy registry to select/weight data sources.
 */
function deriveIntents(analysis) {
  const intents = new Set();
  const occ = analysis.occupation instanceof Set ? analysis.occupation : new Set(Array.isArray(analysis.occupation) ? analysis.occupation : []);
  const needs = analysis.needs instanceof Set ? analysis.needs : new Set(Array.isArray(analysis.needs) ? analysis.needs : []);
  const health = analysis.health instanceof Set ? analysis.health : new Set(Array.isArray(analysis.health) ? analysis.health : []);
  const military = analysis.military instanceof Set ? analysis.military : new Set(Array.isArray(analysis.military) ? analysis.military : []);
  const family = analysis.family instanceof Set ? analysis.family : new Set(Array.isArray(analysis.family) ? analysis.family : []);

  if (occ.has('small_business_owner')
    || occ.has('minority_owned_business')
    || occ.has('women_owned_business')
    || needs.has('business')
    || (analysis.keywords || []).some(k => /business|entrepreneur|startup|self.?employ|microenterprise/i.test(k))) {
    intents.add('business');
  }

  if (analysis.applicantType === 'student' || needs.has('scholarship') || needs.has('education')) {
    intents.add('education');
  }

  if (health.size > 0 || needs.has('healthcare') || needs.has('disability')) {
    intents.add('healthcare');
  }

  if (military.size > 0) {
    intents.add('military');
  }

  if (needs.has('housing') || family.has('homeless')) {
    intents.add('housing');
  }

  if (needs.has('employment') && !intents.has('business')) {
    intents.add('workforce');
  }

  if (needs.has('utilities') || needs.has('weatherization')) {
    intents.add('utilities');
  }

  if (needs.has('food')) {
    intents.add('food');
  }

  if (needs.has('childcare')) {
    intents.add('childcare');
  }

  if (needs.has('transportation')) {
    intents.add('transportation');
  }

  if (needs.has('internet')) {
    intents.add('broadband');
  }

  if (needs.has('legal')) {
    intents.add('legal');
  }

  if (health.has('disability') || health.has('physical_disability')
    || health.has('developmental_disability') || health.has('visual_impairment')
    || health.has('hearing_impairment') || needs.has('disability')) {
    intents.add('special_needs');
  }

  if (needs.has('mental_health') || health.has('mental_health')) {
    intents.add('mental_health');
  }

  if (needs.has('substance_recovery') || health.has('substance_recovery')) {
    intents.add('substance_recovery');
  }

  // Church / faith-based organization
  const orgType = (analysis.organization?.type || '').toLowerCase()
  const primaryType = (analysis.applicantType || '').toLowerCase()
  if (primaryType === 'church' || primaryType === 'ministry' || primaryType === 'faith_based' ||
      orgType.includes('church') || orgType.includes('faith') || orgType.includes('ministry') ||
      (analysis.keywords || []).some(k => /church|parish|congregation|ministry|faith.?based|dioces|synagogue|mosque|temple/i.test(k))) {
    intents.add('faith_based');
    intents.add('church');
  }

  // K-12 school / education institution
  if (primaryType === 'school' || primaryType === 'k12' || primaryType === 'charter_school' ||
      orgType.includes('school') || orgType.includes('district') ||
      (analysis.keywords || []).some(k => /\bschool\b|k.?12|charter|elementary|middle school|high school|classroom|educator|teacher/i.test(k))) {
    intents.add('school');
    intents.add('education');
  }

  // Family / household context
  const familySet = analysis.family instanceof Set ? analysis.family : new Set(Array.isArray(analysis.family) ? analysis.family : [])
  if (primaryType === 'family' ||
      familySet.has('has_children') || familySet.has('single_parent') || familySet.has('foster_parent') ||
      familySet.has('expectant_parent') || familySet.has('kinship_caregiver') ||
      needs.has('childcare') || needs.has('family_support')) {
    intents.add('family');
  }

  // Nonprofit organization (general)
  if (primaryType === 'nonprofit' || primaryType === 'nonprofit_org' ||
      orgType.includes('nonprofit') || orgType.includes('501c3') ||
      (analysis.keywords || []).some(k => /nonprofit|non.?profit|501.?c.?3|charitable organization/i.test(k))) {
    intents.add('nonprofit');
  }

  // Volunteer fire department / EMS
  if (primaryType === 'volunteer_fire' || primaryType === 'vfd' ||
      orgType.includes('fire') || orgType.includes('ems') || orgType.includes('rescue') ||
      (analysis.keywords || []).some(k => /volunteer fire|vfd|fire department|ems|rescue squad|fire company/i.test(k))) {
    intents.add('volunteer_fire');
    intents.add('emergency_services');
  }

  if (needs.has('certification_assistance') || needs.has('cpr_first_aid_training') ||
      (analysis.keywords || []).some(k =>
        /cpr|first\s*aid|aed|bls|heartsaver|instructor\s*cert|safety\s*train|certification\s*class/i.test(k))) {
    intents.add('community_health_training');
    intents.add('certification_assistance');
    intents.add('education');
    intents.add('employment');
  }

  if (needs.has('license_reinstatement_support') || needs.has('professional_remediation_funding') ||
      needs.has('nursing_reentry_support') ||
      (analysis.keywords || []).some(k =>
        /probe|reinstatement|remediation|ethics\s*class|ethics\s*course|board.?required|return\s*to\s*practice|relicens|recertif|nurse\s*re.?entry|license\s*back|professional\s*boundar/i.test(k))) {
    intents.add('license_reinstatement');
    intents.add('healthcare');
    intents.add('workforce');
    intents.add('education');
    intents.add('employment');
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
    needs: toSignalSet(s.needs),
    demographics: toSignalSet(s.demographics),
    health: toSignalSet(s.health),
    family: toSignalSet(s.family),
    military: toSignalSet(s.military),
    occupation: toSignalSet(s.occupation),
    immigration: toSignalSet(s.immigration),
    geographic: toSignalSet(s.geographic),
    emergency: toSignalSet(s.emergency),
    income: s.financial || {},
    education: s.education || {},
    interests: toSignalSet(s.interests),
    sports: toSignalSet(s.sports),
    schools: s.schools || [],
    organization: s.organization || {},
    keywords: s.keywords || [],
    keywordSet: toSignalSet(s.keywordSet),
    phrases: toSignalSet(s.phrases),
    intentPhrases: toSignalSet(s.intentPhrases),
    applicantTypes: toSignalSet(s.applicantTypes),
    assistance: toSignalSet(s.assistance),
    genders: toSignalSet(s.genders),
    academics: s.academics || {},
    proBonoTerms: toSignalSet(s.proBonoTerms),
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

  let intents;
  try {
    intents = deriveIntents(signals);
  } catch (err) {
    console.error(`[profileSignals] deriveIntents failed for profile ${profileId}:`, err);
    intents = new Set();
  }

  let assistancePrograms;
  try {
    assistancePrograms = extractAssistancePrograms(sections);
  } catch (err) {
    console.error(`[profileSignals] extractAssistancePrograms failed for profile ${profileId}:`, err);
    assistancePrograms = [];
  }

  let rawInputs;
  try {
    rawInputs = buildRawInputs(profile, sections);
  } catch (err) {
    console.error(`[profileSignals] buildRawInputs failed for profile ${profileId}:`, err);
    rawInputs = { profileId, error: err.message };
  }

  console.info(`[profileSignals] profile=${profileId} intents=[${[...intents].join(',')}] programs=[${assistancePrograms.join(',')}]`);

  return { signals, intents, assistancePrograms, rawInputs, profileContext }
}

/**
 * Build canonical signals from an already-loaded profile context (e.g. a snapshot).
 * Prevents live DB re-queries and cross-profile contamination when the caller already
 * holds the correct context.
 *
 * @param {Object} profileContext - Result of buildProfileContext / loadProfileContext
 * @returns {{ signals, intents, assistancePrograms, rawInputs, profileContext }}
 */
export function buildSignalsFromContext(profileContext) {
  const signals = toAnalysisShape(profileContext)
  const sections = profileContext.sections || {}
  const profile = profileContext.profile || {}
  const profileId = profileContext.profile_id || profile.id || 'unknown';

  let intents;
  try {
    intents = deriveIntents(signals);
  } catch (err) {
    console.error(`[profileSignals] buildSignalsFromContext deriveIntents failed for profile ${profileId}:`, err);
    intents = new Set();
  }

  let assistancePrograms;
  try {
    assistancePrograms = extractAssistancePrograms(sections);
  } catch (err) {
    console.error(`[profileSignals] buildSignalsFromContext extractAssistancePrograms failed for profile ${profileId}:`, err);
    assistancePrograms = [];
  }

  let rawInputs;
  try {
    rawInputs = buildRawInputs(profile, sections);
  } catch (err) {
    console.error(`[profileSignals] buildSignalsFromContext buildRawInputs failed for profile ${profileId}:`, err);
    rawInputs = { profileId, error: err.message };
  }

  return { signals, intents, assistancePrograms, rawInputs, profileContext }
}

export default { loadProfileSignals, buildSignalsFromContext, toSignalSet };
