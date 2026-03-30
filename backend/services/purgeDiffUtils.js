export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenize(text) {
  const normalized = normalizeText(text)
  return normalized ? normalized.split(' ').filter(Boolean) : []
}

export function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a))
  const setB = new Set(tokenize(b))
  if (setA.size === 0 && setB.size === 0) return 1
  const intersection = [...setA].filter((token) => setB.has(token)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 1 : intersection / union
}

export function tokenDiffRatio(a, b) {
  return 1 - jaccardSimilarity(a, b)
}

export function jaroWinkler(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (left === right) return 1
  if (!left.length || !right.length) return 0

  const matchDistance = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0)
  const leftMatches = new Array(left.length).fill(false)
  const rightMatches = new Array(right.length).fill(false)

  let matches = 0
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, right.length)
    for (let j = start; j < end; j += 1) {
      if (rightMatches[j]) continue
      if (left[i] !== right[j]) continue
      leftMatches[i] = true
      rightMatches[j] = true
      matches += 1
      break
    }
  }

  if (matches === 0) return 0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < left.length; i += 1) {
    if (!leftMatches[i]) continue
    while (!rightMatches[k]) k += 1
    if (left[i] !== right[k]) transpositions += 1
    k += 1
  }

  const m = matches
  const jaro = ((m / left.length) + (m / right.length) + ((m - transpositions / 2) / m)) / 3

  let prefix = 0
  for (let i = 0; i < Math.min(4, left.length, right.length); i += 1) {
    if (left[i] !== right[i]) break
    prefix += 1
  }

  return jaro + prefix * 0.1 * (1 - jaro)
}
