/**
 * Build patch suggestions from extracted data
 */
export function buildPatches(extractedData, docType) {
  const patches = {
    profile: {
      set: {},
    },
    funding_sources: [],
  }
  
  if (docType === 'drivers_license') {
    // Map driver's license fields to profile fields
    if (extractedData.full_name) {
      patches.profile.set.full_name = extractedData.full_name
    }
    if (extractedData.dob) {
      patches.profile.set.dob = extractedData.dob
    }
    if (extractedData.address_line1) {
      patches.profile.set.address_line1 = extractedData.address_line1
    }
    if (extractedData.city) {
      patches.profile.set.city = extractedData.city
    }
    if (extractedData.state) {
      patches.profile.set.state = extractedData.state
    }
    if (extractedData.zip) {
      patches.profile.set.zip = extractedData.zip
    }
  }
  
  if (docType === 'scholarship_letter') {
    // Map scholarship letter fields to funding source
    const fundingSourcePatch = {
      upsert_by: {},
      set: {},
    }
    
    if (extractedData.funding_source_name) {
      fundingSourcePatch.upsert_by.name = extractedData.funding_source_name.value
    }
    
    if (extractedData.contact_email) {
      fundingSourcePatch.set.contact_email = extractedData.contact_email
    }
    
    if (extractedData.contact_phone) {
      fundingSourcePatch.set.contact_phone = extractedData.contact_phone
    }
    
    if (extractedData.address) {
      fundingSourcePatch.set.address = extractedData.address
    }
    
    if (extractedData.award_amount) {
      fundingSourcePatch.set.award_amount = extractedData.award_amount
    }
    
    // Only add if we have something to upsert by
    if (Object.keys(fundingSourcePatch.upsert_by).length > 0) {
      patches.funding_sources.push(fundingSourcePatch)
    }
  }
  
  return patches
}

export default buildPatches
