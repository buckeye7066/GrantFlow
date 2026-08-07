import fs from 'node:fs'

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, 'utf8')
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`${path}: expected source block not found`)
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`${path}: expected source block is not unique`)
  }
  fs.writeFileSync(path, source.replace(before, after))
}

replaceOnce(
  'backend/services/nationalPrograms/fetcher.js',
  "import fetch from 'node-fetch'\n",
  '',
)
replaceOnce(
  'backend/services/nationalPrograms/fetcher.js',
  "          fetchImpl: fetch,\n",
  '',
)

replaceOnce(
  'backend/services/linkVerificationService.js',
  "import { safeFetch, SsrfBlockedError } from './http/safeFetch.js'",
  "import { safeFetch, discardResponseBody, SsrfBlockedError } from './http/safeFetch.js'",
)
replaceOnce(
  'backend/services/linkVerificationService.js',
  `      const finalUrl = res.grantflowFinalUrl
        || (typeof res.url === 'string' && res.url ? res.url : url)
      return { code: res.status, error: null, finalUrl, ssrfBlocked: false }`,
  `      const finalUrl = res.grantflowFinalUrl
        || (typeof res.url === 'string' && res.url ? res.url : url)
      const code = res.status
      await discardResponseBody(res)
      return { code, error: null, finalUrl, ssrfBlocked: false }`,
)

replaceOnce(
  'backend/services/housingScholarshipCrawler.js',
  "import { safeFetch, SsrfBlockedError } from './http/safeFetch.js'",
  "import { safeFetch, discardResponseBody, SsrfBlockedError } from './http/safeFetch.js'",
)
replaceOnce(
  'backend/services/housingScholarshipCrawler.js',
  `    // 200, 301, 302, 405 (HEAD not allowed but server exists) all count as live
    return res.status < 400 || res.status === 405`,
  `    // 200, 301, 302, 405 (HEAD not allowed but server exists) all count as live
    const status = res.status
    await discardResponseBody(res)
    return status < 400 || status === 405`,
)
replaceOnce(
  'backend/services/housingScholarshipCrawler.js',
  `      const res2 = await safeFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'GrantFlow Housing Crawler/1.0' },
      }, { timeoutMs })
      return res2.status < 400`,
  `      const res2 = await safeFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'GrantFlow Housing Crawler/1.0' },
      }, { timeoutMs })
      const status = res2.status
      await discardResponseBody(res2)
      return status < 400`,
)

console.log('Applied PR #1173 review wiring fixes')
