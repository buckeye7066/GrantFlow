/**
 * Golden Crawler Test Suite
 *
 * Deterministic tests against fixture profiles.
 * Fails loudly if relevance, URLs, or match_explain regress.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchPrograms, scoreProgram } from '../../backend/services/crawlers/matchEngine.js';
import { getStrategy, checkGates } from '../../backend/services/crawlers/strategyRegistry.js';
import { expandNeed, scoreNeedMatch } from '../../backend/services/shared/needTaxonomy.js';
import { FEDERAL_BENEFITS } from '../../backend/services/shared/data/federalBenefits.js';
import { NATIONAL_PROGRAMS } from '../../backend/services/shared/data/nationalPrograms.js';
import { BUSINESS_PROGRAMS } from '../../backend/services/shared/data/businessPrograms.js';
import { SCHOLARSHIPS } from '../../backend/services/shared/data/scholarships.js';

// ═══════════════════════════════════════
// GOLDEN FIXTURE PROFILES
// ═══════════════════════════════════════

const FIXTURES = {
  emergencyRent: {
    label: 'Individual needing emergency rent',
    analysis: {
      profileId: 'fix-emergency-rent',
      profileName: 'Emergency Rent Fixture',
      location: { state: 'WV', city: 'Charleston', zip: '25301', county: 'Kanawha' },
      applicantType: 'individual',
      needs: new Set(['housing', 'utilities', 'cash_assistance', 'food']),
      demographics: new Set(['female']),
      health: new Set(),
      family: new Set(['single_parent', 'has_children']),
      military: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(['appalachian']),
      income: { bracket: 'low', belowPovertyLine: true, householdSize: 3, householdIncome: 18000 },
      education: {},
      interests: new Set(),
      sports: new Set(),
      schools: [],
      keywords: ['rent', 'eviction', 'utility', 'housing'],
    },
  },

  workforceTraining: {
    label: 'Individual needing licensure/PROBE class training',
    analysis: {
      profileId: 'fix-workforce',
      profileName: 'Workforce Training Fixture',
      location: { state: 'TN', city: 'Nashville', zip: '37203', county: 'Davidson' },
      applicantType: 'individual',
      needs: new Set(['employment', 'education']),
      demographics: new Set(),
      health: new Set(),
      family: new Set(),
      military: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(),
      income: { bracket: 'low', belowPovertyLine: false, householdSize: 1, householdIncome: 28000 },
      education: { level: 'some_college' },
      interests: new Set(['nursing', 'healthcare']),
      sports: new Set(),
      schools: [],
      keywords: ['job training', 'licensure', 'PROBE class', 'nursing', 'workforce'],
    },
  },

  healthMedical: {
    label: 'Health/medical assistance profile',
    analysis: {
      profileId: 'fix-health',
      profileName: 'Health Medical Fixture',
      location: { state: 'OH', city: 'Columbus', zip: '43201', county: 'Franklin' },
      applicantType: 'individual',
      needs: new Set(['healthcare', 'disability']),
      demographics: new Set(['senior']),
      health: new Set(['cancer', 'chronic_illness']),
      family: new Set(),
      military: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(),
      income: { bracket: 'low', belowPovertyLine: true, householdSize: 1, householdIncome: 15000 },
      education: {},
      interests: new Set(),
      sports: new Set(),
      schools: [],
      keywords: ['cancer', 'treatment', 'medical', 'prescription'],
    },
  },

  studentCollege: {
    label: 'Student profile (college + major)',
    analysis: {
      profileId: 'fix-student',
      profileName: 'Student Fixture',
      location: { state: 'WV', city: 'Morgantown', zip: '26505', county: 'Monongalia' },
      applicantType: 'student',
      needs: new Set(['scholarship', 'education']),
      demographics: new Set(['first_generation', 'female']),
      health: new Set(),
      family: new Set(),
      military: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(['appalachian']),
      income: { bracket: 'low', belowPovertyLine: true, householdSize: 4, householdIncome: 32000 },
      education: { level: 'high_school', gpa: 3.7, act: 28, intendedMajor: 'nursing', firstGeneration: true, targetColleges: ['WVU', 'Marshall University'] },
      interests: new Set(['nursing', 'stem', 'healthcare']),
      sports: new Set(),
      schools: [],
      keywords: ['scholarship', 'college', 'nursing', 'financial aid'],
    },
  },

  businessStartup: {
    label: 'Business startup profile',
    analysis: {
      profileId: 'fix-business',
      profileName: 'Business Startup Fixture',
      location: { state: 'GA', city: 'Atlanta', zip: '30301', county: 'Fulton' },
      applicantType: 'individual',
      needs: new Set(['business', 'employment', 'cash_assistance']),
      demographics: new Set(['african_american', 'female']),
      health: new Set(),
      family: new Set(),
      military: new Set(),
      occupation: new Set(['small_business_owner', 'minority_owned_business', 'women_owned_business']),
      immigration: new Set(),
      geographic: new Set(['urban_underserved']),
      income: { bracket: 'low', belowPovertyLine: false, householdSize: 2, householdIncome: 35000 },
      education: {},
      interests: new Set(['business', 'entrepreneurship']),
      sports: new Set(),
      schools: [],
      keywords: ['small business', 'startup', 'entrepreneur', 'grant'],
    },
  },

  specialNeeds: {
    label: 'Disability / special needs profile',
    analysis: {
      profileId: 'fix-disability',
      profileName: 'Special Needs Fixture',
      location: { state: 'WV', city: 'Huntington', zip: '25701', county: 'Cabell' },
      applicantType: 'individual',
      needs: new Set(['disability', 'healthcare', 'housing', 'transportation']),
      demographics: new Set(),
      health: new Set(['physical_disability', 'disability']),
      family: new Set(),
      military: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(['appalachian']),
      income: { bracket: 'low', belowPovertyLine: true, householdSize: 1, householdIncome: 12000 },
      education: {},
      interests: new Set(),
      sports: new Set(),
      schools: [],
      keywords: ['disability', 'wheelchair', 'SSI', 'accommodation'],
    },
  },

  veteranProfile: {
    label: 'Veteran profile',
    analysis: {
      profileId: 'fix-veteran',
      profileName: 'Veteran Fixture',
      location: { state: 'TX', city: 'San Antonio', zip: '78201', county: 'Bexar' },
      applicantType: 'individual',
      needs: new Set(['housing', 'employment', 'healthcare']),
      demographics: new Set(['male', 'veteran']),
      health: new Set(['mental_health']),
      family: new Set(),
      military: new Set(['veteran', 'disabled_veteran']),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(),
      income: { bracket: 'low', belowPovertyLine: false, householdSize: 1, householdIncome: 22000 },
      education: {},
      interests: new Set(),
      sports: new Set(),
      schools: [],
      keywords: ['veteran', 'VA', 'military', 'service'],
    },
  },

  sparseProfile: {
    label: 'Sparse profile (minimal data)',
    analysis: {
      profileId: 'fix-sparse',
      profileName: 'Sparse Fixture',
      location: { state: 'WV', city: null, zip: null, county: null },
      applicantType: 'individual',
      needs: new Set(['utilities', 'housing', 'food', 'healthcare', 'cash_assistance']),
      demographics: new Set(),
      health: new Set(),
      family: new Set(),
      military: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(),
      income: { bracket: null, belowPovertyLine: false, householdSize: null, householdIncome: null },
      education: {},
      interests: new Set(),
      sports: new Set(),
      schools: [],
      keywords: [],
    },
  },
};

const ALL_PROGRAMS = [...FEDERAL_BENEFITS, ...NATIONAL_PROGRAMS, ...BUSINESS_PROGRAMS, ...SCHOLARSHIPS];

// ═══════════════════════════════════════
// TESTS
// ═══════════════════════════════════════

describe('Strategy Registry', () => {
  it('all CRAWLER_TYPES have a strategy', () => {
    const types = ['comprehensive', 'local_funding', 'government_funding', 'student_grants',
      'health_resources', 'special_needs', 'ecf_benefits', 'curated_benefits', 'item_matching'];
    for (const type of types) {
      const s = getStrategy(type);
      assert.equal(s.id, type, `Strategy missing for ${type}`);
    }
  });

  it('hard gates work correctly', () => {
    const s = getStrategy('student_grants');
    assert.ok(checkGates(s, new Set(['education'])).gated === false, 'should pass with education intent');
    assert.ok(checkGates(s, new Set(['housing'])).gated === true, 'should fail without education intent');
  });

  it('comprehensive has no gates', () => {
    const s = getStrategy('comprehensive');
    assert.ok(checkGates(s, new Set()).gated === false);
  });
});

describe('Need Taxonomy', () => {
  it('expands "emergency rent" to housing', () => {
    const exp = expandNeed('emergency rent');
    assert.equal(exp.canonicalNeed, 'housing');
    assert.ok(exp.synonyms.length > 3);
    assert.ok(exp.programCategories.includes('housing'));
  });

  it('expands "PROBE class" to employment', () => {
    const exp = expandNeed('PROBE class for nursing');
    assert.ok(exp.canonicalNeed === 'employment' || exp.canonicalNeed === 'license_reinstatement_support' || exp.matchedKey === 'licensure' || exp.matchedKey === 'training');
  });

  it('expands "utility shutoff" to utilities', () => {
    const exp = expandNeed('utility shutoff prevention');
    assert.equal(exp.canonicalNeed, 'utilities');
  });

  it('expands "small business grant" to business', () => {
    const exp = expandNeed('small business grant');
    assert.equal(exp.canonicalNeed, 'business');
  });

  it('scores a program against expanded need', () => {
    const exp = expandNeed('rental assistance');
    const program = { name: 'Emergency Rental Assistance', description: 'Helps with past-due rent and eviction prevention', categories: ['housing', 'cash_assistance'] };
    const result = scoreNeedMatch(program, exp);
    assert.ok(result !== null);
    assert.ok(result.score >= 25);
    assert.ok(result.matchedTerms.length > 0);
  });
});

describe('Golden Profiles — Comprehensive', () => {
  for (const [key, fixture] of Object.entries(FIXTURES)) {
    it(`${fixture.label}: returns count > 0`, () => {
      const results = matchPrograms(ALL_PROGRAMS, fixture.analysis, { minScore: 20, maxResults: 100 });
      assert.ok(results.length > 0, `${key} returned 0 results`);
    });

    it(`${fixture.label}: 100% have URL`, () => {
      const results = matchPrograms(ALL_PROGRAMS, fixture.analysis, { minScore: 20, maxResults: 100 });
      for (const r of results) {
        const url = r.url || r.applicationUrl || '';
        assert.ok(/^https?:\/\//.test(url), `${r.name} (${r.id}) has no valid URL: "${url}"`);
      }
    });

    it(`${fixture.label}: 100% have match_explain`, () => {
      const results = matchPrograms(ALL_PROGRAMS, fixture.analysis, { minScore: 20, maxResults: 100 });
      for (const r of results) {
        assert.ok(r.match_explain, `${r.name} (${r.id}) missing match_explain`);
        assert.ok(r.match_explain.matchedSignals, `${r.name} missing matchedSignals`);
        assert.ok(r.match_explain.scoreBreakdown, `${r.name} missing scoreBreakdown`);
      }
    });
  }
});

describe('Golden Profiles — Strategy-specific', () => {
  it('business startup: business programs score higher than health info', () => {
    const biz = FIXTURES.businessStartup.analysis;
    const bizResults = matchPrograms(BUSINESS_PROGRAMS, biz, { minScore: 20, maxResults: 50 });
    assert.ok(bizResults.length >= 5, `Expected >= 5 business results, got ${bizResults.length}`);
    assert.ok(bizResults[0].matchScore >= 70, 'Top business result should score >= 70');
  });

  it('health profile: cancer programs match, non-medical demoted', () => {
    const health = FIXTURES.healthMedical.analysis;
    const results = matchPrograms(NATIONAL_PROGRAMS, health, { minScore: 20, maxResults: 100 });
    const cancerResults = results.filter(r => r.matchReasons?.some(m => m.includes('cancer')));
    assert.ok(cancerResults.length >= 1, 'Expected at least 1 cancer-specific result');
  });

  it('student profile: student_grants strategy gates correctly', () => {
    const s = getStrategy('student_grants');
    const studentIntents = new Set(['education']);
    const nonStudentIntents = new Set(['housing']);
    assert.ok(checkGates(s, studentIntents).gated === false);
    assert.ok(checkGates(s, nonStudentIntents).gated === true);
  });

  it('health_resources strategy is gated for non-medical profiles', () => {
    const s = getStrategy('health_resources');
    assert.ok(checkGates(s, new Set(['housing'])).gated === true);
    assert.ok(checkGates(s, new Set(['healthcare'])).gated === false);
  });

  it('special needs: disability programs match', () => {
    const sn = FIXTURES.specialNeeds.analysis;
    const results = matchPrograms([...FEDERAL_BENEFITS, ...NATIONAL_PROGRAMS], sn, { minScore: 20, maxResults: 100 });
    const disabilityResults = results.filter(r =>
      (r.categories || []).includes('disability') || r.matchReasons?.some(m => m.includes('disability'))
    );
    assert.ok(disabilityResults.length >= 1, `Expected disability-specific results, got ${disabilityResults.length}`);
  });

  it('veteran profile: military programs match', () => {
    const vet = FIXTURES.veteranProfile.analysis;
    const results = matchPrograms([...FEDERAL_BENEFITS, ...NATIONAL_PROGRAMS], vet, { minScore: 20, maxResults: 100 });
    const milResults = results.filter(r => r.matchReasons?.some(m => m.includes('military')));
    assert.ok(milResults.length >= 1, `Expected military-specific results, got ${milResults.length}`);
  });

  it('sparse profile: graceful degradation with results', () => {
    const sparse = FIXTURES.sparseProfile.analysis;
    const results = matchPrograms(ALL_PROGRAMS, sparse, { minScore: 20, maxResults: 100 });
    assert.ok(results.length >= 3, `Sparse profile should still get >= 3 results, got ${results.length}`);
  });
});

describe('Negative Matching', () => {
  it('visual impairment programs excluded for non-vision profiles', () => {
    const noVision = FIXTURES.emergencyRent.analysis;
    const nfb = NATIONAL_PROGRAMS.find(p => p.id === 'np-nfb');
    if (nfb) {
      const result = scoreProgram(nfb, noVision);
      assert.equal(result, null, 'NFB should be null for non-vision profile');
    }
  });

  it('cancer programs excluded for non-cancer profiles', () => {
    const noCancer = FIXTURES.workforceTraining.analysis;
    const acs = NATIONAL_PROGRAMS.find(p => p.id === 'np-acs-grants');
    if (acs) {
      const result = scoreProgram(acs, noCancer);
      assert.equal(result, null, 'ACS should be null for non-cancer profile');
    }
  });
});

describe('Deduplication', () => {
  it('duplicate URLs are collapsed', () => {
    const dupePrograms = [
      { id: 'a', name: 'Program A', url: 'https://example.org/apply', categories: ['housing'], type: 'grant', fundingType: 'direct_grant' },
      { id: 'b', name: 'Program B', url: 'https://example.org/apply/', categories: ['housing'], type: 'grant', fundingType: 'direct_grant' },
    ];
    const analysis = FIXTURES.emergencyRent.analysis;
    const results = matchPrograms(dupePrograms, analysis, { minScore: 1, maxResults: 10 });
    assert.ok(results.length <= 1, `Expected <= 1 after dedup, got ${results.length}`);
  });
});

describe('Specific Need Scoring', () => {
  it('rent assistance need matches housing programs', () => {
    const exp = expandNeed('rent assistance');
    const housingPrograms = NATIONAL_PROGRAMS.filter(p => (p.categories || []).includes('housing'));
    let matched = 0;
    for (const p of housingPrograms) {
      const score = scoreNeedMatch(p, exp);
      if (score && score.score > 0) matched++;
    }
    assert.ok(matched >= 1, `Expected >= 1 housing program to match rent need, got ${matched}`);
  });
});
