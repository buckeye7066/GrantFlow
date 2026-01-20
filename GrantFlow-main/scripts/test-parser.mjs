#!/usr/bin/env node
/**
 * Test document parsing functionality
 */
import fs from 'fs/promises'
import parseDocument from '../backend/parser/index.js'

// Create test document content
const testDriversLicense = `
DRIVER LICENSE
STATE OF CALIFORNIA

NAME: SMITH, JANE MARIE
DOB: 02/14/2006
ADDRESS: 123 MAIN STREET
         LOS ANGELES, CA 90001

DL: D1234567
CLASS: C
EXPIRES: 02/14/2030
ISS: 02/14/2022
`

const testScholarshipLetter = `
Example Scholarship Foundation
456 Grant Avenue
San Francisco, CA 94102
Phone: 555-123-4567
Email: awards@examplescholarship.org

Dear Recipient,

Congratulations! We are pleased to inform you that you have been selected as a recipient of the Example Scholarship Foundation Award for 2024.

Award Amount: $5,000

This scholarship recognizes your outstanding academic achievement and commitment to community service. The award will be disbursed directly to your university to cover tuition and educational expenses.

Please contact us at the above address or phone number if you have any questions.

Sincerely,
Awards Committee
Example Scholarship Foundation
`

async function testParsing() {
  console.log('Testing document parsing...\n')
  
  // Test 1: Driver's License
  console.log('Test 1: Driver\'s License')
  console.log('=' .repeat(50))
  
  const dlBuffer = Buffer.from(testDriversLicense)
  const dlResult = await parseDocument(dlBuffer, {
    originalFilename: 'drivers-license.txt',
    mimeType: 'text/plain', // Would normally be PDF or image
  })
  
  console.log('Classification:', dlResult.classification)
  console.log('Detected type:', dlResult.docType)
  console.log('Extracted fields:', JSON.stringify(dlResult.extracted, null, 2))
  console.log('Patches:', JSON.stringify(dlResult.patches, null, 2))
  console.log('')
  
  // Test 2: Scholarship Letter
  console.log('Test 2: Scholarship Letter')
  console.log('=' .repeat(50))
  
  const slBuffer = Buffer.from(testScholarshipLetter)
  const slResult = await parseDocument(slBuffer, {
    originalFilename: 'scholarship-letter.txt',
    mimeType: 'text/plain', // Would normally be DOCX or PDF
  })
  
  console.log('Classification:', slResult.classification)
  console.log('Detected type:', slResult.docType)
  console.log('Extracted fields:', JSON.stringify(slResult.extracted, null, 2))
  console.log('Patches:', JSON.stringify(slResult.patches, null, 2))
  console.log('')
  
  // Test 3: Unknown document
  console.log('Test 3: Unknown Document')
  console.log('=' .repeat(50))
  
  const unknownDoc = `
  Meeting Notes - January 15, 2024
  
  Attendees: John Doe (john@example.com), Jane Smith
  
  Discussion points:
  - Project timeline for Q1 2024
  - Budget allocation: $10,000
  - Next meeting: February 1, 2024
  
  Contact: 555-987-6543
  `
  
  const unknownBuffer = Buffer.from(unknownDoc)
  const unknownResult = await parseDocument(unknownBuffer, {
    originalFilename: 'meeting-notes.txt',
    mimeType: 'text/plain',
  })
  
  console.log('Classification:', unknownResult.classification)
  console.log('Detected type:', unknownResult.docType)
  console.log('Extracted fields:', JSON.stringify(unknownResult.extracted, null, 2))
  console.log('')
  
  console.log('All tests completed!')
}

testParsing().catch(console.error)
