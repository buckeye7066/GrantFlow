import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectReadinessPlan, renderProjectPlanDocument } from '../projectReadinessPlan.js';

test('food truck plan uses parsed profile documents without assuming veteran status', () => {
  const plan = buildProjectReadinessPlan({
    id: 'food-truck-wv',
    profile_type: 'individual',
    display_name: 'Mountain Route Kitchen',
    location: { city: 'Charleston', state: 'WV' },
    description: 'Wants to start a mobile food business.',
    documents: [
      {
        id: 'doc-1',
        name: 'permit-screenshot.png',
        mime_type: 'image/png',
        processing_status: 'completed',
        extracted_text: 'Active duty service member. Food truck startup notes: health permit, commissary agreement, generator, refrigeration, POS.',
      },
    ],
  });

  assert.equal(plan.plan_id, 'food_truck_startup');
  assert.ok(plan.military_statuses.includes('active_duty'));
  assert.ok(!plan.military_statuses.includes('veteran'));
  assert.equal(plan.document_evidence.length, 1);
  assert.equal(plan.checklist.find((item) => item.id === 'business_location')?.status, 'known');
  assert.equal(plan.checklist.find((item) => item.id === 'permits_licenses')?.status, 'known');
  assert.equal(plan.checklist.find((item) => item.id === 'truck_equipment')?.status, 'known');
  assert.ok(plan.interview_questions.some((q) => q.id === 'business_identity'), 'missing legal structure should still be asked');
});

test('business plan asks for official uploads instead of typed sensitive identifiers', () => {
  const plan = buildProjectReadinessPlan({
    id: 'food-truck-docs',
    profile_type: 'business',
    display_name: 'River Road Tacos LLC',
    description: 'Launching a food truck and applying for startup funding.',
    sections: [
      {
        section_key: 'small_business_details',
        data: {
          business_name: 'River Road Tacos LLC',
          legal_structure: 'LLC',
          equipment_needed: 'truck, refrigeration, generator',
        },
      },
    ],
    documents: [
      {
        id: 'doc-license',
        name: 'business-license.pdf',
        mime_type: 'application/pdf',
        processing_status: 'completed',
        extracted_text: 'Business license and vendor permit for River Road Tacos LLC.',
      },
    ],
  });

  const taxDoc = plan.checklist.find((item) => item.id === 'tax_identifier_document_upload');
  const businessDocs = plan.checklist.find((item) => item.id === 'business_formation_documents_upload');

  assert.ok(taxDoc, 'business/startup plans should request tax or registration proof uploads');
  assert.match(taxDoc.question, /upload/i);
  assert.doesNotMatch(taxDoc.question, /type .*tax|enter .*tax|paste .*tax/i);
  assert.ok(businessDocs, 'business/startup plans should request formation/license/quote uploads');
  assert.equal(businessDocs.status, 'known');
});

test('student plan includes work-study and campus job portal readiness', () => {
  const plan = buildProjectReadinessPlan({
    id: 'student-osu',
    profile_type: 'student',
    sections: [
      { section_key: 'education', data: { school_name: 'Ohio State University', field_of_study: 'nursing' } },
      { section_key: 'financial_aid', data: { fafsa_status: 'submitted', work_study_interest: true } },
    ],
  });

  assert.equal(plan.plan_id, 'student_portal_plan');
  const workStudy = plan.checklist.find((item) => item.id === 'work_study_jobs');
  assert.ok(workStudy, 'work-study checklist item should exist');
  assert.equal(workStudy.status, 'known');
  assert.match(workStudy.question, /campus job portal/i);
  assert.ok(plan.checklist.some((item) => item.id === 'school_portals'));
  assert.ok(plan.checklist.some((item) => item.id === 'student_official_records_upload'));
});

test('empty profile becomes an Anya interview, not a penalty or crash', () => {
  const plan = buildProjectReadinessPlan({ id: 'empty-profile' });

  assert.equal(plan.plan_id, 'general_funding_readiness');
  assert.ok(Array.isArray(plan.checklist));
  assert.ok(plan.checklist.length > 0);
  assert.ok(plan.interview_questions.length > 0);
  assert.ok(plan.interview_questions.every((q) => q.prompt && q.why));

  const rendered = renderProjectPlanDocument(plan);
  assert.match(rendered, /Anya interview/);
  assert.match(rendered, /Hamilton guardrails/);
});
