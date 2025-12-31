export function createPageUrl(pageName, params) {
  const basePath = `/${pageName.replace(/\s+/g, '')}`

  if (!params) {
    return basePath
  }

  const searchParams = new URLSearchParams()

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    searchParams.set(key, String(value))
  })

  const queryString = searchParams.toString()
  return queryString ? `${basePath}?${queryString}` : basePath
}