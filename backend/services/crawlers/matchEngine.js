import { toSignalSet } from '../profileSignals/index.js';
import { normalizeState, statesMatch } from '../../utils/stateNormalization.js';
import { createLogger } from '../../utils/logger.js'
const log = createLogger('matchEngine')

/**
 * profileStates(analysis) — ALL of a profile's states, deduped, primary-first.
 *
 * STRICTLY ADDITIVE: reads `analysis.states` (primary-first list from
 * buildProfileSignals) when present, else falls back to `analysis.location.state`
 * so single-address profiles / older snapshots return exactly their one state.
 * Returns normalized 2-letter codes; empty array when none is known (NEUTRAL).
 *
 * @param {object|null} analysis - crawler analysis shape
 * @returns {string[]} normalized state codes, primary first, deduped
 */
function profileStates(analysis) {
  const out = []
  const add = (v) => {
    const norm = normalizeState(v)
    if (norm && !out.includes(norm)) out.push(norm)
  }
  const primary = analysis?.location?.state ?? null
  if (primary) add(primary)
  if (Array.isArray(analysis?.states)) {
    for (const st of analysis.states) add(st)
  }
  return out
}

/**
 * crawlers/matchEngine.js — CANDIDATE PREFILTER (NOT the match authority).
 *
 * Mission rule: `computeMatchDecision()` from
 * `backend/services/matchEngine.js` is the SOLE final scoring/decision
 * authority for every user-facing result. This file produces a coarse
 * "candidate prefilter" ranking that the crawler dispatcher uses to:
 *
 *   - decide which programs to keep in a strategy run
 *   - sort retrieval batches before insertion
 *   - drop obvious junk (informational pages, duplicates, intent mismatches)
 *
 * Its scores MUST NOT be persisted as the final match score for a user.
 * Pipeline insertion (`saveToProfilePipeline`) re-runs `computeMatchDecision`
 * and overwrites any score it sees.
 *
 * Importers/readers: do not promote `score`/`matchScore` from this engine
 * into a saved grant or a displayed result. Use it only for retrieval-time
 * ranking and dedupe.
 *
 * v4 — Improvements over v3:
 *   - State normalization: "TN" / "Tennessee" / "tn" all match correctly
 *   - Reduced state mismatch penalty from -30 to -15 to prevent over-filtering
 *   - Minimum score floor: partial matches always score >= 5 (never zero-out)
 *   - Geographic expansion: profiles with sparse results still surface relevant matches
 *
 * v3 — Improvements:
 *   - Intent alignment scoring (business profile → business grants score high)
 *   - Informational page filtering (CDC topics, MedlinePlus, Medicaid dirs)
 *   - URL + name-based deduplication
 *   - Negative matching for irrelevant health/demographic categories
 *   - Hard gate: requiresMedicalCondition excludes profiles with no health signals
 *   - Copay/patient-assistance programs excluded when no chronic conditions
 *   - Business-intent profiles get non-business programs deprioritised
 */

// ── Intent alignment: maps profile signals to "intent" buckets ──

