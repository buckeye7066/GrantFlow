import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThesis } from '../profileIntelligence.js';
import { plan } from '../planner.js';
import { getAdapter } from '../adapters/index.js';

const CASES = [
  {
    name: 'farmer from Iowa',
    profile: {
      id: 'farmer-ia',
      profile_type: 'farmer',
      location: { state: 'IA' },
      needs: ['farm equipment', 'agriculture operations'],
    },
    applicantTypes: ['farm'],
    needs: ['agriculture', 'equipment', 'operations'],
    selectedSources: ['usda_rd', 'sba_grants'],
  },
  {
    name: 'local political candidate in Pennsylvania',
    profile: {
      id: 'candidate-pa',
      profile_type: 'political_candidate',
      location: { state: 'PA' },
      needs: ['campaign finance compliance', 'campaign operations'],
    },
    applicantTypes: ['candidate'],
    needs: ['campaign', 'operations'],
    selectedSources: ['fec_candidate_resources', 'pa_campaign_finance'],
  },
  {
    name: 'county parks summer baseball program in Oregon',
    profile: {
      id: 'parks-or',
      profile_type: 'county_parks_recreation',
      location: { state: 'OR' },
      mission: 'summer public baseball program through county parks and recreation',
      needs: ['recreation equipment', 'youth sports program support'],
    },
    applicantTypes: ['government'],
    needs: ['recreation', 'equipment', 'programs'],
    selectedSources: ['oregon_parks_rec_grants', 'grants_gov'],
  },
  {
    name: 'volunteer fire department in Arizona',
    profile: {
      id: 'vfd-az',
      profile_type: 'volunteer_fire_department',
      location: { state: 'AZ' },
      needs: ['turnout gear', 'public safety equipment', 'emergency response'],
    },
    applicantTypes: ['vfd', 'government'],
    needs: ['equipment', 'public_safety', 'emergency'],
    selectedSources: ['fema_afg', 'dhs_grants', 'cops_grants'],
  },
  {
    name: 'United States Border Patrol',
    profile: {
      id: 'border-patrol',
      profile_type: 'border_patrol',
      location: { state: 'TX' },
      needs: ['public safety technology', 'law enforcement equipment'],
    },
    applicantTypes: ['law_enforcement', 'government'],
    needs: ['public_safety', 'technology', 'equipment'],
    selectedSources: ['dhs_grants', 'doj_grants', 'cops_grants'],
  },
  {
    name: 'minister of a small church in Florida',
    profile: {
      id: 'minister-fl',
      profile_type: 'minister',
      location: { state: 'FL' },
      mission: 'small church ministry serving families',
      needs: ['program support', 'building repair'],
    },
    applicantTypes: ['church', 'ministry', 'nonprofit'],
    needs: ['programs'],
    selectedSources: ['grants_gov', 'cof_locator'],
  },
  {
    name: 'single mom needing rent utility and food help in Maine',
    profile: {
      id: 'single-mom-me',
      profile_type: 'single_mom',
      location: { state: 'ME' },
      needs: ['rent help', 'utility assistance', 'food support'],
    },
    applicantTypes: ['family', 'individual'],
    needs: ['housing', 'energy', 'food'],
    selectedSources: ['benefits_gov', 'united_way_211'],
  },
  {
    name: 'school teacher needing classroom funding in Missouri',
    profile: {
      id: 'teacher-mo',
      profile_type: 'classroom_teacher',
      location: { state: 'MO' },
      needs: ['classroom supplies', 'books', 'technology'],
    },
    applicantTypes: ['teacher', 'individual'],
    needs: ['education', 'technology'],
    selectedSources: ['donorschoose'],
  },
  {
    name: 'attorney practice in North Dakota',
    profile: {
      id: 'attorney-nd',
      profile_type: 'attorney_practice',
      location: { state: 'ND' },
      needs: ['law practice operations', 'legal technology'],
    },
    applicantTypes: ['business'],
    needs: ['legal', 'operations', 'technology'],
    selectedSources: ['sba_grants'],
  },
  {
    name: 'Indian Tribe on a reservation in South Dakota',
    profile: {
      id: 'tribe-sd',
      profile_type: 'indian_tribe',
      location: { state: 'SD' },
      needs: ['tribal public safety', 'agriculture', 'community programs'],
    },
    applicantTypes: ['tribal', 'government'],
    needs: ['public_safety', 'agriculture', 'programs'],
    selectedSources: ['ana_grants', 'dhs_grants', 'doj_grants'],
  },
  {
    name: 'stage 4 breast cancer patient in South Carolina',
    profile: {
      id: 'cancer-sc',
      profile_type: 'breast_cancer_patient',
      location: { state: 'SC' },
      needs: ['stage 4 breast cancer treatment', 'rent help', 'utility assistance', 'food'],
    },
    applicantTypes: ['individual'],
    needs: ['medical', 'housing', 'energy', 'food'],
    selectedSources: ['cancer_care', 'benefits_gov', 'united_way_211'],
  },
  {
    name: 'coal miner widow in Kentucky with dementia',
    profile: {
      id: 'miner-widow-ky',
      profile_type: 'coal_miner_widow',
      location: { state: 'KY' },
      description: 'Coal miner widow in Kentucky with dementia who needs local support.',
      needs: ['black lung survivor benefits', 'dementia care', 'food assistance'],
    },
    applicantTypes: ['family', 'individual'],
    needs: ['black_lung_benefits', 'survivor_benefits', 'dementia_support', 'caregiving', 'medical', 'food'],
    selectedSources: ['dol_black_lung_benefits', 'ssa_survivors', 'alzheimers_gov_services', 'kynect_benefits', 'benefits_gov', 'united_way_211'],
    notSelectedSources: ['cancer_care'],
  },
  {
    name: 'military-background individual starting a food truck in West Virginia',
    profile: {
      id: 'food-truck-wv',
      profile_type: 'individual',
      location: { state: 'WV' },
      description: 'Single guy with a military background wants to start a food truck in West Virginia.',
      needs: ['food truck startup', 'kitchen equipment', 'working capital'],
    },
    applicantTypes: ['individual'],
    needs: ['startup', 'equipment', 'capital', 'veteran_startup'],
    selectedSources: ['sba_veteran_business', 'sba_vboc', 'wv_sbdc_funding', 'wv_business_funding_resources'],
    notNeeds: ['food', 'veterans'],
    notSelectedSources: ['benefits_gov', 'united_way_211'],
  },
];

