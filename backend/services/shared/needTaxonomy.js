/**
 * needTaxonomy.js
 *
 * Expands a user's free-text need description into:
 *   - canonicalNeed: the normalised need category
 *   - synonyms: related terms for broader matching
 *   - mustTerms: terms that MUST appear for a strong match
 *   - programCategories: which program categories to search
 */

const TAXONOMY = {
  rent: {
    canonicalNeed: 'housing',
    synonyms: ['rental assistance', 'arrears', 'eviction prevention', 'homelessness prevention',
      'rapid rehousing', 'emergency rent', 'past due rent', 'security deposit',
      'housing stability', 'rent relief', 'tenant assistance'],
    programCategories: ['housing', 'cash_assistance'],
  },
  housing: {
    canonicalNeed: 'housing',
    synonyms: ['shelter', 'transitional housing', 'section 8', 'public housing',
      'home repair', 'weatherization', 'mortgage assistance', 'housing authority'],
    programCategories: ['housing', 'weatherization'],
  },
  utilities: {
    canonicalNeed: 'utilities',
    synonyms: ['LIHEAP', 'energy assistance', 'shutoff prevention', 'electric bill',
      'gas bill', 'water bill', 'utility arrears', 'disconnect notice',
      'power bill', 'heating assistance', 'cooling assistance', 'WAP'],
    programCategories: ['utilities', 'weatherization'],
  },
  cpr_first_aid: {
    canonicalNeed: 'certification_assistance',
    synonyms: ['CPR class', 'first aid class', 'AED class', 'CPR certification', 'first aid certification',
      'CPR instructor', 'first aid instructor', 'BLS instructor', 'Heartsaver instructor',
      'BLS certification', 'Heartsaver certification', 'ACLS certification',
      'CPR instructor certification', 'first aid instructor certification',
      'safety trainer certification', 'medical certification assistance',
      'CPR training', 'first aid training', 'AED training', 'BLS training',
      'CPR/First Aid', 'CPR/AED', 'CPR class tuition', 'first aid class tuition',
      'community CPR', 'church CPR', 'teach CPR', 'teach first aid',
      'CPR financial assistance', 'CPR scholarship', 'CPR grant',
      'safety certification', 'safety training grant',
      'American Heart Association', 'American Red Cross certification',
      'workforce CPR', 'employer CPR', 'childcare CPR requirement'],
    programCategories: ['certification_assistance', 'cpr_first_aid_training', 'employment',
      'education', 'community_health_training', 'workforce_training'],
  },
  safety_certification: {
    canonicalNeed: 'certification_assistance',
    synonyms: ['safety certification funding', 'instructor course funding',
      'safety training sponsorship', 'community safety grant',
      'public safety training', 'CPR/AED education grant',
      'community preparedness grant', 'safety education mini-grant',
      'volunteer training support', 'ministry safety training',
      'church safety training', 'faith-based CPR', 'ministry CPR',
      'nonprofit training grant', 'civic club sponsorship',
      'Rotary Club grant', 'Lions Club grant', 'Kiwanis grant',
      'hospital foundation training', 'EMS training fund',
      'fire department training', 'public safety certification',
      'YMCA training', 'childcare safety training', 'daycare CPR',
      'afterschool CPR', 'youth program safety'],
    programCategories: ['certification_assistance', 'cpr_first_aid_training',
      'community_health_training', 'volunteer_training_support', 'employment'],
  },
  license_reinstatement: {
    canonicalNeed: 'license_reinstatement_support',
    synonyms: [
      // PROBE / ethics specific
      'PROBE class', 'PROBE ethics class', 'PROBE course', 'PROBE ethics course',
      'PROBE: Ethics and Boundaries', 'PROBE ethics and boundaries',
      'nursing ethics class', 'nursing ethics course', 'professional ethics course',
      'ethics course', 'ethics class', 'board-required ethics course',
      'board-required course', 'board required course', 'board required education',
      'board-required class', 'board required class',
      'professional boundaries course', 'professional boundaries education',
      'disciplinary education', 'disciplinary remediation', 'board-ordered education',
      'board ordered course', 'board-ordered course',
      // license reinstatement
      'license reinstatement', 'nursing license reinstatement', 'healthcare license reinstatement',
      'board reinstatement', 'professional license reinstatement', 'relicensing',
      'recertification', 'occupational relicensing', 'credential restoration',
      'license renewal', 'license restoration', 'license recovery',
      'reinstatement course', 'reinstatement class', 'reinstatement training',
      'reinstatement prerequisite', 'reinstatement requirement',
      // nursing / healthcare re-entry
      'nurse re-entry', 'nurse refresher', 'nursing re-entry program',
      'return to nursing', 'return to practice', 'return to healthcare',
      'returning to healthcare', 'returning to nursing', 'returning to practice',
      'return-to-work healthcare', 'healthcare return to work',
      'healthcare work', 'healthcare workforce re-entry', 'nursing workforce re-entry',
      // professional remediation
      'remediation program', 'remediation course', 'professional remediation',
      'mandatory professional education', 'mandated continuing education',
      'board compliance education', 'professional compliance training',
      'required professional education', 'required board education',
      // exams and credentials
      'NCLEX prep', 'board exam prep', 'state board nursing',
      'professional license', 'nursing license', 'credential evaluation',
      'continuing education nursing', 'CNA recertification',
      // funding-seeking phrases
      'nursing reinstatement course funding', 'help paying for reinstatement',
      'financial assistance reinstatement', 'sponsor reinstatement class',
      'nursing license back', 'get my license back',
    ],
    programCategories: ['license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'workforce_reentry_training', 'employment',
      'education', 'healthcare'],
  },
  professional_development: {
    canonicalNeed: 'professional_development_continuing_education',
    synonyms: [
      'professional development', 'continuing education', 'continuing professional development',
      'CE credits', 'CME credits', 'CME course', 'CE course', 'license renewal',
      'certification exam fees', 'licensure exam fees', 'board exam fees',
      'required remedial coursework', 'ethics remediation', 'boundaries training',
      'conference travel', 'professional association dues', 'workforce remediation',
      'career re-entry training', 'refresher program', 're-entry program',
      'employer tuition assistance', 'tuition reimbursement', 'training scholarship',
      'WIOA', 'Individual Training Account', 'ITA', 'ETPL', 'American Job Center',
      'vocational rehabilitation', 'nurse corps', 'NHSC', 'HRSA training',
      'Ohio Nurses Foundation', 'Texas Nurses Foundation', 'ANA scholarship', 'NASW scholarship',
    ],
    programCategories: [
      'professional_development_continuing_education',
      'license_reinstatement_support',
      'professional_remediation_funding',
      'nursing_reentry_support',
      'workforce_reentry_training',
      'continuing_education',
      'ce_cme_credits',
      'licensure_exam_fees',
      'remedial_coursework',
      'workforce_training',
      'employment',
      'education',
      'healthcare',
      'scholarship',
    ],
  },
  training: {
    canonicalNeed: 'employment',
    synonyms: ['workforce training', 'WIOA', 'ETPL', 'tuition assistance', 'exam fee',
      'certification support', 'licensure', 'nursing licensure prep',
      'vocational training', 'job training', 'career readiness', 'GED prep',
      'CDL training', 'apprenticeship', 'on-the-job training', 'job retraining'],
    programCategories: ['employment', 'education'],
  },
  licensure: {
    canonicalNeed: 'employment',
    synonyms: ['licensure exam', 'certification fee', 'nursing exam',
      'CNA training', 'board exam',
      'state board', 'credential evaluation'],
    programCategories: ['employment', 'education'],
  },
  medical: {
    canonicalNeed: 'healthcare',
    synonyms: ['charity care', 'patient assistance', 'copay assistance', 'prescription help',
      'free clinic', 'sliding scale', 'uninsured', 'disease foundation',
      'medical bills', 'hospital charity', 'health coverage'],
    programCategories: ['healthcare'],
  },
  food: {
    canonicalNeed: 'food',
    synonyms: ['SNAP', 'food stamps', 'food bank', 'food pantry', 'WIC', 'meals on wheels',
      'congregate meals', 'backpack program', 'summer meals', 'groceries'],
    programCategories: ['food'],
  },
  childcare: {
    canonicalNeed: 'childcare',
    synonyms: ['daycare', 'head start', 'preschool', 'CCDF', 'child care subsidy',
      'after school', 'summer care', 'latchkey'],
    programCategories: ['childcare'],
  },
  transportation: {
    canonicalNeed: 'transportation',
    synonyms: ['bus pass', 'vehicle donation', 'car repair', 'transit',
      'ride share', 'medical transportation', 'NEMT'],
    programCategories: ['transportation'],
  },
  internet: {
    canonicalNeed: 'internet',
    synonyms: ['broadband', 'ACP', 'Lifeline', 'connectivity', 'digital equity',
      'WiFi', 'hotspot', 'low-cost internet'],
    programCategories: ['internet'],
  },
  disability: {
    canonicalNeed: 'disability',
    synonyms: ['SSI', 'SSDI', 'adaptive equipment', 'assistive technology',
      'vocational rehabilitation', 'independent living', 'home modification',
      'personal care', 'HCBS waiver', 'supported employment'],
    programCategories: ['disability', 'healthcare', 'employment'],
  },
  dme: {
    canonicalNeed: 'durable_medical_equipment',
    synonyms: ['durable medical equipment', 'DME assistance', 'medical equipment grant',
      'adaptive medical equipment', 'mobility equipment', 'wheelchair funding',
      'hospital bed assistance', 'oxygen equipment assistance', 'shower chair',
      'assistive device funding', 'Medicaid DME', 'Medicare DME'],
    programCategories: ['disability', 'healthcare', 'medical_equipment'],
  },
  business: {
    canonicalNeed: 'business',
    synonyms: ['small business grant', 'microenterprise', 'SBA', 'startup funding',
      'self-employment', 'entrepreneur', 'SBIR', 'minority business',
      'women-owned business', 'veteran business', 'SCORE'],
    programCategories: ['business', 'employment', 'cash_assistance'],
  },
  legal: {
    canonicalNeed: 'legal',
    synonyms: ['legal aid', 'free lawyer', 'immigration attorney', 'court help',
      'expungement', 'custody', 'protective order', 'eviction defense'],
    programCategories: ['legal'],
  },
  mental_health: {
    canonicalNeed: 'mental_health',
    synonyms: ['counseling', 'therapy', 'crisis intervention', 'behavioral health',
      'psychiatric', 'depression', 'anxiety', 'PTSD', 'suicide prevention'],
    programCategories: ['mental_health', 'healthcare'],
  },
  substance: {
    canonicalNeed: 'substance_recovery',
    synonyms: ['addiction', 'rehab', 'detox', 'MAT', 'naloxone', 'sober living',
      'opioid', 'drug treatment', 'alcohol treatment', 'recovery house'],
    programCategories: ['substance_recovery', 'mental_health', 'healthcare'],
  },
  vehicle: {
    canonicalNeed: 'transportation',
    synonyms: ['15 passenger van', 'van for nonprofit', 'passenger van', 'church van',
      'nonprofit vehicle', 'organization vehicle', 'cargo van', 'bus grant',
      'vehicle donation', 'fleet grant', 'transit vehicle', 'ministry van',
      'community van', 'shuttle van', 'van purchase grant', 'vehicle purchase',
      'bus for nonprofit', 'handicap van', 'wheelchair van', 'adaptive vehicle'],
    programCategories: ['transportation', 'equipment', 'business'],
  },
  equipment: {
    canonicalNeed: 'business',
    synonyms: ['equipment grant', 'nonprofit equipment', 'capital equipment',
      'organizational supplies', 'tools grant', 'machinery', 'office equipment',
      'commercial equipment', 'program supplies'],
    programCategories: ['business', 'equipment', 'cash_assistance'],
  },
  scholarship: {
    canonicalNeed: 'education',
    synonyms: ['scholarship', 'tuition aid', 'student grant', 'merit aid',
      'need-based aid', 'financial aid', 'student assistance', 'tuition waiver',
      'college fund', 'endowment', 'fellowship', 'stipend'],
    programCategories: ['scholarship', 'education'],
  },
  student_housing: {
    canonicalNeed: 'housing',
    synonyms: ['off-campus housing', 'student housing', 'college housing', 'dorm cost',
      'room and board', 'housing scholarship', 'housing stipend', 'living expenses',
      'housing allowance', 'residence hall', 'apartment assistance student',
      'campus housing', 'student rent', 'student living'],
    programCategories: ['housing', 'scholarship', 'education'],
  },
};

