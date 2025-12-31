export function haversineDistanceMiles(lat1, lon1, lat2, lon2) {
  if (
    [lat1, lon1, lat2, lon2].some(
      (value) => typeof value !== 'number' || Number.isNaN(value),
    )
  ) {
    throw new Error('Invalid coordinates supplied to haversineDistanceMiles')
  }

  const toRadians = (value) => (value * Math.PI) / 180
  const earthRadiusMiles = 3958.8

  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return earthRadiusMiles * c
}
