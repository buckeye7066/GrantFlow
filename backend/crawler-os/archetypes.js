// crawler-os/archetypes.js
//
// Pure: classify a funding THESIS into one coarse applicant ARCHETYPE. This is
// the shared key of the Amy→crawler learning flywheel:
//
//   - Amy classifies each SYNTHETIC profile's thesis after a training crawl and
//     records what the crawler systematically missed for that archetype
//     (services/amy/archetypeLearning.js);
//   - the live crawl classifies each REAL profile's thesis the same way and
//     pulls those learned gap classes into `thesis.learned_gaps`, so
//     buildWebQueries targets the known weakness on the very next run.
//
// Because BOTH sides use this one classifier, a lesson learned on a synthetic
// veteran generalizes to every real veteran without any per-profile state — and
// there is no category-map drift between producer and consumer.
//
// No I/O, no imports — deterministic and unit-testable with plain fixtures.

/** The coarse archetype keys learning is aggregated under. */
export const ARCHETYPES = Object.freeze([
  'student',
  'veteran',
  'military_family',
  'senior',
  'disability',
  'caregiver',
  'first_responder',
  'nonprofit',
  'business',
  'farm',
  'government',
  'tribal',
  'school',
  'family',
  'individual',
]);

const toSet = (arr) => new Set((Array.isArray(arr) ? arr : []).map((x) => String(x ?? '').toLowerCase()));

/**
 * classifyThesisArchetype — map a crawler-os thesis to ONE archetype key.
 * Order matters: the most eligibility-specific signal wins (a veteran student
 * is classified 'student' because student aid is the dominant funding lane;
 * a nonprofit's thesis never falls through to 'individual').
 *
 * @param {object} thesis  crawler-os thesis ({ applicant_types, needs,
 *                          keywords, is_student, ... })
 * @returns {string} one of ARCHETYPES
 */
export function classifyThesisArchetype(thesis = {}) {
  const types = toSet(thesis.applicant_types);
  const signals = toSet([...(thesis.needs ?? []), ...(thesis.keywords ?? [])]);
  const blob = [...signals].join(' ');

  // Org archetypes first — an org thesis must never read as a person.
  if (types.has('tribal')) return 'tribal';
  if (types.has('farm')) return 'farm';
  if (types.has('nonprofit') || types.has('church') || types.has('ministry')) return 'nonprofit';
  if (types.has('school')) return 'school';
  if (types.has('vfd') || types.has('law_enforcement')) return 'first_responder';
  if (types.has('government')) return 'government';
  if (types.has('business')) return 'business';

  // Person archetypes, most specific eligibility lane first.
  if (thesis.is_student === true || types.has('student')) return 'student';
  if (types.has('veteran') || types.has('active_duty') || types.has('guard_reserve') || types.has('transitioning_service_member')) return 'veteran';
  if (types.has('military_spouse')) return 'military_family';
  if (types.has('senior') || /\b(senior|aging|elder|older adult)\b/.test(blob)) return 'senior';
  if (types.has('disabled') || /\b(disability|disabled|assistive)\b/.test(blob)) return 'disability';
  if (types.has('caregiver') || /\b(caregiver|caregiving|respite|kinship)\b/.test(blob)) return 'caregiver';
  if (/\b(ems|emt|paramedic|firefighter|first responder)\b/.test(blob)) return 'first_responder';
  if (types.has('family')) return 'family';
  return 'individual';
}

export default { ARCHETYPES, classifyThesisArchetype };