// Build a reverse-lookup: keyword → taxonomy entry
const KEYWORD_INDEX = new Map();
for (const [key, entry] of Object.entries(TAXONOMY)) {
  KEYWORD_INDEX.set(key, entry);
  for (const syn of entry.synonyms) {
    const norm = syn.toLowerCase();
    if (!KEYWORD_INDEX.has(norm)) KEYWORD_INDEX.set(norm, entry);
  }
}

const EXPAND_NEED_STOPWORDS = new Set([
  'for', 'the', 'and', 'help', 'find', 'get', 'need', 'with', 'from', 'that',
  'have', 'want', 'pay', 'paying', 'source', 'fund', 'funding', 'assistance',
  'me', 'my', 'our', 'you', 'your', 'can', 'could', 'would', 'should', 'about',
  'cover', 'covers', 'covering', 'state', 'year', 'this', 'next', 'apply',
])

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wordMatchesTaxonomyKey(key, word) {
  const normKey = String(key).toLowerCase()
  if (normKey === word) return true
  return normKey.split('_').some((part) => part === word || (word.length >= 5 && part.includes(word)))
}

function wordMatchesSynonym(synonym, word) {
  if (!word || word.length < 3) return false
  const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i')
  return re.test(String(synonym))
}

/**
 * Does this word match the taxonomy target AS THE WHOLE TARGET, rather than as
 * one word inside a longer phrase?
 *
 * WHY THIS DISTINCTION EXISTS (2026-08-14). The fallback branch let ONE word
 * elect an entry, and `wordMatchesSynonym` is satisfied by that word appearing
 * anywhere inside a multi-word synonym. So a word from an entirely different
 * domain elects the entry because it happens to be one word of one of its
 * phrases. Measured against the repo's OWN `research_lab` blueprint subjects
 * (`orgNeedsTaxonomy.NEEDS_TAXONOMY.example_search_terms`), not invented input:
 *
 *   "biosafety level 2 laboratory certification grant"
 *       -> professional_development_continuing_education
 *          (the word `certification` inside 'certification exam fees')
 *   "research computing cloud credits grant"
 *       -> professional_development_continuing_education
 *          (the word `credits` inside 'CE credits' / 'CME credits')
 *
 * Both then carried the 36 nursing / continuing-education synonyms into the
 * search: `liveWebSearch.buildNeedWebQueries` spends one of its ~4 live query
 * slots on the first synonym, so a BIOSAFETY certification need issued
 * "professional development grant", and `scoreNeedMatch` credited 25 points per
 * overlapping nursing category. This is the one-shared-word floor this repo has
 * already fixed in `conditionCoveredBySource`, `enforceLeadContactPlausibility`,
 * `declaredFieldOfStudyRecall` and (twice) in this very function — the same
 * rule, one door over. A word matched as a FRAGMENT of a phrase is weaker
 * evidence than a word that IS the taxonomy's own term, and the election bar
 * below treats it that way.
 */
