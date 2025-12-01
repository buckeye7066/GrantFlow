/**
 * Profile Matching Engine
 * - build a keyword map from profile (including extra_fields)
 * - score an opportunity using section scoring plus extra_fields low-weight boosts
 */

import { PROFILE_SECTIONS, SECTION_FIELDS, extractSectionData, getProfileKeys } from './crawlerFramework.js';

export function buildProfileKeywordMap(profile) {
  const sectionKeywords = {};
  for (const s of PROFILE_SECTIONS) {
    const data = extractSectionData(profile, s) || {};
    const keywords = [];
    for (const v of Object.values(data)) {
      if (!v) continue;
      if (Array.isArray(v)) keywords.push(...v.map(x => String(x)));
      else keywords.push(String(v));
    }
    sectionKeywords[s] = Array.from(new Set(keywords.map(x => x.toLowerCase())));
  }

  const profileKeys = getProfileKeys(profile);
  const knownTopLevel = new Set(Object.values(SECTION_FIELDS).flat().map(v => v.toLowerCase()));
  const extraFields = profileKeys.filter(k => !knownTopLevel.has(k.split('.')[0].toLowerCase()));
  const noiseBlacklist = new Set(['id','created_at','updated_at','timestamp','email','phone','ssn','ein','address','zipcode','zip','city','country','createdby','updatedby','metadata','meta']);
  const sanitizedExtraFields = extraFields.filter(f => !noiseBlacklist.has(f.split('.')[0].toLowerCase()));

  // Build a global keyword set derived from all profile values
  const globalText = Object.values(profile || {}).map(v => (typeof v === 'string' ? v : '')).join(' ').toLowerCase();
  const globalKeywords = new Set((globalText.match(/\b[a-zA-Z0-9_\-]{3,}\b/g) || []).map(x => x.toLowerCase()));

  return { sectionKeywords, globalKeywords: Array.from(globalKeywords), extraFields: sanitizedExtraFields };
}

export function scoreOpportunity(opp, profile, opts={}) {
  // opts: weights { sectionWeight:10, extraFieldWeight:1, globalKeywordBoost:1 }
  const weights = Object.assign({ sectionWeight: 10, extraFieldWeight: 1, globalKeywordBoost: 1 }, opts.weights || {});

  const { sectionKeywords, globalKeywords, extraFields } = buildProfileKeywordMap(profile);

  let baseScore = 50;
  const matchedSections = [];
  const reasons = [];

  const text = (opp.title||'') + ' ' + (opp.descriptionMd||'') + ' ' + (opp.sponsor||'');
  const lowerText = text.toLowerCase();

  // Section scoring
  for (const section of PROFILE_SECTIONS) {
    const keys = sectionKeywords[section] || [];
    let sectionScore = 0;
    const matched = [];
    for (const k of keys) {
      if (!k || k.length < 3) continue;
      if (lowerText.includes(k)) {
        sectionScore += weights.sectionWeight;
        matched.push(k);
        if (sectionScore >= 30) break;
      }
    }
    if (sectionScore > 0) {
      baseScore += sectionScore;
      matchedSections.push(section);
      reasons.push(`${section}: ${matched.slice(0,5).join(', ')}`);
    }
  }

  // Extra fields - low weight by default, but boost recall
  if (Array.isArray(extraFields) && extraFields.length) {
    let extraBoost = 0;
    for (const f of extraFields) {
      if (!f || f.length < 3) continue;
      if (lowerText.includes(f.toLowerCase())) {
        extraBoost += weights.extraFieldWeight;
      }
      if (extraBoost > 20) break; // cap extra boost
    }
    if (extraBoost > 0) {
      baseScore += extraBoost;
      reasons.push(`extra_fields: ${extraBoost} boosts`);
    }
  }

  // Global keywords boost (small weight per keyword)
  let globalBoost = 0;
  for (const kw of globalKeywords.slice(0, 250)) { // limit to avoid perf issues
    if (kw.length <= 3) continue;
    if (lowerText.includes(kw)) {
      globalBoost += weights.globalKeywordBoost;
      if (globalBoost > 30) break;
    }
  }
  if (globalBoost > 0) {
    baseScore += globalBoost;
    reasons.push(`global_keywords: ${globalBoost}`);
  }

  const score = Math.max(0, Math.min(100, Math.round(baseScore)));
  return { score, matchedSections, reasons };
}
