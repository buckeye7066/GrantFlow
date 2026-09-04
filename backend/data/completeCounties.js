const CENSUS_COUNTY_URL = 'https://api.census.gov/data/2024/acs/acs5?get=NAME&for=county:*';
const REQUEST_TIMEOUT_MS = 15000;
const MIN_EXPECTED_COUNTY_EQUIVALENTS = 3140;

const STATE_FIPS_TO_CODE = Object.freeze({
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY',
});

function countyNameFromCensusName(name) {
  return String(name || '').replace(/,\s*[^,]+$/, '').trim();
}

function validateCountyAuthority(rows) {
  const states = new Set(rows.map((row) => row.state));
  if (states.size !== 51) {
    throw new Error(`Census county authority returned ${states.size} state/DC codes; expected 51`);
  }
  if (rows.length < MIN_EXPECTED_COUNTY_EQUIVALENTS) {
    throw new Error(
      `Census county authority returned ${rows.length} county equivalents; expected at least ${MIN_EXPECTED_COUNTY_EQUIVALENTS}`,
    );
  }
}

async function loadCurrentCountiesFromCensus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await fetch(CENSUS_COUNTY_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Census county request failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload) || payload.length < 2 || !Array.isArray(payload[0])) {
      throw new Error('Census county response had an unexpected shape');
    }

    const header = payload[0];
    const nameIndex = header.indexOf('NAME');
    const stateIndex = header.indexOf('state');
    const countyIndex = header.indexOf('county');
    if (nameIndex < 0 || stateIndex < 0 || countyIndex < 0) {
      throw new Error('Census county response is missing NAME/state/county columns');
    }

    const seen = new Set();
    const rows = [];
    for (const record of payload.slice(1)) {
      if (!Array.isArray(record)) continue;
      const state = STATE_FIPS_TO_CODE[String(record[stateIndex] || '').padStart(2, '0')];
      if (!state) continue; // excludes Puerto Rico and island areas
      const county = countyNameFromCensusName(record[nameIndex]);
      const countyFips = String(record[countyIndex] || '').padStart(3, '0');
      if (!county || !/^\d{3}$/.test(countyFips)) continue;
      const key = `${state}:${countyFips}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ state, county, county_fips: countyFips });
    }

    validateCountyAuthority(rows);
    return rows.sort((a, b) => a.state.localeCompare(b.state) || a.county.localeCompare(b.county));
  } finally {
    clearTimeout(timer);
  }
}

// This module is imported lazily only when the opt-in county crawler actually
// needs a nationwide county authority. The source is the Census Bureau's 2024
// ACS county geography, which includes county equivalents such as Louisiana
// parishes, Alaska boroughs/census areas, Connecticut planning regions, and
// independent cities. If that authoritative read is unavailable or incomplete,
// import fails and the caller must fail closed instead of silently skipping real
// jurisdictions.
export const COMPLETE_US_COUNTIES = Object.freeze(
  (await loadCurrentCountiesFromCensus()).map((row) => Object.freeze(row)),
);

export const COUNTY_DATA_SOURCE = Object.freeze({
  authority: 'U.S. Census Bureau',
  vintage: '2024 ACS',
  url: CENSUS_COUNTY_URL,
  count: COMPLETE_US_COUNTIES.length,
});

export default COMPLETE_US_COUNTIES;