function wordIsWholeTaxonomyTerm(key, entry, word) {
  const spokenKey = String(key).toLowerCase().replace(/_/g, ' ')
  if (spokenKey === word) return true
  for (const syn of entry.synonyms ?? []) {
    if (String(syn).toLowerCase().trim() === word) return true
  }
  return false
}

/**
 * Does `text` state `phrase` AT TOKEN BOUNDARIES?
 *
 * WHY THIS REPLACED `text.includes(phrase)` (2026-08-13). The primary branch of
 * `expandNeed` tested bare substring containment against the RAW request text.
 * `EXPAND_NEED_STOPWORDS` could not save it — stopwords are applied only to
 * `contentWords`, never to that raw scan. So the 3-character taxonomy key `ssi`
 * matched inside the word "a-SSI-stance", and because "cost assistance" is
 * ordinary funding language, EVERY need phrased that way resolved to the
 * DISABILITY/SSI taxonomy. Measured live 2026-08-13 on the research-lab plan:
 *
 *   "hazardous waste disposal cost assistance small laboratory" -> SSI/SSDI
 *   "IRB review cost assistance small research organization"    -> SSI/SSDI
 *   "patent filing cost assistance program startup"             -> SSI/SSDI
 *   "laboratory facility utility cost assistance"               -> SSI/SSDI
 *
 * expanding each to "adaptive equipment / vocational rehabilitation / home
 * modification" and feeding those terms to the catalog LIKE scan and one of the
 * four live web queries. This is the one-shared-substring floor this repo has
 * now hit in `conditionCoveredBySource`, `enforceLeadContactPlausibility` and
 * `declaredFieldOfStudyRecall` — the same rule, one door over.
 *
 * A snake_case KEY is an internal identifier, so it is also matched in its
 * spoken form ("safety_certification" -> "safety certification"); that is how a
 * key can legitimately match text a person actually typed.
 */
