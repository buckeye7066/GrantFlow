const CITY_STATE_ZIP_REGEX =
  /([A-Z][A-Za-z\s]+),?\s+([A-Z]{2})\s+([0-9]{5}(?:-[0-9]{4})?)/i

export function parseAddress(lines = []) {
  if (!Array.isArray(lines) || lines.length === 0) return null

  let line1 = null
  let line2 = null
  let city = null
  let state = null
  let zip = null

  for (let i = 0; i < lines.length; i += 1) {
    const part = lines[i]
    const match = part.match(CITY_STATE_ZIP_REGEX)
    if (match) {
      city = match[1].trim()
      state = match[2].toUpperCase()
      zip = match[3]
      line1 = lines[i - 1] ? lines[i - 1] : null
      line2 = lines[i + 1] && !CITY_STATE_ZIP_REGEX.test(lines[i + 1])
        ? lines[i + 1]
        : null
      break
    }
  }

  if (!city && lines.length >= 2) {
    line1 = lines[0]
    line2 = lines[1]
  }

  return {
    line1,
    line2,
    city,
    state,
    zip,
  }
}
