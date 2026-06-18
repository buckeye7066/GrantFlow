/**
 * stateNormalization.js
 *
 * Canonical US state + Canadian province/territory normalization utility.
 * Converts region names, abbreviations, and common variants to a
 * standard 2-letter uppercase abbreviation.
 *
 * US states and CA provinces share this map because GrantFlow's geo model
 * treats both as "a specific (non-nationwide) region" — the national Geo Crawl
 * tags Canadian opportunities with a 2-letter province code (ON, BC, …) the
 * same way it tags US ones (OH, CA, …), so province codes must resolve here for
 * region-scoped discovery and matching to work.
 *
 * Used by: matching engine, profile sync, Anya, crawlers.
 */

const STATE_MAP = {
  'AL': 'AL', 'ALABAMA': 'AL',
  'AK': 'AK', 'ALASKA': 'AK',
  'AZ': 'AZ', 'ARIZONA': 'AZ',
  'AR': 'AR', 'ARKANSAS': 'AR',
  'CA': 'CA', 'CALIFORNIA': 'CA',
  'CO': 'CO', 'COLORADO': 'CO',
  'CT': 'CT', 'CONNECTICUT': 'CT',
  'DE': 'DE', 'DELAWARE': 'DE',
  'FL': 'FL', 'FLORIDA': 'FL',
  'GA': 'GA', 'GEORGIA': 'GA',
  'HI': 'HI', 'HAWAII': 'HI',
  'ID': 'ID', 'IDAHO': 'ID',
  'IL': 'IL', 'ILLINOIS': 'IL',
  'IN': 'IN', 'INDIANA': 'IN',
  'IA': 'IA', 'IOWA': 'IA',
  'KS': 'KS', 'KANSAS': 'KS',
  'KY': 'KY', 'KENTUCKY': 'KY',
  'LA': 'LA', 'LOUISIANA': 'LA',
  'ME': 'ME', 'MAINE': 'ME',
  'MD': 'MD', 'MARYLAND': 'MD',
  'MA': 'MA', 'MASSACHUSETTS': 'MA',
  'MI': 'MI', 'MICHIGAN': 'MI',
  'MN': 'MN', 'MINNESOTA': 'MN',
  'MS': 'MS', 'MISSISSIPPI': 'MS',
  'MO': 'MO', 'MISSOURI': 'MO',
  'MT': 'MT', 'MONTANA': 'MT',
  'NE': 'NE', 'NEBRASKA': 'NE',
  'NV': 'NV', 'NEVADA': 'NV',
  'NH': 'NH', 'NEW HAMPSHIRE': 'NH', 'NEWHAMPSHIRE': 'NH',
  'NJ': 'NJ', 'NEW JERSEY': 'NJ', 'NEWJERSEY': 'NJ',
  'NM': 'NM', 'NEW MEXICO': 'NM', 'NEWMEXICO': 'NM',
  'NY': 'NY', 'NEW YORK': 'NY', 'NEWYORK': 'NY',
  'NC': 'NC', 'NORTH CAROLINA': 'NC', 'NORTHCAROLINA': 'NC',
  'ND': 'ND', 'NORTH DAKOTA': 'ND', 'NORTHDAKOTA': 'ND',
  'OH': 'OH', 'OHIO': 'OH',
  'OK': 'OK', 'OKLAHOMA': 'OK',
  'OR': 'OR', 'OREGON': 'OR',
  'PA': 'PA', 'PENNSYLVANIA': 'PA',
  'RI': 'RI', 'RHODE ISLAND': 'RI', 'RHODEISLAND': 'RI',
  'SC': 'SC', 'SOUTH CAROLINA': 'SC', 'SOUTHCAROLINA': 'SC',
  'SD': 'SD', 'SOUTH DAKOTA': 'SD', 'SOUTHDAKOTA': 'SD',
  'TN': 'TN', 'TENNESSEE': 'TN',
  'TX': 'TX', 'TEXAS': 'TX',
  'UT': 'UT', 'UTAH': 'UT',
  'VT': 'VT', 'VERMONT': 'VT',
  'VA': 'VA', 'VIRGINIA': 'VA',
  'WA': 'WA', 'WASHINGTON': 'WA',
  'WV': 'WV', 'WEST VIRGINIA': 'WV', 'WESTVIRGINIA': 'WV',
  'WI': 'WI', 'WISCONSIN': 'WI',
  'WY': 'WY', 'WYOMING': 'WY',
  'DC': 'DC', 'DISTRICT OF COLUMBIA': 'DC', 'DISTRICTOFCOLUMBIA': 'DC', 'WASHINGTON DC': 'DC', 'WASHINGTON D.C.': 'DC',
  'PR': 'PR', 'PUERTO RICO': 'PR', 'PUERTORICO': 'PR',
  'GU': 'GU', 'GUAM': 'GU',
  'VI': 'VI', 'VIRGIN ISLANDS': 'VI', 'US VIRGIN ISLANDS': 'VI',
  'AS': 'AS', 'AMERICAN SAMOA': 'AS',
  'MP': 'MP', 'NORTHERN MARIANA ISLANDS': 'MP',

  // Canadian provinces & territories.
  'AB': 'AB', 'ALBERTA': 'AB',
  'BC': 'BC', 'BRITISH COLUMBIA': 'BC', 'BRITISHCOLUMBIA': 'BC',
  'MB': 'MB', 'MANITOBA': 'MB',
  'NB': 'NB', 'NEW BRUNSWICK': 'NB', 'NEWBRUNSWICK': 'NB',
  'NL': 'NL', 'NEWFOUNDLAND AND LABRADOR': 'NL', 'NEWFOUNDLANDANDLABRADOR': 'NL', 'NEWFOUNDLAND': 'NL',
  'NS': 'NS', 'NOVA SCOTIA': 'NS', 'NOVASCOTIA': 'NS',
  'NT': 'NT', 'NORTHWEST TERRITORIES': 'NT', 'NORTHWESTTERRITORIES': 'NT',
  'NU': 'NU', 'NUNAVUT': 'NU',
  'ON': 'ON', 'ONTARIO': 'ON',
  'PE': 'PE', 'PRINCE EDWARD ISLAND': 'PE', 'PRINCEEDWARDISLAND': 'PE', 'PEI': 'PE',
  'QC': 'QC', 'QUEBEC': 'QC', 'QUÉBEC': 'QC',
  'SK': 'SK', 'SASKATCHEWAN': 'SK',
  'YT': 'YT', 'YUKON': 'YT',
};

