import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGrantsGovDigest } from '../../backend/services/grantsGovDigestParser.js'

const SAMPLE_DIGEST = `The following grant opportunities were created, updated, or deleted on Grants.gov:

DOS
Department of State
U.S. Mission to Belgium
Launching the Next 250 Years of American and European Innovation and Growth
Synopsis 1
https://www.grants.gov/search-results-detail/362469



HHS
Department of Health and Human Services
Substance Abuse and Mental Health Services Admin
Recovery Community Services Program
Forecast 1
https://www.grants.gov/search-results-detail/362468



USDA
Department of Agriculture
National Institute of Food and Agriculture
Crop Protection and Pest Management
Synopsis 1
https://www.grants.gov/search-results-detail/362471



DOI
Department of the Interior
Fish and Wildlife Service
F26AS00069 Coastal Program FY26
Synopsis 1
https://www.grants.gov/search-results-detail/362470



HHS
Department of Health and Human Services
Substance Abuse and Mental Health Services Admin
Behavioral Health and Community Safety Partnerships
Forecast 1
https://www.grants.gov/search-results-detail/362466



HHS
Department of Health and Human Services
National Institutes of Health
Limited Competition: Superfund Hazardous Substance Research and Training Program (P42 Clinical Trial Optional)
Synopsis 1
https://www.grants.gov/search-results-detail/359650



DOT
Department of Transportation
DOT Federal Highway Administration
Reduction of Truck Emissions at Port Facilities Competitive Grants Program
Synopsis 1
https://www.grants.gov/search-results-detail/362477



DOT
Department of Transportation
FAA - Aviation Next Gen
FAA Aircraft Pilots Workforce Development Grant Program
Synopsis 3
https://www.grants.gov/search-results-detail/362476



USDA
Department of Agriculture
National Institute of Food and Agriculture
New Beginning for Tribal Students Program
Synopsis 1
https://www.grants.gov/search-results-detail/362479



HHS
Department of Health and Human Services
National Institutes of Health
Using Archived Data and Specimen Collections to Advance Maternal and Pediatric HIV/AIDS Research (R21 CT Not Allowed)
Synopsis 1
https://www.grants.gov/search-results-detail/359945



DOT
Department of Transportation
FAA - Aviation Next Gen
FAA Aviation Maintenance Technical Workers Workforce
Synopsis 3
https://www.grants.gov/search-results-detail/362475



DOI
Department of the Interior
National Park Service
FY2025 Historic Preservation Fund - Tribal Heritage Grants
Synopsis 1
https://www.grants.gov/search-results-detail/362474



DOI
Department of the Interior
Fish and Wildlife Service
F25AS00332 Highlands Conservation Act – Competitive Funding Round
Synopsis 1
https://www.grants.gov/search-results-detail/362484



HHS
Department of Health and Human Services
National Institutes of Health
HeartShare 2.0: Refining Heart Failure Subtypes and Treatment Targets for Personalized Clinical Trials - Clinical Trial Center and Clinical Centers (U01 Clinical Trial Optional)
Synopsis 2
https://www.grants.gov/search-results-detail/360439



HHS
Department of Health and Human Services
National Institutes of Health
Accelerating Discovery through Partnered Research with All of Us to Analyze Participant Biospecimens (X01 Clinical Trial Not Allowed)
Synopsis 1
https://www.grants.gov/search-results-detail/361104



DOI
Department of the Interior
Fish and Wildlife Service
F25AS00379 Highlands Conservation Act - Base Funding Round
Synopsis 1
https://www.grants.gov/search-results-detail/362480



HHS
Department of Health and Human Services
Indian Health Service
Phase 2 Produce Prescription Pilot Program
Synopsis 1
https://www.grants.gov/search-results-detail/362483



DOS
Department of State
U.S. Mission to Kuwait
U.S. Embassy Kuwait PAS Annual Program Statement
Synopsis 7
https://www.grants.gov/search-results-detail/362429



HHS
Department of Health and Human Services
National Institutes of Health
Single Source: HeartShare 2.0: Refining Heart Failure Subtypes and Treatment Targets for Personalized Clinical Trials - Data Translation Center (U54 Clinical Trial Optional)
Synopsis 2
https://www.grants.gov/search-results-detail/360444



HHS
Department of Health and Human Services
Centers for Disease Control - NCEZID
Increasing awareness and knowledge of Alpha-gal Syndrome in the United States
Synopsis 1
https://www.grants.gov/search-results-detail/360958



HHS
Department of Health and Human Services
National Institutes of Health
HEAL INITIATIVE: INTERACT Data Coordination and Integration Center (U24 Clinical Trial Not Allowed)
Synopsis 1
https://www.grants.gov/search-results-detail/358939`

test('parseGrantsGovDigest extracts all Grants.gov URLs from email digest', () => {
  const result = parseGrantsGovDigest(SAMPLE_DIGEST)
  assert.equal(result.total_urls, 21)
  assert.equal(result.opportunities.length, 21)
  assert.equal(result.parse_errors.length, 0)
})

test('parseGrantsGovDigest maps agency, title, notice type, and URL', () => {
  const result = parseGrantsGovDigest(SAMPLE_DIGEST)
  const first = result.opportunities[0]
  assert.equal(first.agency_acronym, 'DOS')
  assert.equal(first.department, 'Department of State')
  assert.equal(first.sub_agency, 'U.S. Mission to Belgium')
  assert.match(first.title, /Launching the Next 250 Years/)
  assert.equal(first.notice_type, 'synopsis')
  assert.equal(first.notice_number, 1)
  assert.equal(first.opportunity_id, '362469')
  assert.equal(first.application_url, 'https://www.grants.gov/search-results-detail/362469')
  assert.equal(first.source, 'grants.gov')
  assert.equal(first.record_origin, 'url_import')
})

test('parseGrantsGovDigest handles forecast notices', () => {
  const result = parseGrantsGovDigest(SAMPLE_DIGEST)
  const forecast = result.opportunities.find((opp) => opp.opportunity_id === '362468')
  assert.ok(forecast)
  assert.equal(forecast.notice_type, 'forecast')
  assert.equal(forecast.notice_number, 1)
})

test('parseGrantsGovDigest returns helpful error when no URLs found', () => {
  const result = parseGrantsGovDigest('No grants here')
  assert.equal(result.opportunities.length, 0)
  assert.ok(result.parse_errors[0].includes('No Grants.gov detail URLs'))
})