for (const c of CASES) {
  test(`universal profile coverage: ${c.name}`, () => {
    const thesis = buildThesis(c.profile);
    const sourcePlan = plan(thesis);

    for (const applicantType of c.applicantTypes) {
      assert.ok(
        thesis.applicant_types.includes(applicantType),
        `${c.name} should include applicant type ${applicantType}; got ${thesis.applicant_types.join(', ')}`,
      );
    }

    for (const need of c.needs) {
      assert.ok(
        thesis.needs.includes(need),
        `${c.name} should include need ${need}; got ${thesis.needs.join(', ')}`,
      );
    }

    for (const need of c.notNeeds ?? []) {
      assert.ok(
        !thesis.needs.includes(need),
        `${c.name} should not include need ${need}; got ${thesis.needs.join(', ')}`,
      );
    }

    for (const sourceId of c.selectedSources) {
      assert.ok(
        sourcePlan.selected_source_ids.includes(sourceId),
        `${c.name} should select ${sourceId}; got ${sourcePlan.selected_source_ids.join(', ')}`,
      );
      assert.ok(getAdapter(sourceId), `${sourceId} must have an implemented adapter`);
    }

    for (const sourceId of c.notSelectedSources ?? []) {
      assert.ok(
        !sourcePlan.selected_source_ids.includes(sourceId),
        `${c.name} should not select ${sourceId}; got ${sourcePlan.selected_source_ids.join(', ')}`,
      );
    }
  });
}
