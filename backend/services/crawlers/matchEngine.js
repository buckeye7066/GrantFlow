/**
 * matchEngine.js
 *
 * Scores each program against a profile's needs assessment.
 * Returns ranked results with relevance scores.
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

  if (analysis.occupation.has('small_business_owner') ||
            analysis.occupation.has('minority_owned_business') ||
            analysis.occupation.has('women_owned_business') ||
            (analysis.keywords || []).some(k =>
                      /business|entrepreneur|startup|self.?employ|microenterprise|food\s*truck|mobile\s*food/i.test(k))) {
        intents.add('business');
        intents.add('entrepreneurship');
        intents.add('self_employment');
  }

  if (analysis.applicantType === 'student' ||
            analysis.needs.has('scholarship') ||
            analysis.needs.has('education')) {
        intents.add('education');
  }

  if (analysis.health.size > 0 ||
            analysis.needs.has('disability')) {
        intents.add('healthcare');
  }

  if (analysis.military.size > 0) {
        intents.add('military');
  }

  if (analysis.needs.has('housing') || analysis.family.has('homeless')) {
        intents.add('housing');
  }

  if (analysis.needs.has('employment') && !intents.has('business')) {
        intents.add('workforce');
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
        if (program.eligibility[eligKey] && !analysis.health.has(rule.healthRequired)) {
                return rule.penalty;
        }
  }
    return 0;
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
  if (program.eligibility?.requiresMedicalCondition && analysis.health.size === 0) {
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

function normalizeName(name) {
    return (name || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
}

/**
 * Score a single program against a profile analysis.
 * Returns null (no match) or scored object with 0-100.
 */
