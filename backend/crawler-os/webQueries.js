// crawler-os/webQueries.js
//
// Pure: turn a funding thesis into a small set of profile-keyed web-search
// queries for the open-web discovery lane. This is how GrantFlow reaches the
// state/local/foundation/community funding that has NO public API — the breadth
// the federal-API sources (Grants.gov/SAM/NIH) structurally cannot cover.
//
// No I/O, no clock dependency in the core (the year is injected so the module
// stays deterministic for tests).

// Readable noun for an applicant bucket (used in the query text).
const TYPE_WORD = Object.freeze({
  nonprofit: 'nonprofit organization',
  church: 'church / faith-based organization',
  ministry: 'faith-based ministry',
  school: 'school',
  business: 'small business',
  farm: 'farm / agricultural producer',
  government: 'local government',
  tribal: 'tribal organization',
  vfd: 'volunteer fire department',
  law_enforcement: 'law enforcement agency',
  veteran: 'veteran',
  student: 'student',
  family: 'family',
  individual: 'individual',
});

function typeWord(types = []) {
  const t = (types || []).find((x) => x && x !== '*');
  return TYPE_WORD[String(t || '').toLowerCase()] || 'organization';
}

function geoPhrase(location = {}) {
  const city = location?.city ? String(location.city).trim() : '';
  const state = location?.state ? String(location.state).trim() : '';
  if (city && state) return `${city}, ${state}`;
  return state || city || '';
}

/**
 * buildWebQueries — produce up to ~6 deduped, profile-relevant funding queries.
 *
 * @param {object} thesis  crawler-os thesis (applicant_types, needs, location, keywords)
 * @param {{ year?:number, max?:number }} [opts]
 * @returns {string[]}
 */
export function buildWebQueries(thesis = {}, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 6;
  const year = Number.isFinite(opts.year) ? opts.year : new Date().getFullYear();
  const word = typeWord(thesis.applicant_types);
  const geo = geoPhrase(thesis.location);
  const needs = (Array.isArray(thesis.needs) ? thesis.needs : []).filter(Boolean).slice(0, 4);

  const out = [];
  const push = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (s.length > 6 && !out.includes(s)) out.push(s);
  };

  // Need-specific funding searches (the highest-signal queries).
  for (const need of needs) {
    push(`${need} grants for ${word} ${geo}`);
  }
  // Geo + type funding, current cycle.
  if (geo) push(`${word} grants ${geo} ${year}`);
  // Community/place-based philanthropy (where most local money lives).
  if (geo) push(`community foundation grants ${geo}`);
  // Federal/national fallback keyed to the strongest need (no-geo profiles too).
  if (needs[0]) push(`${needs[0]} grant funding ${word}`.trim());
  // Last resort if the profile is sparse: still search something useful.
  if (out.length === 0) push(`grants for ${word} ${geo || year}`);

  return out.slice(0, max);
}

export default { buildWebQueries };
