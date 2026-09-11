// SAM.gov's public key is capped per day. When it is spent the backend answers
// 503 federal_listings_quota_exhausted with retry_at, and the federal tab must say
// so instead of rendering "0 programs" as if the catalog were empty.
export const FEDERAL_QUOTA_ERROR_CODE = "federal_listings_quota_exhausted"

export function isFederalQuotaError(error) {
  return error?.errorCode === FEDERAL_QUOTA_ERROR_CODE || error?.details?.error === FEDERAL_QUOTA_ERROR_CODE
}

export function federalSearchErrorMessage(error) {
  if (!error) return null
  if (isFederalQuotaError(error)) {
    const retryAt = Date.parse(error?.details?.retry_at ?? "")
    const when = Number.isFinite(retryAt) ? ` It will be available again at ${new Date(retryAt).toLocaleString()}.` : ""
    return `The federal program catalog (SAM.gov) has reached its daily request limit.${when}`
  }
  return "Federal programs could not be loaded. Please try again."
}