export function scoreProgram(program, analysis) {
    let score = 0;
    let maxPossible = 0;
    const matchReasons = [];

  const intents = detectProfileIntents(analysis);

  // ── Hard gate: requiresMedicalCondition with no health signals ──
  if (program.eligibility?.requiresMedicalCondition && analysis.health.size === 0) {
        return null;
  }

  // ── Category match (most important — 40 points max) ──
  const programCats = new Set(program.categories || []);
    const profileNeeds = analysis.needs;

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

  if (categoryHits === 0) return null;

  // Score based on absolute category matches, not ratio of needs matched.
  // Profiles with many needs should NOT be penalized for having broad assistance requirements.
  // 1 hit = 12, 2 hits = 22, 3 hits = 32, 4+ hits = 40
  const BASE_CAT_SCORE = 12;
  const ADDITIONAL_PER_CAT_HIT = 10;
  const MAX_ADDITIONAL_CAT_HITS = 3;
  const categoryScore = Math.min(40, categoryHits >= 1 ? BASE_CAT_SCORE + Math.min(MAX_ADDITIONAL_CAT_HITS, categoryHits - 1) * ADDITIONAL_PER_CAT_HIT : 0);
    score += categoryScore;
    maxPossible += 40;

  // ── Intent alignment (up to 25 points) ──
  maxPossible += 25;
    const intentBonus = computeIntentBonus(program, intents);
    if (intentBonus > 0) {
          score += intentBonus;
          matchReasons.push('Strong intent alignment with your profile');
    } else if (program.intentMatch && program.intentMatch.length > 0) {
          // Program declares intents but NONE match profile → penalize
      score += 0;
    } else {
          score += 5; // baseline — program doesn't declare intent tags
    }

  // ── State match (20 points) ──
  maxPossible += 20;
    if (!program.stateRestriction) {
          score += 15;
          matchReasons.push('Available nationwide');
    } else if (program.stateRestriction === analysis.location.state) {
          score += 20;
          matchReasons.push(`Available in ${analysis.location.state}`);
    } else {
          return null;
    }

  // ── Applicant type match (10 points) ──
  maxPossible += 10;
    if (program.applicantType && program.applicantType !== analysis.applicantType) {
          return null;
    }
    score += 10;

  // ── Demographic match (10 points) ──
  maxPossible += 10;
    if (program.demographicMatch && program.demographicMatch.length > 0) {
          const demoHits = program.demographicMatch.filter(d => analysis.demographics.has(d));
          if (demoHits.length > 0) {
                  score += 10;
                  demoHits.forEach(d => matchReasons.push(`Matches demographic: ${d}`));
          } else {
                  score += 2;
          }
    } else {
          score += 7;
    }

  // ── Health condition match (10 points) ──
  maxPossible += 10;
    if (program.healthMatch && program.healthMatch.length > 0) {
          const healthHits = program.healthMatch.filter(h => analysis.health.has(h));
          if (healthHits.length > 0) {
                  score += 10;
                  healthHits.forEach(h => matchReasons.push(`Matches health condition: ${h}`));
          } else if (program.eligibility?.requiresMedicalCondition ||
                                    program.eligibility?.requiresCancer ||
                                    program.eligibility?.requiresKidneyDisease) {
                  return null;
          } else {
                  score += 1; // Reduced from 2 — healthcare programs with no health match deserve less
          }
    } else {
          score += 7;
    }

  // ── Negative match penalty ──
  const negPenalty = computeNegativePenalty(program, analysis);
    if (negPenalty <= -100) return null;
    score += negPenalty;

  // ── Military match (5 points) ──
  maxPossible += 5;
    if (program.militaryMatch && program.militaryMatch.length > 0) {
          const milHits = program.militaryMatch.filter(m => analysis.military.has(m));
          if (milHits.length > 0) {
                  score += 5;
                  milHits.forEach(m => matchReasons.push(`Matches military status: ${m}`));
          } else if (program.eligibility?.requiresVeteran || program.eligibility?.requiresMilitaryConnection) {
                  return null;
          } else {
                  score += 1;
          }
    } else {
          score += 3;
    }

  // ── Family match (5 points) ──
  maxPossible += 5;
    if (program.familyMatch && program.familyMatch.length > 0) {
          const famHits = program.familyMatch.filter(f => analysis.family.has(f));
          if (famHits.length > 0) {
                  score += 5;
                  famHits.forEach(f => matchReasons.push(`Matches family status: ${f}`));
          } else if (program.eligibility?.requiresChildren) {
                  return null;
          }
    } else {
          score += 3;
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
                return null;
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
                        return null;
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
      } else if (program.schoolMatch.states?.some(s => schoolStates.includes(s) || s === analysis.location.state)) {
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
                return null;
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
                return null;
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

  // ── Normalize to 0-100 ──
  const normalizedScore = Math.round(Math.min(100, (score / maxPossible) * 100));

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
        locality: program.stateRestriction === analysis.location.state ? 20 : (!program.stateRestriction ? 15 : 0),
        eligibility: score - categoryScore - intentBonus - (program.stateRestriction === analysis.location.state ? 20 : 15),
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
 * @param {Object} analysis   - Output from profileAnalyzer
 * @param {Object} options    - { minScore, maxResults }
 * @returns {Array} Ranked, scored, deduplicated results
 */
export function matchPrograms(allPrograms, analysis, options = {}) {
  const { minScore = 30, maxResults = 50, strategyId = 'comprehensive' } = options;

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

    // Dedup by name
    const normName = normalizeName(program.name);
    if (normName && seenNames.has(normName)) { stats.dupName++; continue; }
    if (normName) seenNames.add(normName);

    // Filter informational-only pages
    if (isInformationalOnly(program)) { stats.informational++; continue; }

    // Filter copay/patient-assistance when no matching conditions
    if (isCopayOrPatientAssistanceIrrelevant(program, analysis)) { stats.copayGated++; continue; }

    // Filter loans/matching funds
    if (isExcluded(program)) { stats.excluded++; continue; }

    // Score against profile
    const scored = scoreProgram(program, analysis);
    if (!scored) { stats.nullScore++; continue; }
    if (scored.matchScore < minScore) { stats.belowMin++; continue; }

    // Attach strategy context to match_explain
    if (scored.match_explain) {
      scored.match_explain.crawler_type = strategyId;
      scored.match_explain.strategy_id = strategyId;
      scored.match_explain.urlPolicy = {
        urlUsed: scored.url || scored.applicationUrl || null,
        isDirectory: scored.type === 'portal' || scored.type === 'referral',
        acceptedReason: (scored.url || scored.applicationUrl) ? 'valid_url' : 'no_url',
      };
    }

    results.push(scored);
  }

  // Sort by score descending, then by priority
  results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return (a.priority || 99) - (b.priority || 99);
  });

  console.log(`[MatchEngine] ${stats.total} candidates -> ${results.length} matched | ` +
    `dedup(id:${stats.dupId} url:${stats.dupUrl} name:${stats.dupName}) ` +
    `filtered(info:${stats.informational} copay:${stats.copayGated} excl:${stats.excluded}) ` +
    `scored(null:${stats.nullScore} low:${stats.belowMin})`);

  const sliced = results.slice(0, maxResults);
  sliced._matchStats = stats;
  return sliced;
}

export default { scoreProgram, matchPrograms };
