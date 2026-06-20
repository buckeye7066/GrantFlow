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
import { createLogger } from '../../utils/logger.js'
const log = createLogger('index')

/**
 * Normalize Set-like profile signals after JSON snapshot round-trip or legacy shapes.
 * Plain objects (e.g. { scholarship: true }) and arrays become a Set; null/undefined → empty Set.
 */
export function toSignalSet(value) {
  if ((value === null || value === undefined)) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) {
    return new Set(value.map((v) => String(v).trim()).filter(Boolean));
  }
  if (typeof value === 'object') {
    return new Set(
      Object.entries(value)
        .filter(([, v]) => v !== false && (v !== null && v !== undefined) && v !== '' && v !== 0)
        .map(([k]) => k),
    );
  }
  return new Set();
}

/**
 * Build the deduped, primary-first list of US states across ALL of a profile's
 * addresses. Prefers the `states` array emitted by buildProfileSignals (primary +
 * secondary), but always falls back to the primary `location.state` so older snapshots
 * (taken before multi-address support) still expose at least their single state.
 *
 * @param {unknown} states - signals.states (string[] of 2-letter codes), may be absent
 * @param {object} primaryLocation - signals.location
 * @returns {string[]} deduped uppercase 2-letter state codes, primary first
 */
function dedupeStates(states, primaryLocation) {
  const out = []
  const add = (v) => {
    if ((v === null || v === undefined)) return
    const st = String(v).trim().toUpperCase()
    if (st && !out.includes(st)) out.push(st)
  }
  // Primary first (back-compat with snapshots that predate `states`).
  if (primaryLocation && primaryLocation.state) add(primaryLocation.state)
  if (Array.isArray(states)) {
    for (const st of states) add(st)
  }
  return out
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

  // ---------------------------------------------------------------------
  // Local government / county / municipal / public agency (Phase 4)
  // ---------------------------------------------------------------------
  const KW = analysis.keywords || []
  const kwHit = (re) => KW.some((k) => re.test(String(k)))
  if (primaryType === 'county_government' || primaryType === 'county_official' ||
      primaryType === 'county' || orgType.includes('county') ||
      kwHit(/\bcounty\s+(government|official|administration|commission|exec|mayor|department)\b/i)) {
    intents.add('local_government');
    intents.add('county_government');
    intents.add('public_safety');
    intents.add('infrastructure');
    intents.add('emergency_management');
  }
  if (primaryType === 'municipality' || primaryType === 'city' ||
      primaryType === 'town' || primaryType === 'township' || primaryType === 'village' ||
      orgType.includes('municipal') || orgType.includes('city of') || orgType.includes('town of') ||
      kwHit(/\b(city|town|village|township|borough)\s+(government|hall|administration|of\s+\w+)/i)) {
    intents.add('local_government');
    intents.add('municipality');
    intents.add('infrastructure');
    intents.add('parks_recreation');
    intents.add('community_facilities');
  }
  if (primaryType === 'local_government' || primaryType === 'public_agency' ||
      primaryType === 'special_district' || orgType.includes('public agency') ||
      orgType.includes('government agency')) {
    intents.add('local_government');
    intents.add('public_agency');
  }
  if (primaryType === 'regional_planning_agency' || primaryType === 'mpo' ||
      primaryType === 'cog' || orgType.includes('planning organization') ||
      orgType.includes('council of governments')) {
    intents.add('local_government');
    intents.add('regional_planning');
    intents.add('infrastructure');
    intents.add('roads_transportation');
    intents.add('economic_development');
  }
  if (primaryType === 'economic_development_agency' || orgType.includes('economic development')) {
    intents.add('economic_development');
    intents.add('infrastructure');
  }

  // Tribal government — explicit (not just any "tribal" keyword)
  if (primaryType === 'tribal_government' || primaryType === 'tribe' ||
      primaryType === 'tribal_nation' || primaryType === 'indian_tribe' ||
      orgType.includes('tribal') || orgType.includes('tribe') ||
      kwHit(/\b(tribal\s+(government|nation|council)|indian\s+tribe|native\s+american\s+(tribe|nation|government))\b/i)) {
    intents.add('tribal_government');
    intents.add('tribal');
    intents.add('community_facilities');
  }

  // ---------------------------------------------------------------------
  // Teacher / classroom / school department (Phase 4)
  // ---------------------------------------------------------------------
  if (primaryType === 'teacher' || primaryType === 'classroom_teacher' ||
      primaryType === 'educator' || (occ && occ.has && occ.has('teacher')) ||
      kwHit(/\b(classroom\s+teacher|public.?school\s+teacher|k.?12\s+teacher|grade\s+\d|elementary\s+teacher|middle\s+school\s+teacher|high\s+school\s+teacher|stem\s+teacher|art\s+teacher|music\s+teacher|special\s+education\s+teacher)\b/i)) {
    intents.add('teacher');
    intents.add('classroom');
    intents.add('education');
    intents.add('classroom_supplies');
    intents.add('professional_development');
  }
  if (primaryType === 'school_district' || primaryType === 'lea' ||
      orgType.includes('school district') || orgType.includes('local education agency')) {
    intents.add('school');
    intents.add('school_district');
    intents.add('education');
  }
  if (primaryType === 'public_school' || orgType.includes('public school') ||
      kwHit(/\bpublic\s+(elementary|middle|high)\s+school\b/i)) {
    intents.add('school');
    intents.add('public_school');
    intents.add('education');
  }
  if (primaryType === 'special_education_program' || (needs && needs.has && needs.has('special_education')) ||
      kwHit(/\bspecial\s+education|sped|idea\s+(part\s+b|part\s+c)\b/i)) {
    intents.add('special_education');
  }
  if (primaryType === 'school_food_service' || orgType.includes('food service') ||
      kwHit(/\bschool\s+(food\s+service|nutrition|lunch\s+program)\b/i)) {
    intents.add('school_nutrition');
    intents.add('food');
  }
  if (primaryType === 'school_transportation' || orgType.includes('school bus') ||
      kwHit(/\b(school\s+bus|student\s+transportation|school\s+transportation)\b/i)) {
    intents.add('school_transportation');
    intents.add('roads_transportation');
  }
  if (primaryType === 'pta_pto' || primaryType === 'pta' || primaryType === 'pto' ||
      orgType.includes('pta') || orgType.includes('pto') ||
      orgType.includes('parent teacher')) {
    intents.add('teacher');
    intents.add('classroom');
    intents.add('education');
  }

  // ---------------------------------------------------------------------
  // Public institutions (Phase 4)
  // ---------------------------------------------------------------------
  if (primaryType === 'library' || primaryType === 'public_library' ||
      primaryType === 'library_media_center' || orgType.includes('library')) {
    intents.add('library');
    intents.add('library_media');
    intents.add('community_facilities');
    intents.add('education');
  }
  if (primaryType === 'museum' || orgType.includes('museum') ||
      orgType.includes('historical society')) {
    intents.add('museum');
    intents.add('arts_education');
    intents.add('community_facilities');
  }
  if (primaryType === 'parks_department' || orgType.includes('parks') ||
      orgType.includes('recreation department') ||
      kwHit(/\bparks?\s+(and|&)\s+(recreation|rec)\b/i)) {
    intents.add('parks_recreation');
    intents.add('community_facilities');
  }
  if (primaryType === 'community_center' || orgType.includes('community center') ||
      orgType.includes('neighborhood center') || orgType.includes('civic center')) {
    intents.add('community_facilities');
    intents.add('community');
  }
  if (primaryType === 'public_health_department' || primaryType === 'health_department' ||
      primaryType === 'doh' || primaryType === 'county_health_department' ||
      orgType.includes('health department') || orgType.includes('public health')) {
    intents.add('public_health');
    intents.add('health');
    intents.add('community');
    intents.add('public_agency');
  }
  if (primaryType === 'local_housing_authority' || primaryType === 'housing_authority' ||
      orgType.includes('housing authority')) {
    intents.add('housing');
    intents.add('housing_development');
    intents.add('public_agency');
  }

  // ---------------------------------------------------------------------
  // Specialized nonprofit verticals (Phase 4)
  // ---------------------------------------------------------------------
  if (primaryType === 'animal_rescue' || primaryType === 'animal_shelter' ||
      primaryType === 'animal_welfare' || primaryType === 'humane_society' ||
      orgType.includes('animal') || orgType.includes('humane society') ||
      kwHit(/\b(animal\s+(rescue|shelter|welfare)|humane\s+society|spay\s*\/?\s*neuter)\b/i)) {
    intents.add('animal_welfare');
    intents.add('nonprofit');
  }
  if (primaryType === 'food_pantry' || primaryType === 'food_bank' ||
      primaryType === 'food_shelf' || primaryType === 'soup_kitchen' ||
      orgType.includes('food pantry') || orgType.includes('food bank') ||
      orgType.includes('soup kitchen') ||
      kwHit(/\b(food\s+(pantry|bank|shelf)|soup\s+kitchen|hunger\s+relief)\b/i)) {
    intents.add('food');
    intents.add('community');
    intents.add('nonprofit');
  }
  if (primaryType === 'homeless_shelter' || primaryType === 'shelter' ||
      primaryType === 'transitional_housing' || orgType.includes('shelter') ||
      orgType.includes('transitional housing') ||
      kwHit(/\b(homeless\s+(shelter|services)|transitional\s+housing|emergency\s+shelter)\b/i)) {
    intents.add('housing');
    intents.add('homeless');
    intents.add('community');
    intents.add('nonprofit');
  }
  if (primaryType === 'domestic_violence_shelter' || primaryType === 'dv_shelter' ||
      orgType.includes('domestic violence') ||
      kwHit(/\b(domestic\s+violence|family\s+violence|dv\s+shelter|intimate\s+partner)\b/i)) {
    intents.add('housing');
    intents.add('mental_health');
    intents.add('public_safety');
    intents.add('nonprofit');
  }
  if (primaryType === 'reentry_program' || primaryType === 'second_chance_program' ||
      orgType.includes('reentry') || orgType.includes('second chance') ||
      kwHit(/\b(re.?entry|reintegration|second\s+chance|justice.?involved|formerly\s+incarcerated)\b/i)) {
    intents.add('workforce');
    intents.add('employment');
    intents.add('housing');
    intents.add('nonprofit');
  }
  if (primaryType === 'substance_recovery_org' || primaryType === 'recovery_program' ||
      orgType.includes('recovery') || orgType.includes('substance') ||
      kwHit(/\b(substance\s+(use|abuse|recovery)|sud\s+treatment|addiction\s+(recovery|treatment))\b/i)) {
    intents.add('substance_recovery');
    intents.add('mental_health');
    intents.add('health');
    intents.add('nonprofit');
  }
  if (primaryType === 'mental_health_nonprofit' || primaryType === 'behavioral_health_nonprofit' ||
      orgType.includes('mental health') || orgType.includes('behavioral health')) {
    intents.add('mental_health');
    intents.add('health');
    intents.add('nonprofit');
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
  const applicantTypes = toSignalSet(s.applicantTypes)
  // Was the applicant type DETERMINED from a real profile signal, or did it
  // fall back to the generic 'individual' default? buildProfileSignals() returns
  // applicantType='individual' both for an explicitly-individual person AND for a
  // profile that simply never declared a type. The matcher must treat the latter
  // as NEUTRAL (canonical rule G4: "missing profile fields must not disqualify").
  // The type is "explicit" when EITHER the resolved type is something other than
  // the bare default, OR the raw applicantTypes set carried a concrete value.
  const resolvedApplicantType = s.applicantType || 'individual'
  const applicantTypeExplicit =
    resolvedApplicantType !== 'individual' || applicantTypes.size > 0
  return {
    profileId: profileContext.profile_id || profileContext.profile?.id,
    profileName: profileContext.profile?.display_name || profileContext.profile?.name || null,
    location: s.location || {},
    // Multi-location signals (primary + optional secondary address). `location` remains
    // the primary for back-compat; `states` is the deduped, primary-first list of every
    // state across all of the profile's addresses, and `locations` carries each resolved
    // address ({ zip, state, city, county, type? }). Geo-gating + local crawlers should
    // read `states`/`locations` so an out-of-state student (home OH + school TN) is
    // covered in both states, not just the primary.
    states: dedupeStates(s.states, s.location),
    locations: Array.isArray(s.locations) && s.locations.length
      ? s.locations
      : (s.location && (s.location.state || s.location.zip || s.location.city) ? [s.location] : []),
    secondaryLocation: s.secondaryLocation || null,
    applicantType: resolvedApplicantType,
    applicantTypeExplicit,
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
    applicantTypes,
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

  log.info(`[profileSignals] profile=${profileId} intents=[${[...intents].join(',')}] programs=[${assistancePrograms.join(',')}]`);

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