function phraseStatedIn(text, phrase) {
  const norm = String(phrase ?? '').toLowerCase().trim()
  if (!norm) return false
  const spoken = norm.replace(/_/g, ' ')
  for (const candidate of new Set([norm, spoken])) {
    if (!candidate) continue
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(candidate)}(?:[^a-z0-9]|$)`, 'i')
    if (re.test(text)) return true
  }
  return false
}

/**
 * Words that are ordinary FUNDING language rather than evidence of a need.
 *
 * These may not, ALONE, elect a taxonomy entry in the fallback branch. The
 * fallback used to pick its primary by KEY-NAME LENGTH — a property of our
 * internal identifier, not of the request — so the ubiquitous word "grant"
 * elected whichever long-named entry happened to list the most "…grant"
 * synonyms. Measured 2026-08-13: "NIH research grant", "wet lab space grant
 * startup" and "laboratory reagent grant small research lab" ALL resolved to
 * `safety_certification` (CPR/AED, fire-department training, Rotary Club).
 *
 * Distinct from EXPAND_NEED_STOPWORDS, which is applied to `contentWords` and
 * therefore also removes these words from `mustTerms`. These stay available as
 * must-terms — they are just not sufficient to CHOOSE a taxonomy.
 */
const GENERIC_FUNDING_WORDS = new Set([
  'grant', 'grants', 'program', 'programs', 'support', 'cost', 'costs',
  'aid', 'award', 'awards', 'money', 'financial', 'small', 'new',
  // Entity words describe WHO is asking, never WHAT they need. Measured
  // 2026-08-13: "IRB review cost assistance small research organization"
  // resolved to TRANSPORTATION because "organization" matched the synonym
  // "organization vehicle" — a 15-passenger van offered for an ethics review.
  'organization', 'organizations', 'org', 'nonprofit', 'company', 'agency',
  'review', 'general', 'annual', 'local',
])

/**
 * Expand a free-text need into taxonomy terms.
 *
 * @param {string} needText - e.g. "emergency rent", "PROBE class", "utility shutoff"
 * @returns {{ canonicalNeed, synonyms, mustTerms, programCategories, matchedKey }}
 */
export function expandNeed(needText) {
  const text = (needText || '').toLowerCase().trim();
  if (!text) return null;

  // Content words of the request, stoplisted. `EXPAND_NEED_STOPWORDS` existed
  // but was applied ONLY in the fallback branch, so the two branches below put
  // 'for'/'the'/'help'/'funding'/'assistance' into `mustTerms` — and
  // `scoreNeedMatch` credits 5 points per must-term hit. Measured live against
  // prod on 2026-08-02 for "PROBE Ethics class for nursing licensure", that is
  // exactly how the Merriam-Webster and Cambridge Dictionary definitions of the
  // word "probe" scored 10 ('term:probe' + 'term:for') and were reported as
  // funding results. A stopword is not evidence.
  const contentWords = text.split(/\s+/).filter((w) => w.length > 2 && !EXPAND_NEED_STOPWORDS.has(w));

  // Direct key match — a taxonomy KEY is an internal snake_case identifier.
  const keyMatches = [];
  for (const [key, entry] of Object.entries(TAXONOMY)) {
    if (phraseStatedIn(text, key)) {
      keyMatches.push({ key, entry });
    }
  }

  // Synonym match — a SYNONYM is the language a real person types.
  const synMatches = [];
  for (const [syn, entry] of KEYWORD_INDEX.entries()) {
    if (phraseStatedIn(text, syn)) {
      synMatches.push({ syn, entry });
    }
  }

  // ONE ranking over BOTH, by matched-phrase length.
  //
  // These used to be sequential stages: any key hit returned before the synonym
  // scan ever ran. So "PROBE Ethics class for nursing licensure" matched the
  // 9-character KEY `licensure` (a bare substring of "nursing licensure", whose
  // whole entry is 7 generic exam synonyms) and never reached the 18-character
  // SYNONYM 'probe ethics class' that names the exact program class — even
  // though `license_reinstatement` carries 'PROBE class', 'PROBE ethics course',
  // 'board-required ethics course', 'nurse re-entry' and the
  // `license_reinstatement_support` / `professional_remediation_funding`
  // categories the whole search depends on. The key could never win that
  // comparison honestly: it is not a phrase anyone writes. Verified live in prod
  // 2026-08-02 — before: `matchedKey:'licensure'`, canonicalNeed 'employment'.
  const all = [
    ...keyMatches.map((m) => ({ phrase: m.key, entry: m.entry })),
    ...synMatches.map((m) => ({ phrase: m.syn, entry: m.entry })),
  ];
  if (all.length > 0) {
    all.sort((a, b) => b.phrase.length - a.phrase.length);
    const best = all[0];
    // Merge categories from every matching phrase for broader coverage.
    const allCats = new Set(best.entry.programCategories);
    for (const m of all.slice(1)) {
      for (const c of m.entry.programCategories) allCats.add(c);
    }
    return {
      canonicalNeed: best.entry.canonicalNeed,
      synonyms: best.entry.synonyms,
      mustTerms: [...new Set([best.phrase, ...contentWords])],
      programCategories: [...allCats],
      matchedKey: best.phrase,
    };
  }

  // Fallback: collect ALL word-level matches and merge their categories for maximum recall
  const words = contentWords
  const fallbackMatches = [];
  // Collect ALL taxonomy keys that contain any word, then deduplicate by key name.
  // Sort by key length descending before iterating so longer (more specific) keys win
  // when we later pick the primary canonical need.
  const taxonomyEntries = Object.entries(TAXONOMY).sort((a, b) => b[0].length - a[0].length);
  const seenFallbackKeys = new Map();
  for (const word of words) {
    // A generic funding word is not evidence of WHICH need this is, so it may
    // not elect an entry on its own (see GENERIC_FUNDING_WORDS).
    const generic = GENERIC_FUNDING_WORDS.has(word);
    for (const [key, entry] of taxonomyEntries) {
      if (wordMatchesTaxonomyKey(key, word) ||
          entry.synonyms.some((s) => wordMatchesSynonym(s, word))) {
        const whole = !generic && wordIsWholeTaxonomyTerm(key, entry, word);
        const seen = seenFallbackKeys.get(key);
        if (seen) {
          if (!generic) seen.specificWords.add(word);
          if (whole) seen.wholeWords.add(word);
          continue;
        }
        const record = {
          key,
          entry,
          specificWords: new Set(generic ? [] : [word]),
          wholeWords: new Set(whole ? [word] : []),
        };
        seenFallbackKeys.set(key, record);
        fallbackMatches.push(record);
        // Do NOT break — a single word may match multiple taxonomy keys;
        // we want all of them for maximum recall (Goal 7)
      }
    }
  }
  // An entry explained ONLY by generic funding language is not a match at all.
  // This is what stops the word "grant" from electing `safety_certification`
  // (CPR/AED, fire-department training, Rotary Club) for "NIH research grant".
  //
  // ELECTION BAR: an entry must be explained either by a word that IS one of
  // its own terms (WHOLE evidence), or by TWO distinct words that appear inside
  // its phrases (corroborated FRAGMENT evidence). One fragment alone is a
  // coincidence — see `wordIsWholeTaxonomyTerm`. This is strictly NARROWER than
  // the previous `specificWords.size > 0`: every entry it now refuses was
  // elected before by exactly one fragment word, and a refusal here returns the
  // honest null expansion rather than a wrong-domain one. Silence is not a
  // denial, but a wrong domain is worse than silence: it spends a live web
  // query slot and awards category points on another field's vocabulary.
  const specificMatches = fallbackMatches.filter(
    (m) => m.wholeWords.size > 0 || m.specificWords.size >= 2,
  );
  fallbackMatches.length = 0;
  fallbackMatches.push(...specificMatches);
  if (fallbackMatches.length > 0) {
    // Rank by EVIDENCE — how many distinct specific words the entry explains —
    // and only then by key length as a stable tie-break. Ranking by key length
    // alone let an internal identifier's spelling decide the canonical need.
    // WHOLE evidence outranks fragment evidence, then evidence COUNT, then key
    // length purely as a stable tie-break (never as evidence — an internal
    // identifier's spelling is not a fact about the request).
    fallbackMatches.sort((a, b) =>
      (b.wholeWords.size - a.wholeWords.size) ||
      (b.specificWords.size - a.specificWords.size) ||
      (b.key.length - a.key.length));
    const primary = fallbackMatches[0];
    const mergedCats = new Set(primary.entry.programCategories);
    for (const fm of fallbackMatches.slice(1)) {
      for (const c of fm.entry.programCategories) mergedCats.add(c);
    }
    return {
      canonicalNeed: primary.entry.canonicalNeed,
      synonyms: primary.entry.synonyms,
      mustTerms: words,
      programCategories: [...mergedCats],
      matchedKey: primary.key,
    };
  }

  return {
    canonicalNeed: null,
    synonyms: [],
    mustTerms: words,
    programCategories: [],
    matchedKey: null,
  };
}

/**
 * Score how well a program matches an expanded need.
 * Returns 0-100 or null if no match.
 */
export function scoreNeedMatch(program, expandedNeed) {
  if (!expandedNeed || !program) return null;

  const programText = `${program.name || ''} ${program.description || ''} ${(program.categories || []).join(' ')}`.toLowerCase();
  let score = 0;
  const matchedTerms = [];

  // Category overlap — capped at 40 pts total to prevent broad-category programs
  // from reaching acceptance thresholds on category tags alone (Goal 3).
  const cats = new Set((program.categories || []).map((c) => String(c).toLowerCase()));
  let catScore = 0;
  for (const cat of expandedNeed.programCategories) {
    const norm = String(cat).toLowerCase();
    if (cats.has(norm)) {
      catScore += 25;
      matchedTerms.push(`category:${norm}`);
    }
  }
  score += Math.min(40, catScore);

  const pdQuery =
    expandedNeed.canonicalNeed === 'professional_development_continuing_education' ||
    expandedNeed.canonicalNeed === 'license_reinstatement_support' ||
    (expandedNeed.programCategories || []).some((c) =>
      ['license_reinstatement_support', 'professional_remediation_funding', 'professional_development_continuing_education'].includes(String(c).toLowerCase()),
    );
  if (pdQuery) {
    const incomeSupport =
      cats.has('cash_assistance') ||
      cats.has('income_support') ||
      /\b(ssi|supplemental security income|ssdi|snap|tanf|general assistance)\b/i.test(programText);
    const pdAligned =
      (expandedNeed.programCategories || []).some((c) => cats.has(String(c).toLowerCase())) ||
      /\b(wioa|workforce|vocational rehabilitation|continuing education|probe|license reinstatement|nursing re-?entry|remediation|nurse corps|nhsc|american job center)\b/i.test(programText);
    if (incomeSupport && !pdAligned) {
      return {
        score: Math.min(15, score),
        matchedTerms: [...matchedTerms, 'pd_query_income_support_penalty'],
        canonicalNeed: expandedNeed.canonicalNeed,
      };
    }
  }

  // Must-term presence
  let mustHits = 0;
  for (const term of expandedNeed.mustTerms) {
    if (programText.includes(term.toLowerCase())) {
      mustHits++;
      matchedTerms.push(`term:${term}`);
    }
  }
  // Cap must-term contribution at 20 pts regardless of word count
  score += Math.min(20, mustHits * 5);

  // Synonym presence
  let synHits = 0;
  for (const syn of expandedNeed.synonyms) {
    if (programText.includes(syn.toLowerCase())) {
      synHits++;
      if (synHits <= 3) matchedTerms.push(`synonym:${syn}`);
    }
  }
  score += Math.min(30, synHits * 10);

  // Return a low-signal result rather than null so the decision engine can still evaluate;
  // null suppresses before computeMatchDecision() sees the record (violates Goal 7)
  if (score === 0) {
    return {
      score: 0,
      matchedTerms: [],
      canonicalNeed: expandedNeed.canonicalNeed,
    };
  }

  return {
    score: Math.min(100, score),
    matchedTerms,
    canonicalNeed: expandedNeed.canonicalNeed,
    matchedProgramCategories: expandedNeed.programCategories.filter(c => (program.categories || []).includes(c)),
    mustTermHits: expandedNeed.mustTerms.filter(t => programText.includes(t.toLowerCase())),
  };
}

export default { expandNeed, scoreNeedMatch, TAXONOMY };
