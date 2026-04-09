/**
 * NTEE (National Taxonomy of Exempt Entities) code mapping.
 *
 * Maps canonical GrantFlow need categories to IRS NTEE major group codes
 * and back. Used by the 990 batch crawler and reverse-lookup service to
 * find foundations aligned with a profile's needs.
 *
 * Reference: https://nccs.urban.org/classification/national-taxonomy-exempt-entities
 */

export const NEED_TO_NTEE_MAP = {
  research_arts:        ['A'],         // A = Arts, Culture, Humanities
  education:            ['B'],         // B = Education
  environment:          ['C', 'D'],    // C = Environment, D = Animal-Related
  health_medical:       ['E', 'F', 'G', 'H'], // E = Healthcare, F = Mental Health, G = Diseases, H = Medical Research
  mental_health:        ['F'],         // F = Mental Health / Crisis
  substance_recovery:   ['F'],         // F = Mental Health / Substance Abuse
  emergency:            ['M'],         // M = Public Safety, Disaster Preparedness
  public_safety:        ['M'],         // M = Public Safety
  employment:           ['J'],         // J = Employment, Job Related
  food:                 ['K'],         // K = Food, Agriculture, Nutrition
  agriculture:          ['K'],         // K = Food, Agriculture, Nutrition
  housing:              ['L'],         // L = Housing, Shelter
  legal:                ['I'],         // I = Crime, Legal Related
  nonprofit_ministry:   ['X'],         // X = Religion Related
  community_development:['S'],         // S = Community Improvement
  children_youth:       ['O'],         // O = Youth Development
  family_life:          ['P'],         // P = Human Services — Multipurpose
  cash_assistance:      ['P'],         // P = Human Services
  clothing_goods:       ['P'],         // P = Human Services
  transportation:       ['P'],         // P = Human Services
  disability:           ['P'],         // P = Human Services
  veteran:              ['W'],         // W = Public, Society Benefit — Veterans
  women:                ['L', 'P'],    // Housing + Human Services
  senior:               ['P'],         // P = Human Services
  minority:             ['P', 'R'],    // P = Human Services, R = Civil Rights
  immigrant_refugee:    ['P'],         // P = Human Services
  tribal:               ['P'],         // P = Human Services
  business:             ['S', 'W'],    // S = Community Improvement, W = Public/Society Benefit
  technology_equipment: ['U'],         // U = Science & Technology
  rural:                ['S'],         // S = Community Improvement
  municipality:         ['W'],         // W = Public/Society Benefit
  utilities:            ['P'],         // P = Human Services
}

export const NTEE_DESCRIPTIONS = {
  A: 'Arts, Culture & Humanities',
  B: 'Education',
  C: 'Environment',
  D: 'Animal-Related',
  E: 'Healthcare',
  F: 'Mental Health & Crisis',
  G: 'Diseases, Disorders & Medical Disciplines',
  H: 'Medical Research',
  I: 'Crime & Legal-Related',
  J: 'Employment',
  K: 'Food, Agriculture & Nutrition',
  L: 'Housing & Shelter',
  M: 'Public Safety & Disaster Preparedness',
  N: 'Recreation & Sports',
  O: 'Youth Development',
  P: 'Human Services',
  Q: 'International, Foreign Affairs',
  R: 'Civil Rights, Social Action & Advocacy',
  S: 'Community Improvement & Capacity Building',
  T: 'Philanthropy, Voluntarism & Grantmaking',
  U: 'Science & Technology',
  V: 'Social Science',
  W: 'Public & Society Benefit',
  X: 'Religion-Related',
  Y: 'Mutual & Membership Benefit',
  Z: 'Unknown / Unclassified',
}

/**
 * Given a list of canonical need categories, return the unique NTEE codes to search.
 */
export function needsToNteeCodes(needCategories = []) {
  const codes = new Set()
  for (const need of needCategories) {
    const nteeCodes = NEED_TO_NTEE_MAP[need]
    if (nteeCodes) nteeCodes.forEach(c => codes.add(c))
  }
  // Always include T (Philanthropy/Grantmaking) — these are the foundations that fund others
  codes.add('T')
  return [...codes]
}