function detectProfileIntents(analysis) {
    const intents = new Set();
    const occ = toSignalSet(analysis.occupation);
    const needs = toSignalSet(analysis.needs);
    const health = toSignalSet(analysis.health);
    const military = toSignalSet(analysis.military);
    const family = toSignalSet(analysis.family);

  if (occ.has?.('small_business_owner') ||
            occ.has?.('minority_owned_business') ||
            occ.has?.('women_owned_business') ||
            (analysis.keywords || []).some(k =>
                      /business|entrepreneur|startup|self.?employ|microenterprise|food\s*truck|mobile\s*food/i.test(k))) {
        intents.add('business');
        intents.add('entrepreneurship');
        intents.add('self_employment');
  }

  if (analysis.applicantType === 'student' ||
            needs.has?.('scholarship') ||
            needs.has?.('education')) {
        intents.add('education');
  }

  if (health.size > 0 || needs.has?.('disability') || needs.has?.('healthcare')) {
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

  if (health.has?.('disability') || health.has?.('physical_disability')
    || health.has?.('developmental_disability') || needs.has?.('disability')) {
        intents.add('special_needs');
  }

  if (needs.has?.('utilities')) intents.add('utilities');
  if (needs.has?.('food')) intents.add('food');
  if (needs.has?.('childcare')) intents.add('childcare');
  if (needs.has?.('transportation')) intents.add('transportation');
  if (needs.has?.('mental_health') || health.has?.('mental_health')) intents.add('mental_health');
  if (needs.has?.('substance_recovery') || health.has?.('substance_recovery')) intents.add('substance_recovery');

  if (needs.has?.('certification_assistance') || needs.has?.('cpr_first_aid_training') ||
      (analysis.keywords || []).some(k =>
        /cpr|first\s*aid|aed|bls|heartsaver|instructor\s*cert|safety\s*train|certification\s*class/i.test(k))) {
    intents.add('community_health_training');
    intents.add('certification_assistance');
    intents.add('education');
    intents.add('employment');
  }

  if (needs.has?.('license_reinstatement_support') || needs.has?.('professional_remediation_funding') ||
      needs.has?.('nursing_reentry_support') ||
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

function computeIntentBonus(program, intents) {
    const progIntents = program.intentMatch || [];
    if (progIntents.length === 0 || intents.size === 0) return 0;

  let hits = 0;
    for (const pi of progIntents) {
          if (intents.has(pi)) hits++;
    }
    if (hits === 0) return 0;

  // Strong bonus: 15 pts for first hit, 5 for each additional (cap 25)
  return Math.min(25, 15 + (hits - 1) * 5);
}

// ── Negative matching: penalize clearly irrelevant programs ──

const NEGATIVE_RULES = [
  { healthRequired: 'visual_impairment', penalty: -100, label: 'visual impairment program but no vision issues' },
  { healthRequired: 'hearing_impairment', penalty: -100, label: 'hearing impairment program but no hearing issues' },
  { healthRequired: 'kidney_disease', penalty: -100, label: 'kidney disease program but no kidney condition' },
  { healthRequired: 'cancer', penalty: -100, label: 'cancer program but no cancer diagnosis' },
  { healthRequired: 'hiv_aids', penalty: -100, label: 'HIV/AIDS program but no HIV/AIDS' },
  { healthRequired: 'tbi', penalty: -100, label: 'TBI program but no TBI diagnosis' },
  { healthRequired: 'substance_recovery', penalty: -100, label: 'substance recovery but no substance issue' },
  { healthRequired: 'developmental_disability', penalty: -100, label: 'developmental disability program but no I/DD' },
  ];

function computeNegativePenalty(program, analysis) {
    if (!program.healthMatch || program.healthMatch.length === 0) return 0;
    if (!program.eligibility) return 0;

  const reqKeys = Object.keys(program.eligibility).filter(k => k.startsWith('requires'));
    if (reqKeys.length === 0) return 0;

  for (const rule of NEGATIVE_RULES) {
        const eligKey = `requires${rule.healthRequired.charAt(0).toUpperCase() + rule.healthRequired.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`;
        if (program.eligibility[eligKey] && !(analysis.health?.has(rule.healthRequired))) {
                return rule.penalty;
        }
  }
    return 0;
}

function getNegativeGateReason(program, analysis) {
  if (!program?.eligibility) return null;
  const healthSignals = analysis?.health;
  for (const rule of NEGATIVE_RULES) {
    const eligKey = `requires${rule.healthRequired.charAt(0).toUpperCase()}${rule.healthRequired
      .slice(1)
      .replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`;
    if (program.eligibility[eligKey] && !(healthSignals?.has?.(rule.healthRequired))) {
      return rule.label;
    }
  }
  return null;
}

// ── Informational page filter ──

const INFORMATIONAL_DOMAINS = [
    'cdc.gov/topics',
    'cdc.gov/ncbddd',
    'cdc.gov/genomics',
    'medlineplus.gov',
    'mayoclinic.org',
    'webmd.com',
    'healthline.com',
    'wikipedia.org',
    'nih.gov/health',
    'niddk.nih.gov',
    'ninds.nih.gov',
    'nei.nih.gov',
  ];

const INFORMATIONAL_PATTERNS = [
    /medicaid.*contact.*director/i,
    /medicaid.*office.*list/i,
    /state\s+medicaid\s+programs?\s*$/i,
    /about\s+this\s+condition/i,
    /symptoms?\s+(and|&)\s+causes?/i,
    /what\s+is\s+[a-z]+\s+disease/i,
    /patient\s+education/i,
    /health\s+topic/i,
    /disease\s+fact\s*sheet/i,
  ];

function isInformationalOnly(program) {
    const url = (program.url || '').toLowerCase();
    const name = (program.name || '').toLowerCase();
    const desc = (program.description || '').toLowerCase();

  if (INFORMATIONAL_DOMAINS.some(d => url.includes(d))) return true;
    if (INFORMATIONAL_PATTERNS.some(p => p.test(name) || p.test(desc))) return true;

  // Generic info pages that aren't funding
  if (url.includes('/topics/') && !url.includes('grant') && !url.includes('fund') && !url.includes('apply')) return true;

  return false;
}

/**
 * v3: Hard-gate copay/patient-assistance programs when profile has no matching
 * chronic conditions. These programs (PAN Foundation, HealthWell, NeedyMeds,
 * Patient Advocate Foundation) require diagnosed medical conditions.
 */
function isCopayOrPatientAssistanceIrrelevant(program, analysis) {
    const name = (program.name || '').toLowerCase();
    const desc = (program.description || '').toLowerCase();
    const combined = name + ' ' + desc;

  const copayIndicators = [
        'copay', 'co-pay', 'copayment',
        'patient assistance program',
        'patient advocate',
        'premium assistance',
        'out-of-pocket',
      ];
    const isCopayProgram = copayIndicators.some(t => combined.includes(t));

  if (!isCopayProgram) return false;

  // If the program requires a medical condition AND profile has no health signals → exclude
  if (program.eligibility?.requiresMedicalCondition && (analysis.health?.size ?? 0) === 0) {
        return true;
  }

  // If the program has healthMatch tags and NONE match the profile → exclude
  if (program.healthMatch && program.healthMatch.length > 0) {
        const healthHits = program.healthMatch.filter(h => analysis.health.has(h));
        if (healthHits.length === 0) return true;
  }

  return false;
}

// ── Loan / matching-fund exclusion ──

function isExcluded(program) {
    const name = (program.name || '').toLowerCase();
    const desc = (program.description || '').toLowerCase();
    const combined = name + ' ' + desc;

  const excludeTerms = [
        'loan', 'repay', 'interest rate', 'matching fund', 'match required',
        'cost-share', 'cost share', 'co-investment', 'equity investment',
        'organizational only', 'institutions only',
      ];

  const exemptTerms = ['loan forgiveness', 'loan repayment assistance', 'loan repayment program'];
    if (exemptTerms.some(t => combined.includes(t))) return false;

  return excludeTerms.some(term => combined.includes(term));
}

// ── Dedup helpers ──

function normalizeUrl(url) {
    if (!url) return '';
    try {
          const u = new URL(url);
          return (u.hostname + u.pathname).replace(/\/+$/, '').toLowerCase();
    } catch {
          return url.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    }
}

function normalizeName(name, sponsor, state) {
    const base = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const suffix = [sponsor, state].filter(Boolean).map(s => String(s).toLowerCase().trim()).join('|');
    return suffix ? `${base}||${suffix}` : base;
}

/**
 * Score a single program against a profile analysis.
 * Returns null (no match) or scored object with 0-100.
 *
 * @param {Object} program
 * @param {Object} analysis
 * @param {Object} [strategyOpts] - { needEmphasis, intentBoost, intents }
 */
export function scoreProgram(program, analysis, strategyOpts = {}) {
    let score = 0;
    let maxPossible = 0;
    const matchReasons = [];

  const intents = strategyOpts.intents || detectProfileIntents(analysis);

  // Track eligibility mismatch penalty instead of hard-gating.
  // Mismatches reduce score; they must not discard results entirely.
  let eligibilityPenalty = 0;

  // ── Category match (most important — 40 points max) ──
  const programCats = new Set(program.categories || []);
    const profileNeeds = toSignalSet(analysis.needs);

  let categoryHits = 0;
    for (const need of profileNeeds) {
          if (programCats.has(need)) {
                  categoryHits++;
                  matchReasons.push(`Matches your need: ${need}`);
          }
    }

  // Keyword overlap for broader matching
  const profileKeywords = analysis.keywords || [];
    if (categoryHits === 0) {
          for (const kw of profileKeywords) {
                  if ([...programCats].some(c => kw.includes(c) || c.includes(kw))) {
                            categoryHits += 0.5;
                            matchReasons.push(`Keyword overlap: ${kw}`);
                            break;
                  }
          }
    }

  // Portals/referrals are general-purpose — give a baseline even with 0 category hits.
  // Non-portal programs with 0 category hits get a heavy penalty but are NOT discarded —
  // they may still match on demographics, military, health, or other profile signals.
  if (categoryHits === 0) {
    if (program.type === 'portal' || program.type === 'referral') {
      categoryHits = 0.25;
      matchReasons.push('General assistance resource');
    } else {
      eligibilityPenalty -= 20;
      matchReasons.push('No direct category match (penalty)');
    }
  }

  // Score based on absolute category matches, not ratio of needs matched.
  // 1 hit = 12, 2 hits = 22, 3 hits = 32, 4+ hits = 40
  const BASE_CAT_SCORE = 12;
  const ADDITIONAL_PER_CAT_HIT = 10;
  const MAX_ADDITIONAL_CAT_HITS = 3;
  const categoryScore = Math.min(40, categoryHits >= 1 ? BASE_CAT_SCORE + Math.min(MAX_ADDITIONAL_CAT_HITS, categoryHits - 1) * ADDITIONAL_PER_CAT_HIT : Math.round(categoryHits * BASE_CAT_SCORE));
    score += categoryScore;
    maxPossible += 40;

  // ── Intent alignment (up to 25 points) ──
  // Only count toward maxPossible when the program defines intentMatch —
  // otherwise the denominator inflates and suppresses scores for general programs.
    let intentBonus = computeIntentBonus(program, intents);

    // Apply strategy-level intentBoost when the program matches a boosted intent
    const boostMap = strategyOpts.intentBoost || {};
    for (const [boostIntent, boostPts] of Object.entries(boostMap)) {
      if (intents.has(boostIntent) && (program.intentMatch || []).includes(boostIntent)) {
        intentBonus = Math.min(35, intentBonus + boostPts);
      }
    }

    if (program.intentMatch && program.intentMatch.length > 0) {
      maxPossible += 25;
      if (intentBonus > 0) {
            score += intentBonus;
            matchReasons.push('Strong intent alignment with your profile');
      } else {
            score += 0;
            matchReasons.push('No intent alignment with your profile');
      }
    }
    // Programs without intentMatch: no impact on score or denominator

    // ── needEmphasis bonus (up to 10 points) ──
    const needEmphasis = strategyOpts.needEmphasis || [];
    if (needEmphasis.length > 0) {
      let emphasisHits = 0;
      for (const emph of needEmphasis) {
        if (programCats.has(emph)) emphasisHits++;
      }
      if (emphasisHits > 0) {
        const emphasisBonus = Math.min(10, emphasisHits * 5);
        score += emphasisBonus;
        maxPossible += 10;
        matchReasons.push(`Emphasis match: ${emphasisHits} prioritised categories`);
      }
    }

  // ── State match (20 points) ──
  // v4: Use normalizeState for robust comparison ("TN" === "Tennessee" === "tn")
  // Multi-address aware: in-state if the program's state matches ANY of the
  // profile's states (home OH + school TN → both count). Single-address profiles
  // collapse to one state → identical to the old behavior.
  maxPossible += 20;
    const profileStateList = profileStates(analysis);
    const profileState = profileStateList[0] || normalizeState(analysis.location?.state);
    const programState = normalizeState(program.stateRestriction);
    if (!program.stateRestriction || program.stateRestriction === 'nationwide') {
          score += 15;
          matchReasons.push('Available nationwide');
    } else if (programState && profileStateList.includes(programState)) {
          score += 20;
          matchReasons.push(`Available in ${programState}`);
    } else if (profileStateList.length === 0) {
          score += 5;
          matchReasons.push(`State-specific program (${program.stateRestriction}) — your state not set`);
    } else {
          // v4: Reduced from -30 to -15. State mismatch is a soft signal, not a disqualifier.
          // A housing program in CA still has value for someone in TN (they might be relocating,
          // or the program might have national components). Only penalizes when the program's
          // state matches NONE of the profile's states.
          eligibilityPenalty -= 15;
          matchReasons.push(`State mismatch: ${program.stateRestriction} vs ${profileStateList.join('/')} (reduced penalty)`);
    }

  // ── Applicant type match (10 points) ──
  // Canonical rule G4: missing/unknown profile fields are NEUTRAL, never
  // disqualifying. buildProfileSignals() defaults applicantType to 'individual'
  // for BOTH an explicitly-individual person AND a profile that never declared a
  // type. When the type was NOT explicitly determined (applicantTypeExplicit ===
  // false), a program that targets a different applicant type must NOT subtract
  // points — we don't award the applicant-type bonus and we don't count it toward
  // maxPossible, so the program is judged on its other merits (it can still clear
  // the floor on category/intent/locality). Only an EXPLICIT mismatch penalizes.
  if (program.applicantType && program.applicantType !== analysis.applicantType) {
    if (analysis.applicantTypeExplicit === false) {
      matchReasons.push(`Applicant type: ${program.applicantType} (yours not specified — neutral)`);
    } else {
      maxPossible += 10;
      eligibilityPenalty -= 25;
      matchReasons.push(`Applicant type: ${program.applicantType} (you: ${analysis.applicantType})`);
    }
  } else {
    maxPossible += 10;
    score += 10;
  }

  // ── Demographic match (10 points) ──
  // Only count toward maxPossible when the program targets specific demographics.
    if (program.demographicMatch && program.demographicMatch.length > 0) {
          maxPossible += 10;
          const demoHits = program.demographicMatch.filter(d => analysis.demographics.has(d));
          if (demoHits.length > 0) {
                  score += 10;
                  demoHits.forEach(d => matchReasons.push(`Matches demographic: ${d}`));
          } else {
                  score += 2;
          }
    }

  // ── Health condition match (10 points) ──
  // Only count toward maxPossible when the program targets specific health conditions.
    if (program.healthMatch && program.healthMatch.length > 0) {
          maxPossible += 10;
          const healthHits = program.healthMatch.filter(h => analysis.health.has(h));
          if (healthHits.length > 0) {
                  score += 10;
                  healthHits.forEach(h => matchReasons.push(`Matches health condition: ${h}`));
          } else if (program.eligibility?.requiresMedicalCondition ||
                                    program.eligibility?.requiresCancer ||
                                    program.eligibility?.requiresKidneyDisease) {
                  eligibilityPenalty -= 30;
                  matchReasons.push('Requires specific medical condition (not in profile)');
          } else {
                  score += 1;
          }
    }

  // ── Negative match penalty (hard-gate disqualifying negatives) ──
  const negPenalty = computeNegativePenalty(program, analysis);
  if (negPenalty <= -100) return null;
    score += negPenalty;

  // ── Military match (5 points) ──
  // Only count toward maxPossible when the program targets military/veteran status.
    if (program.militaryMatch && program.militaryMatch.length > 0) {
          maxPossible += 5;
          const milHits = program.militaryMatch.filter(m => analysis.military.has(m));
          if (milHits.length > 0) {
                  score += 5;
                  milHits.forEach(m => matchReasons.push(`Matches military status: ${m}`));
          } else if (program.eligibility?.requiresVeteran || program.eligibility?.requiresMilitaryConnection) {
                  eligibilityPenalty -= 30;
                  matchReasons.push('Requires veteran/military status (not in profile)');
          } else {
                  score += 1;
          }
    }

  // ── Family match (5 points) ──
  // Only count toward maxPossible when the program targets specific family situations.
    if (program.familyMatch && program.familyMatch.length > 0) {
          maxPossible += 5;
          const famHits = program.familyMatch.filter(f => analysis.family.has(f));
          if (famHits.length > 0) {
                  score += 5;
                  famHits.forEach(f => matchReasons.push(`Matches family status: ${f}`));
          } else if (program.eligibility?.requiresChildren) {
                  eligibilityPenalty -= 20;
                  matchReasons.push('Requires children/dependents (not in profile)');
          }
    }

  // ── Student/education match (10 points — only for scholarship-type programs) ──
  if (program.studentMatch || program.eligibility?.requiresStudent) {
        maxPossible += 10;
        if (analysis.applicantType === 'student') {
                let eduScore = 5;
                const edu = analysis.education || {};
                if (program.eligibility?.minGPA && edu.gpa && edu.gpa >= program.eligibility.minGPA) {
                          eduScore += 2;
                          matchReasons.push(`GPA ${edu.gpa} meets ${program.eligibility.minGPA} minimum`);
                }
                if (program.eligibility?.minACT && edu.act && edu.act >= program.eligibility.minACT) {
                          eduScore += 1;
                          matchReasons.push(`ACT ${edu.act} meets ${program.eligibility.minACT} minimum`);
                }
                if (program.eligibility?.minSAT && edu.sat && edu.sat >= program.eligibility.minSAT) {
                          eduScore += 1;
                          matchReasons.push(`SAT ${edu.sat} meets ${program.eligibility.minSAT} minimum`);
                }
                if (program.studentMatch?.includes('first_generation') && analysis.demographics.has('first_generation')) {
                          eduScore += 1;
                          matchReasons.push('First-generation student match');
                }
                score += Math.min(10, eduScore);
        } else if (program.eligibility?.requiresStudent) {
                eligibilityPenalty -= 25;
                matchReasons.push('Requires student status (not in profile)');
        }
  }

  // ── Interest/major/sport match (10 points) ──
  if (program.interestMatch && program.interestMatch.length > 0 && analysis.interests?.size > 0) {
        maxPossible += 10;
        const profileInterests = analysis.interests;
        const profileSports = analysis.sports || new Set();
        let interestScore = 0;

      for (const target of program.interestMatch) {
              const tLower = target.toLowerCase();
              for (const interest of profileInterests) {
                        if (interest.includes(tLower) || tLower.includes(interest)) {
                                    interestScore += 3;
                                    matchReasons.push(`Matches interest: ${target}`);
                                    break;
                        }
              }
      }

      if (program.sportGender && analysis.demographics) {
              const genderMatch = (program.sportGender === 'female' && analysis.demographics.has('female')) ||
                                          (program.sportGender === 'male' && analysis.demographics.has('male')) ||
                                          program.sportGender === 'any';
              if (genderMatch && program.interestMatch.some(t => profileSports.has(t.toLowerCase()))) {
                        interestScore += 3;
                        matchReasons.push(`${program.sportGender === 'any' ? 'Athletic' : program.sportGender.charAt(0).toUpperCase() + program.sportGender.slice(1)} sports match`);
              } else if (program.sportGender && !genderMatch) {
                        eligibilityPenalty -= 20;
                        matchReasons.push(`Sport gender mismatch: requires ${program.sportGender}`);
              }
      }

      score += Math.min(10, interestScore);
  }

  // ── School proximity match (5 points) ──
  if (program.schoolMatch && analysis.education) {
        maxPossible += 5;
        const edu = analysis.education;
        const targetNames = (edu.targetColleges || []).map(c => c.toLowerCase());
        const schoolZips = edu.schoolZips || [];
        const schoolStates = edu.schoolStates || [];

      if (program.schoolMatch.names?.some(n => targetNames.some(t => t.includes(n.toLowerCase()) || n.toLowerCase().includes(t)))) {
              score += 5;
              matchReasons.push(`Matches target school: ${program.schoolMatch.names.find(n => targetNames.some(t => t.includes(n.toLowerCase())))}`);
      } else if (program.schoolMatch.zips?.some(z => schoolZips.includes(z))) {
              score += 4;
              matchReasons.push('School is in the program service area');
      } else if (program.schoolMatch.states?.some(s => schoolStates.includes(s) || profileStateList.includes(normalizeState(s)))) {
              score += 3;
              matchReasons.push(`Program available in student's state`);
      }
  }

  // ── Occupation match (5 points) ──
  if (program.occupationMatch && program.occupationMatch.length > 0 && analysis.occupation?.size > 0) {
        maxPossible += 5;
        const occHits = program.occupationMatch.filter(o => analysis.occupation.has(o));
        if (occHits.length > 0) {
                score += 5;
                occHits.forEach(o => matchReasons.push(`Matches occupation: ${o}`));
        } else if (program.eligibility?.requiresOccupation) {
                eligibilityPenalty -= 25;
                matchReasons.push('Requires specific occupation (not in profile)');
        }
  }

  // ── Immigration match (5 points) ──
  if (program.immigrationMatch && program.immigrationMatch.length > 0 && analysis.immigration?.size > 0) {
        maxPossible += 5;
        const immHits = program.immigrationMatch.filter(i => analysis.immigration.has(i));
        if (immHits.length > 0) {
                score += 5;
                immHits.forEach(i => matchReasons.push(`Matches immigration status: ${i}`));
        } else if (program.eligibility?.requiresImmigrationStatus) {
                eligibilityPenalty -= 25;
                matchReasons.push('Requires specific immigration status (not in profile)');
        }
  }

  // ── Geographic qualifier match (5 points) ──
  if (program.geoMatch && program.geoMatch.length > 0 && analysis.geographic?.size > 0) {
        maxPossible += 5;
        const geoHits = program.geoMatch.filter(g => analysis.geographic.has(g));
        if (geoHits.length > 0) {
                score += 5;
                geoHits.forEach(g => matchReasons.push(`Matches geographic qualifier: ${g}`));
        }
  }

  // ── Financial need match (5 points) ──
  if (program.eligibility?.requiresLowIncome || program.eligibility?.incomeBased) {
        maxPossible += 5;
        if (analysis.income.belowPovertyLine || analysis.income.householdIncome) {
                score += 5;
                matchReasons.push('Matches financial need criteria');
        } else {
                score += 2;
        }
  }

  // ── Bonus: Portal/referral type (always useful) ──
  if (program.type === 'portal' || program.type === 'referral') {
        score += 5;
        matchReasons.push('Gateway to multiple services');
  }

  // ── Bonus: Priority flag ──
  if (program.priority === 1) {
        score += 5;
  }

  // ── Apply accumulated eligibility penalties ──
  score += eligibilityPenalty;

  // ── Normalize to 0-100 ──
  // v4: Apply a minimum floor of 5 for any program that wasn't hard-gated.
  // This ensures partial matches (e.g. demographic-only or family-only) still
  // appear in results rather than being silently dropped at minScore threshold.
  const rawNormalized = maxPossible > 0
    ? Math.round(Math.min(100, (score / maxPossible) * 100))
    : 0;
  const normalizedScore = Math.max(5, rawNormalized);

  // Build matched signals list
  const matchedSignals = [];
  if (categoryHits > 0) matchedSignals.push('category');
  if (intentBonus > 0) matchedSignals.push('intent');
  if (program.demographicMatch?.some(d => analysis.demographics.has(d))) matchedSignals.push('demographic');
  if (program.healthMatch?.some(h => analysis.health.has(h))) matchedSignals.push('health');
  if (program.militaryMatch?.some(m => analysis.military.has(m))) matchedSignals.push('military');
  if (program.familyMatch?.some(f => analysis.family.has(f))) matchedSignals.push('family');
  if (program.occupationMatch?.some(o => analysis.occupation?.has(o))) matchedSignals.push('occupation');
  if (program.geoMatch?.some(g => analysis.geographic?.has(g))) matchedSignals.push('geographic');

  const matchedCategories = [...programCats].filter(c => profileNeeds.has(c));

  return {
    ...program,
    matchScore: normalizedScore,
    matchReasons,
    matchedCategories,
    match_explain: {
      matchedSignals,
      matchedNeeds: matchedCategories,
      matchedNeedTerms: matchReasons.filter(r => r.startsWith('Matches your need:')).map(r => r.replace('Matches your need: ', '')),
      scoreBreakdown: {
        category: Math.round(categoryScore),
        intent: intentBonus,
        // Locality reflects in-state credit for ANY of the profile's states.
        locality: (programState && profileStateList.includes(programState)) ? 20 : (!program.stateRestriction || program.stateRestriction === 'nationwide' ? 15 : (profileStateList.length === 0 ? 5 : 0)),
        eligibility: score - categoryScore - intentBonus - ((programState && profileStateList.includes(programState)) ? 20 : (!program.stateRestriction ? 15 : 5)),
        trust: (program.type === 'portal' || program.type === 'referral') ? 5 : 0,
        penalties: negPenalty,
        normalized: normalizedScore,
        raw: score,
        maxPossible,
      },
    },
  };
}

/**
 * Run all programs through the matching engine.
 *
 * @param {Array} allPrograms - Combined array from all data sources
 * @param {Object} analysis   - Output from loadProfileSignals
 * @param {Object} options    - { minScore, maxResults }
 * @returns {Array} Ranked, scored, deduplicated results
 */
export function matchPrograms(allPrograms, analysis, options = {}) {
  const { minScore = 30, maxResults = 50, strategyId = 'comprehensive',
    needEmphasis, intentBoost, intents } = options;
  const strategyOpts = { needEmphasis, intentBoost, intents };

  const results = [];
  const seenIds = new Set();
  const seenUrls = new Set();
  const seenNames = new Set();
  let stats = { total: 0, dupId: 0, dupUrl: 0, dupName: 0, excluded: 0,
    informational: 0, copayGated: 0, belowMin: 0, nullScore: 0 };

  for (const program of allPrograms) {
    stats.total++;

    // Dedup by ID
    if (seenIds.has(program.id)) { stats.dupId++; continue; }
    seenIds.add(program.id);

    // Dedup by URL
    const normUrl = normalizeUrl(program.url);
    if (normUrl && seenUrls.has(normUrl)) { stats.dupUrl++; continue; }
    if (normUrl) seenUrls.add(normUrl);

    const normName = normalizeName(program.name, program.sponsor, program.stateRestriction);
    if (normName && seenNames.has(normName)) { stats.dupName++; continue; }
    if (normName) seenNames.add(normName);

    // Filter informational-only pages
    if (isInformationalOnly(program)) {
      stats.informational++;
      if (!stats.filteredLog) stats.filteredLog = [];
      stats.filteredLog.push({ id: program.id, name: program.name, reason: 'informational_page' });
      continue;
    }

    // Filter copay/patient-assistance when no matching conditions
    if (isCopayOrPatientAssistanceIrrelevant(program, analysis)) {
      stats.copayGated++;
      if (!stats.filteredLog) stats.filteredLog = [];
      stats.filteredLog.push({ id: program.id, name: program.name, reason: 'copay_gated_no_condition_match' });
      continue;
    }

    // Filter loans/matching funds
    if (isExcluded(program)) {
      stats.excluded++;
      if (!stats.filteredLog) stats.filteredLog = [];
      stats.filteredLog.push({ id: program.id, name: program.name, reason: 'loan_or_matching_fund' });
      continue;
    }

    // Score against profile
    const scored = scoreProgram(program, analysis, strategyOpts);
    if (!scored) {
      stats.nullScore++;
      const hardGateReason = getNegativeGateReason(program, analysis);
      if (hardGateReason) {
        if (!stats.filteredLog) stats.filteredLog = [];
        stats.filteredLog.push({
          id: program.id,
          name: program.name,
          reason: 'negative_health_mismatch',
          detail: hardGateReason,
        });
      }
      continue;
    }
    if (scored.matchScore < minScore) {
  stats.belowMin++;
  if (!stats.filteredLog) stats.filteredLog = [];
  stats.filteredLog.push({ id: program.id, name: program.name, reason: 'below_min_score', score: scored.matchScore, threshold: minScore });
  continue;
}

    // Attach strategy context to match_explain
    if (scored.match_explain) {
      scored.match_explain.crawler_type = strategyId;
      scored.match_explain.strategy_id = strategyId;
      scored.match_explain.urlPolicy = {
        urlUsed: scored.url || scored.applicationUrl || null,
        isDirectory: scored.type === 'portal' || scored.type === 'referral',
        acceptedReason: (() => {
  const candidate = scored.url || scored.applicationUrl;
  if (!candidate) return 'no_url';
  try { new URL(candidate); return 'valid_url'; } catch { return 'invalid_url_format'; }
})(),
      };
    }

    results.push(scored);
  }

  // Sort by score descending, then by priority
  results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return (a.priority || 99) - (b.priority || 99);
  });

  log.info(`[MatchEngine] ${stats.total} candidates -> ${results.length} matched | ` +
    `dedup(id:${stats.dupId} url:${stats.dupUrl} name:${stats.dupName}) ` +
    `filtered(info:${stats.informational} copay:${stats.copayGated} excl:${stats.excluded}) ` +
    `scored(null:${stats.nullScore} low:${stats.belowMin})`);

  const sliced = results.slice(0, maxResults);
  sliced._matchStats = stats;
  return sliced;
}

/**
 * Self-identifying role tag. Pipeline code that sees this tag knows the
 * upstream scorer was a prefilter, not the final match authority. Used by
 * tests/mission/mission-match-parity.test.mjs to assert that nothing
 * persists a prefilter score as the final user-facing decision.
 */
export const PREFILTER_ROLE = 'CANDIDATE_PREFILTER'

export default { scoreProgram, matchPrograms, PREFILTER_ROLE };
