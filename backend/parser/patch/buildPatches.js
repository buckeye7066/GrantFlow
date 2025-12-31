function confidenceWrap(value, confidence = 0.75) {
  if (value == null || value === '') return null
  return { value, confidence }
}

export function buildPatches(type, extraction, document) {
  const profileSet = {}

  if (extraction?.profile) {
    for (const [key, value] of Object.entries(extraction.profile)) {
      if (key === 'license_number') continue
      const wrapped = confidenceWrap(value)
      if (wrapped) {
        profileSet[key] = wrapped
      }
    }
  }

  const funding = []
  if (Array.isArray(extraction?.funding_sources)) {
    for (const source of extraction.funding_sources) {
      const entry = {
        upsert_by: {},
        set: {},
      }
      if (source.name) {
        entry.upsert_by.name = source.name
      }
      if (source.address) {
        entry.set.address = confidenceWrap(
          [source.address.line1, source.address.line2, source.address.city && `${source.address.city}, ${source.address.state} ${source.address.zip}`]
            .filter(Boolean)
            .join(', '),
        )
        if (source.address.city) entry.set.city = confidenceWrap(source.address.city)
        if (source.address.state) entry.set.state = confidenceWrap(source.address.state)
        if (source.address.zip) entry.set.zip = confidenceWrap(source.address.zip)
      }
      if (source.contact) entry.set.phone = confidenceWrap(source.contact, 0.6)
      if (source.email) entry.set.email = confidenceWrap(source.email, 0.7)
      if (source.website) entry.set.website = confidenceWrap(source.website, 0.7)
      if (source.amount) entry.set.amount = confidenceWrap(source.amount, 0.6)
      if (source.deadline) entry.set.deadline = confidenceWrap(source.deadline, 0.6)

      if (Object.keys(entry.upsert_by).length || Object.keys(entry.set).length) {
        funding.push(entry)
      }
    }
  }

  return {
    docType: type,
    profile: Object.keys(profileSet).length ? { set: profileSet } : null,
    funding_sources: funding,
    document_id: document.id,
  }
}
