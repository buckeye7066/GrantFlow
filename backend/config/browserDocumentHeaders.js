// Shared public-document request identity for discovery and link verification.
// CRAWLER_BROWSER_HEADERS=0 disables browser document headers for both callers.
export const BROWSER_FETCH_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'cors',
});

export function browserHeadersEnabled() {
  return String(process.env.CRAWLER_BROWSER_HEADERS ?? '1').toLowerCase() !== '0';
}

