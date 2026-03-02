/**
 * matchEngine.js
 * 
 * Scores each program against a profile's needs assessment.
 * Returns ranked results with relevance scores.
 * 
 * This replaces the old Grants.gov keyword search.
 * Instead of searching wrong databases with broad terms,
 * we match curated real programs against real needs.
 */

/**
 * Score a single program against a profile analysis.
 * Returns 0 (no match) to 100 (perfect match).
 */
export function scoreProgram(program, analysis) {
  let score = 0;
  let maxPossible = 0;
  const matchReasons = [];

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
  
  // Also check keyword overlap for broader matching
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
  
  const categoryScore = Math.min(40, (categoryHits / Math.max(profileNeeds.size, 1)) * 40);
  score += categoryScore;
  maxPossible += 40;

  // ── State match (20 points) ──
  maxPossible += 20;
  if (!program.stateRestriction) {
    // Federal/national program — available everywhere
    score += 15;
    matchReasons.push('Available nationwide');
  } else if (program.stateRestriction === analysis.location.state) {
    score += 20;
    matchReasons.push(`Available in ${analysis.location.state}`);
  } else {
    return null; // State-restricted program for wrong state — skip entirely
  }

  // ── Applicant type match (10 points) ──
  maxPossible += 10;
  if (program.applicantType && program.applicantType !== analysis.applicantType) {
    return null; // Wrong applicant type
  }
  score += 10; // Either matches or is unrestricted

  // ── Demographic match (10 points) ──
  maxPossible += 10;
  if (program.demographicMatch && program.demographicMatch.length > 0) {
    const demoHits = program.demographicMatch.filter(d => analysis.demographics.has(d));
    if (demoHits.length > 0) {
      score += 10;
      demoHits.forEach(d => matchReasons.push(`Matches demographic: ${d}`));
    } else {
      score += 2; // Program targets specific demographics but profile doesn't match — still available, lower score
    }
  } else {
    score += 7; // No demographic restriction — open to all
  }

  // ── Health condition match (10 points) ──
  maxPossible += 10;
  if (program.healthMatch && program.healthMatch.length > 0) {
    const healthHits = program.healthMatch.filter(h => analysis.health.has(h));
    if (healthHits.length > 0) {
      score += 10;
      healthHits.forEach(h => matchReasons.push(`Matches health condition: ${h}`));
    } else if (program.eligibility?.requiresMedicalCondition || program.eligibility?.requiresCancer || program.eligibility?.requiresKidneyDisease) {
      return null; // Requires specific condition the profile doesn't have
    } else {
      score += 2;
    }
  } else {
    score += 7;
  }

  // ── Military match (5 points) ──
  maxPossible += 5;
  if (program.militaryMatch && program.militaryMatch.length > 0) {
    const milHits = program.militaryMatch.filter(m => analysis.military.has(m));
    if (milHits.length > 0) {
      score += 5;
      milHits.forEach(m => matchReasons.push(`Matches military status: ${m}`));
    } else if (program.eligibility?.requiresVeteran || program.eligibility?.requiresMilitaryConnection) {
      return null; // Requires veteran status the profile doesn't have
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
        eduScore += 2; matchReasons.push(`GPA ${edu.gpa} meets ${program.eligibility.minGPA} minimum`);
      }
      if (program.eligibility?.minACT && edu.act && edu.act >= program.eligibility.minACT) {
        eduScore += 1; matchReasons.push(`ACT ${edu.act} meets ${program.eligibility.minACT} minimum`);
      }
      if (program.eligibility?.minSAT && edu.sat && edu.sat >= program.eligibility.minSAT) {
        eduScore += 1; matchReasons.push(`SAT ${edu.sat} meets ${program.eligibility.minSAT} minimum`);
      }
      if (program.studentMatch?.includes('first_generation') && analysis.demographics.has('first_generation')) {
        eduScore += 1; matchReasons.push('First-generation student match');
      }
      score += Math.min(10, eduScore);
    } else if (program.eligibility?.requiresStudent) {
      return null;
    }
  }

  // ── Interest/major/sport match (10 points — for interest-specific programs) ──
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

    // Gender-specific sport matching
    if (program.sportGender && analysis.demographics) {
      const genderMatch = (program.sportGender === 'female' && analysis.demographics.has('female')) ||
                          (program.sportGender === 'male' && analysis.demographics.has('male')) ||
                          program.sportGender === 'any';
      if (genderMatch && program.interestMatch.some(t => profileSports.has(t.toLowerCase()))) {
        interestScore += 3;
        matchReasons.push(`${program.sportGender === 'any' ? 'Athletic' : program.sportGender.charAt(0).toUpperCase() + program.sportGender.slice(1)} sports match`);
      } else if (program.sportGender && !genderMatch) {
        return null; // Gender-restricted sport scholarship doesn't match
      }
    }

    score += Math.min(10, interestScore);
  }

  // ── School proximity match (5 points — for school-specific programs) ──
  if (program.schoolMatch && analysis.education) {
    maxPossible += 5;
    const edu = analysis.education;
    const targetNames = (edu.targetColleges || []).map(c => c.toLowerCase());
    const schoolZips = edu.schoolZips || [];
    const schoolStates = edu.schoolStates || [];

    if (program.schoolMatch.names?.some(n => targetNames.some(t => t.includes(n.toLowerCase()) || n.toLowerCase().includes(t)))) {
      score += 5; matchReasons.push(`Matches target school: ${program.schoolMatch.names.find(n => targetNames.some(t => t.includes(n.toLowerCase())))}`);
    } else if (program.schoolMatch.zips?.some(z => schoolZips.includes(z))) {
      score += 4; matchReasons.push('School is in the program service area');
    } else if (program.schoolMatch.states?.some(s => schoolStates.includes(s) || s === analysis.location.state)) {
      score += 3; matchReasons.push(`Program available in student's state`);
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

  return {
    ...program,
    matchScore: normalizedScore,
    matchReasons,
    matchedCategories: [...programCats].filter(c => profileNeeds.has(c)),
  };
}

/**
 * Filter out loans, matching funds, and other non-grant items.
 * Belt-and-suspenders check on top of curated data.
 */
function isExcluded(program) {
  const name = (program.name || '').toLowerCase();
  const desc = (program.description || '').toLowerCase();
  const combined = name + ' ' + desc;

  const excludeTerms = [
    'loan', 'repay', 'interest rate', 'matching fund', 'match required',
    'cost-share', 'cost share', 'co-investment', 'equity investment',
    'organizational only', 'institutions only',
  ];

  return excludeTerms.some(term => combined.includes(term));
}

/**
 * Run all programs through the matching engine.
 * 
 * @param {Array} allPrograms - Combined array from all data sources
 * @param {Object} analysis - Output from profileAnalyzer
 * @param {Object} options - { minScore, maxResults }
 * @returns {Array} Ranked, scored, deduplicated results
 */
export function matchPrograms(allPrograms, analysis, options = {}) {
  const { minScore = 30, maxResults = 50 } = options;

  const results = [];
  const seenIds = new Set();

  for (const program of allPrograms) {
    // Skip duplicates
    if (seenIds.has(program.id)) continue;
    seenIds.add(program.id);

    // Skip loans/matching funds
    if (isExcluded(program)) continue;

    // Score against profile
    const scored = scoreProgram(program, analysis);
    if (scored && scored.matchScore >= minScore) {
      results.push(scored);
    }
  }

  // Sort by score descending, then by priority
  results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return (a.priority || 99) - (b.priority || 99);
  });

  return results.slice(0, maxResults);
}

export default { scoreProgram, matchPrograms };