// Reverse map used by free-text extraction below. Declared up here so
// normalizeStateFromText() never reads a temporal-dead-zone binding even if
// it is invoked during module initialization elsewhere.
const ABBR_TO_NAME = {
  'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
  'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
  'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
  'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas',
  'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
  'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
  'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
  'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York',
  'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
  'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
  'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah',
  'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia',
  'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District of Columbia',
  'PR': 'Puerto Rico', 'GU': 'Guam', 'VI': 'Virgin Islands',
  'AS': 'American Samoa', 'MP': 'Northern Mariana Islands',
  // Canadian provinces & territories.
  'AB': 'Alberta', 'BC': 'British Columbia', 'MB': 'Manitoba', 'NB': 'New Brunswick',
  'NL': 'Newfoundland and Labrador', 'NS': 'Nova Scotia', 'NT': 'Northwest Territories',
  'NU': 'Nunavut', 'ON': 'Ontario', 'PE': 'Prince Edward Island', 'QC': 'Quebec',
  'SK': 'Saskatchewan', 'YT': 'Yukon',
};

const STATE_CODES = new Set(Object.keys(ABBR_TO_NAME));
const NATIONWIDE_TOKEN = 'nationwide';

/**
 * Normalize a state value to a 2-letter uppercase abbreviation.
 * Returns null if the input cannot be resolved.
 *
 * @param {string|null|undefined} input - State name, abbreviation, or variant
 * @returns {string|null} 2-letter state code or null
 */
export function normalizeState(input) {
  if (!input || typeof input !== 'string') return null;
  const cleaned = input.trim().toUpperCase().replace(/[.\-_]/g, '');
  return STATE_MAP[cleaned] || null;
}

export function normalizeStateFromText(input) {
  if (!input || typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  for (const [abbr, name] of Object.entries(ABBR_TO_NAME)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escapedName}\\b`, 'i').test(text)) return abbr;
  }

  const codeMatch = text.match(/\b([A-Z]{2})\b/i);
  if (codeMatch) return normalizeState(codeMatch[1]);
  return normalizeState(text);
}

/**
 * Compare two state values for equality after normalization.
 * Returns true if both resolve to the same 2-letter code.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function statesMatch(a, b) {
  const na = normalizeState(a);
  const nb = normalizeState(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * Get full state name from abbreviation.
 *
 * @param {string} abbr - 2-letter state code
 * @returns {string|null}
 */
export function stateFullName(abbr) {
  if (!abbr || typeof abbr !== 'string') return null;
  return ABBR_TO_NAME[abbr.trim().toUpperCase()] || null;
}

export function normalizeOpportunityState(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === NATIONWIDE_TOKEN) return NATIONWIDE_TOKEN;
  return normalizeState(raw);
}

export function isSpecificState(input) {
  const normalized = normalizeOpportunityState(input);
  return Boolean(normalized && STATE_CODES.has(normalized));
}

/**
 * Check if a value is a valid US state (name or abbreviation).
 */
export function isValidState(input) {
  return normalizeState(input) !== null;
}

export default { normalizeState, normalizeStateFromText, normalizeOpportunityState, isSpecificState, statesMatch, stateFullName, isValidState };
