const DRIVER_KEYWORDS = [
  'driver license',
  'driver\'s license',
  'dl number',
  'date of birth',
  'dob',
  'license',
  'state',
  'class',
  'sex',
]

const SCHOLARSHIP_KEYWORDS = [
  'scholarship',
  'award',
  'grant',
  'recipient',
  'congratulations',
  'selection committee',
  'financial aid',
  'application',
  'tuition',
]

function score(text, keywords) {
  let matches = 0
  for (const keyword of keywords) {
    const regex = new RegExp(keyword, 'i')
    if (regex.test(text)) {
      matches += 1
    }
  }
  return matches / keywords.length
}

export function classifyContent(text = '') {
  const driverScore = score(text, DRIVER_KEYWORDS)
  const scholarshipScore = score(text, SCHOLARSHIP_KEYWORDS)

  if (driverScore > 0.3 && driverScore > scholarshipScore) {
    return { type: 'drivers_license', confidence: driverScore }
  }
  if (scholarshipScore > 0.25) {
    return { type: 'scholarship_letter', confidence: scholarshipScore }
  }
  return { type: 'unknown', confidence: 0.1 }
}
