import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extractBasicInformationHeuristics,
  extractOrganizationDetailsHeuristics,
} from '../../backend/services/documentIngestion.js'

// End-to-end test: feed the heuristics the *literal* extracted text of the Cleveland
// Blue Raiders Marching Band PDF (line numbering stripped) and confirm that the
// "Website Missing" and "/phone:" bugs are no longer reproducible.
//
// The text below is the verbatim content that pdf-parse extracts from
// Cleveland_Blue_Raiders_Marching_Band_Grantflow_Public_Info_Filled.pdf as of the
// user's report.
const PDF_TEXT = `X
Cleveland High School Blue Raider Marching Band (Cleveland High School / CCS)
jburton@clevelandschools.org; bpritchard@clevelandschools.org
(423) 478-1113
https://www.theclevelandband.org ; https://www.chsraiders.com/o/high-school
Prepared from public sources only; sensitive individual fields intentionally left blank.
Filled from public sources only; verify before submission.

-- 1 of 19 --

850 Raider Drive
Cleveland TN 37312
62-6000265 (CCS; verify) LAB4BVJDQ7U7 4ZY55
Public high school band program; part of Cleveland High School / Cleveland City Schools
Band budget not public; district budget docs public Public band staff: Jim Burton; additional staff verify
X
X
City ACFR/Single Audit public; latest FY verify
X
Evidence-based model not applicable/publicly identified for band profile.
Official district footer states FERPA adherence.
Filled from public sources only; verify before submission.

-- 2 of 19 --

Support and expand high-quality music education for Cleveland High School students through instruments, uniforms, repairs, transportation, competition/performance costs, color
guard/winterguard/percussion needs, clinicians, and fee assistance.
Award-winning public high school band program serving Cleveland, TN.

-- 18 of 19 --

Public Information Source Notes
Cleveland High School Blue Raider Marching Band / Grantflow Application
This PDF was filled from public information only. Items left blank or marked N/A were either not applicable to an organization/school-band profile,
not found in public sources, or require confirmation by an authorized school/district representative before submission.
Key public facts entered:
- Organization: Cleveland High School Blue Raider Marching Band; part of Cleveland High School / Cleveland City Schools.
- Address/phone: 850 Raider Drive, Cleveland, TN 37312; (423) 478-1113.
- Public school details: mascot Blue Raiders; colors Blue/White/Red; public school; enrollment listed by TSSAA as 1,792.
- Band contact: Jim Burton, Band / Director of Bands, jburton@clevelandschools.org.
- Federal profile entries for Cleveland City Schools: UEI LAB4BVJDQ7U7; CAGE 4ZY55; government entity; SAM registration dates need final
verification.
- EIN entry 62-6000265 is from a public Schedule I/Form 990 grant-recipient listing for Cleveland City Schools; verify with district finance before
using on a grant submission.
`

test('end-to-end: Cleveland Blue Raiders profile is parsed correctly', () => {
  const basic = extractBasicInformationHeuristics(PDF_TEXT)
  const org = extractOrganizationDetailsHeuristics(PDF_TEXT)

  // 1. The "Website Missing" bug: website MUST be populated.
  assert.equal(
    basic.website,
    'https://www.theclevelandband.org',
    'website must be extracted from contact-line URL',
  )
  assert.ok(basic.website.length > 0, 'website must not be empty (this is the "Website Missing" bug)')

  // 2. The "/phone:" address bug: address must NOT contain "phone:" junk.
  assert.equal(basic.address, '850 Raider Drive', 'street address must be "850 Raider Drive"')
  assert.ok(
    !/phone/i.test(basic.address),
    `address must not contain "/phone": got ${JSON.stringify(basic.address)}`,
  )

  // 3. City / state / zip are now extracted.
  assert.equal(basic.city, 'Cleveland')
  assert.equal(basic.state, 'TN')
  assert.equal(basic.zip, '37312')

  // 4. Contact info.
  assert.equal(basic.email, 'jburton@clevelandschools.org')
  assert.equal(basic.phone, '(423) 478-1113')
  assert.equal(basic.full_name, 'Cleveland High School Blue Raider Marching Band')

  // 5. Organization identifiers.
  assert.equal(org.ein, '62-6000265')
  assert.equal(org.uei, 'LAB4BVJDQ7U7')
  assert.equal(org.cage_code, '4ZY55')

  console.log('[cleveland-end-to-end] parsed values:', { basic, org })
})
