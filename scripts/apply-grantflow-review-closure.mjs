import fs from 'node:fs'

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.writeFileSync(file, content)
  console.log(`updated ${file}`)
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`Missing source block for ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected one source block for ${label}`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`Missing start marker for ${label}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`Missing end marker for ${label}`)
  return source.slice(0, start) + replacement + source.slice(end)
}

function replaceTest(source, title, nextTitle, replacement) {
  const startMarker = `  it('${title}'`
  const endMarker = `\n\n  it('${nextTitle}'`
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`Missing test: ${title}`)
  const end = source.indexOf(endMarker, start)
  if (end < 0) throw new Error(`Missing next test after: ${title}`)
  return source.slice(0, start) + replacement + source.slice(end)
}

// ---------------------------------------------------------------------------
// 1. Strict IPv6 parsing and mapped-address SSRF protection.
// ---------------------------------------------------------------------------
{
  const file = 'backend/config/urlRules.js'
  let source = read(file)
  if (!source.startsWith("import net from 'node:net'")) {
    source = `import net from 'node:net'\n\n${source}`
  }

  const replacement = `function parseIpv4Octets(value) {
  const parts = String(value || '').split('.')
  if (parts.length !== 4) return null
  if (parts.some((part) => !/^\\d{1,3}$/.test(part))) return null
  const octets = parts.map(Number)
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null
}

function ipv4OctetsArePrivate(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return true
  const [a, b] = octets
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function expandStrictIpv6(value) {
  let address = String(value || '').toLowerCase()
  if (net.isIP(address) !== 6) return null

  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':')
    const octets = parseIpv4Octets(address.slice(lastColon + 1))
    if (!octets) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    address = address.slice(0, lastColon) + ':' + high + ':' + low
  }

  const halves = address.split('::')
  if (halves.length > 2) return null
  const parseHalf = (half) => {
    if (!half) return []
    const parts = half.split(':')
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
    return parts.map((part) => Number.parseInt(part, 16))
  }
  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] || '')
  if (!left || !right) return null

  if (halves.length === 1) return left.length === 8 ? left : null
  const zeroCount = 8 - left.length - right.length
  if (zeroCount < 1) return null
  return [...left, ...Array(zeroCount).fill(0), ...right]
}

export function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true
  const scoped = ip.trim().toLowerCase().split('%')[0]

  if (net.isIP(scoped) === 4) {
    const octets = parseIpv4Octets(scoped)
    return !octets || ipv4OctetsArePrivate(octets)
  }
  if (net.isIP(scoped) !== 6) return true

  const words = expandStrictIpv6(scoped)
  if (!words || words.length !== 8) return true

  const allZero = words.every((word) => word === 0)
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1
  if (allZero || loopback) return true

  const first = words[0]
  if ((first & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((first & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfec0) return true // deprecated site-local fec0::/10
  if ((first & 0xff00) === 0xff00) return true // multicast ff00::/8

  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const compatible = words.slice(0, 6).every((word) => word === 0)
  if (mapped || compatible) {
    const embedded = [
      (words[6] >> 8) & 0xff,
      words[6] & 0xff,
      (words[7] >> 8) & 0xff,
      words[7] & 0xff,
    ]
    return ipv4OctetsArePrivate(embedded)
  }

  return false
}
`

  source = replaceSection(
    source,
    'export function isPrivateIp(ip) {',
    '\n\n/**\n * SSRF gate for outbound fetches against untrusted/ingested URLs.',
    replacement,
    'isPrivateIp strict implementation',
  )
  write(file, source)
}

{
  const file = 'backend/tests/safeFetchSsrf.test.js'
  let source = read(file)
  const before = `  it.each(['fc00::1', 'fdff::1'])(
    'continues to block unique-local IPv6 address %s',
    (address) => {
      expect(isPrivateIp(address)).toBe(true)
    },
  )
})`
  const after = `  it.each(['fc00::1', 'fdff::1'])(
    'continues to block unique-local IPv6 address %s',
    (address) => {
      expect(isPrivateIp(address)).toBe(true)
    },
  )

  it.each(['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0'])(
    'blocks expanded loopback or unspecified IPv6 address %s',
    (address) => {
      expect(isPrivateIp(address)).toBe(true)
    },
  )

  it.each(['::ffff:7f00:1', '::ffff:c0a8:1', '::ffff:192.168.0.1'])(
    'blocks IPv4-mapped private IPv6 address %s',
    (address) => {
      expect(isPrivateIp(address)).toBe(true)
    },
  )

  it.each(['2001z::1', '2001:db8::gg'])(
    'fails closed for malformed IPv6 literal %s',
    (address) => {
      expect(isPrivateIp(address)).toBe(true)
    },
  )

  it.each(['2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows a valid public address %s',
    (address) => {
      expect(isPrivateIp(address)).toBe(false)
    },
  )

  it('blocks an IPv4-mapped hexadecimal loopback returned by DNS', async () => {
    const fetchMock = vi.fn()
    const resolve = vi.fn().mockResolvedValue([
      { address: '::ffff:7f00:1', family: 6 },
    ])

    await expect(safeFetch('https://mapped-loopback.example/', {}, { fetchImpl: fetchMock, resolve }))
      .rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})`
  source = replaceOnce(source, before, after, 'IPv6 SSRF regressions')
  write(file, source)
}

// ---------------------------------------------------------------------------
// 2. Keep full profile context for internal matching and minimize only outbound
//    web search context.
// ---------------------------------------------------------------------------
{
  const file = 'backend/services/itemNeedSearch.js'
  let source = read(file)
  source = replaceOnce(
    source,
    `export async function searchItemNeed(db, {
  profileId,
  item,
  profileContext = null,
  variant = 'funding',`,
    `export async function searchItemNeed(db, {
  profileId,
  item,
  profileContext = null,
  externalSearchContext = null,
  variant = 'funding',`,
    'searchItemNeed external context option',
  )
  source = replaceOnce(
    source,
    `      profileContext: profileContext ?? {},
      variant: variant === 'gift' ? 'gift' : 'funding',`,
    `      profileContext: externalSearchContext ?? profileContext ?? {},
      variant: variant === 'gift' ? 'gift' : 'funding',`,
    'web lane minimized context',
  )
  source = replaceOnce(
    source,
    `export async function searchItemNeeds(db, {
  profileId,
  items,
  profileContext = null,
  variant = 'funding',`,
    `export async function searchItemNeeds(db, {
  profileId,
  items,
  profileContext = null,
  externalSearchContext = null,
  variant = 'funding',`,
    'searchItemNeeds external context option',
  )
  source = replaceOnce(
    source,
    `      results.push(await searchItemNeed(db, { profileId, item, profileContext, variant, timeoutMs }))`,
    `      results.push(await searchItemNeed(db, {
        profileId,
        item,
        profileContext,
        externalSearchContext,
        variant,
        timeoutMs,
      }))`,
    'forward external context',
  )
  write(file, source)
}

{
  const file = 'backend/services/greenHomeNoCostSearch.js'
  let source = read(file)
  source = replaceOnce(
    source,
    `    profileContext: outboundSearchContext,
    variant: 'funding',`,
    `    profileContext: profileContext || {},
    externalSearchContext: outboundSearchContext,
    variant: 'funding',`,
    'green-home full internal context',
  )

  const before = `      const persisted = result?.id ? verification.byId.get(String(result.id)) : null
      const enriched = persisted
        ? {
            ...result,
            ...persisted,
            result_source: result.result_source,
            url: persisted.final_url || persisted.application_url || persisted.source_url || result.url,
          }
        : result

      if (persisted && result.result_source === 'catalog') {`
  const after = `      const isCatalogResult = result.result_source === 'catalog'
      const persisted = result?.id ? verification.byId.get(String(result.id)) : null
      if (isCatalogResult && !persisted) {
        addCandidate(review, result, {
          status: 'review',
          reason: 'catalog_verification_unavailable',
          source_trust: null,
        }, itemReport.item)
        continue
      }

      const enriched = persisted
        ? {
            ...result,
            ...persisted,
            result_source: result.result_source,
            url: persisted.final_url || persisted.application_url || persisted.source_url || result.url,
          }
        : result

      if (isCatalogResult) {`
  source = replaceOnce(source, before, after, 'catalog rehydration fail-closed')
  write(file, source)
}

{
  const file = 'backend/tests/greenHomeNoCostSearch.test.js'
  let source = read(file)
  source = replaceOnce(
    source,
    `}

describe('searchGreenHomeNoCostPrograms', () => {`,
    `}

function verificationDb(rows) {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn().mockResolvedValue(rows),
    })),
  }
}

describe('searchGreenHomeNoCostPrograms', () => {`,
    'verification DB helper',
  )

  source = replaceTest(
    source,
    'shows only proven no-cost paths and keeps LIHEAP as review-only',
    'rejects organization profiles before household locators or external search are added',
    `  it('shows only proven no-cost paths and keeps LIHEAP as review-only', async () => {
    const direct = trustedCatalog()
    const taxCredit = trustedCatalog({
      id: 'tax-credit',
      title: 'Residential clean energy tax credit',
      description: 'Tax credit for purchasing rooftop solar panels.',
    })
    const unknownCost = trustedCatalog({
      id: 'unknown-cost',
      title: 'Heat pump assistance program',
      description: 'Heat pump assistance may be available. Contact the provider for cost terms.',
    })
    const searchItemNeedsImpl = vi.fn().mockResolvedValue(reportWith([
      direct,
      taxCredit,
      unknownCost,
      {
        id: 'unknown-web',
        title: 'Free residential wind installation',
        description: 'Free small wind installation for selected homeowners.',
        url: 'https://unknown.example/wind',
        result_source: 'web_search',
        need_score: 70,
      },
    ]))

    const privateContext = {
      profile: {
        id: 'profile-1',
        display_name: 'Private Household Name',
        primary_email: 'private@example.com',
        street_address: '123 Private Lane',
        state: 'TN',
        exact_income: 12345,
        disability_diagnosis: 'private diagnosis',
        veteran_service_number: 'private veteran identifier',
        is_homeowner: true,
        primary_type: 'family',
      },
      sections: { documents: { uploaded_text: 'private uploaded document content' } },
    }
    const computeMatchDecisionImpl = vi.fn(() => ({
      decision: 'ACCEPT',
      score: 92,
      explanation: 'full profile accepted',
      matcher_version: 'test-full-profile',
    }))

    const result = await searchGreenHomeNoCostPrograms(
      verificationDb([direct, taxCredit, unknownCost]),
      {
        profileId: 'profile-1',
        profileContext: privateContext,
        now: NOW,
        searchItemNeedsImpl,
        officialGreenHomePathsImpl: officialGreenHomePaths,
        computeMatchDecisionImpl,
      },
    )

    const searchOptions = searchItemNeedsImpl.mock.calls[0][1]
    expect(searchOptions.profileContext).toBe(privateContext)
    expect(searchOptions.externalSearchContext).toEqual({
      profile: { primary_type: 'family', state: 'TN' },
      signals: { entityType: 'family', location: { state: 'TN' } },
    })
    expect(JSON.stringify(searchOptions.externalSearchContext)).not.toMatch(
      /Private Household|private@example|Private Lane|12345|diagnosis|veteran identifier|uploaded document/i,
    )
    expect(result.programs.map((program) => program.id)).toEqual([
      'doe-weatherization-assistance',
      'direct-install',
    ])
    expect(result.review_reasons).toEqual(expect.arrayContaining([
      { reason: 'no_cost_not_proven', count: 2 },
      { reason: 'source_not_yet_verified', count: 1 },
    ]))
    expect(result.excluded_reasons).toContainEqual({ reason: 'tax_credit', count: 1 })
    expect(result.search_coverage).toMatchObject({
      searched_items: 1,
      catalog_verification_requested: 3,
      catalog_verification_enriched: 3,
      catalog_full_profile_rechecks: 3,
    })
    expect(computeMatchDecisionImpl).toHaveBeenCalledTimes(3)
    expect(result.search_privacy).toMatchObject({
      sensitive_fields_transmitted: false,
      catalog_matching_context: 'full_server_side_profile_recheck',
    })
  })`,
  )

  source = replaceTest(
    source,
    'deduplicates the same source and ranks an official locator first',
    'exposes catalog metadata-query failure as partial coverage',
    `  it('deduplicates the same source and ranks an official locator first', async () => {
    const shared = trustedCatalog({
      id: 'shared',
      title: 'Free weatherization and heat-pump installation',
      description: 'A no-cost program for qualifying households.',
      source_url: 'https://energy.example.gov/free-upgrades?utm_source=test',
    })
    const result = await searchGreenHomeNoCostPrograms(verificationDb([shared]), {
      profileId: 'profile-1',
      profileContext: { profile: { primary_type: 'family', state: 'TN' } },
      now: NOW,
      searchItemNeedsImpl: async () => ({
        items: [
          { item: 'weatherization', results: [{ ...shared, need_score: 25 }], lanes: {} },
          { item: 'heat pump', results: [{ ...shared, source_url: 'https://energy.example.gov/free-upgrades', need_score: 45 }], lanes: {} },
        ],
      }),
      officialGreenHomePathsImpl: officialGreenHomePaths,
      computeMatchDecisionImpl: () => ({ decision: 'ACCEPT', score: 90 }),
    })

    expect(result.programs.map((program) => program.id)).toEqual([
      'doe-weatherization-assistance',
      'shared',
    ])
    expect(result.programs[1].need_score).toBe(45)
    expect(result.programs[1].matched_green_home_items).toEqual(['weatherization', 'heat pump'])
  })`,
  )

  source = replaceTest(
    source,
    'exposes catalog metadata-query failure as partial coverage',
    'minimizes malformed state and organization values safely',
    `  it('exposes catalog metadata-query failure as partial coverage and withholds the row', async () => {
    const db = { prepare: vi.fn(() => ({ all: vi.fn().mockRejectedValue(new Error('db unavailable')) })) }
    const result = await searchGreenHomeNoCostPrograms(db, {
      profileId: 'profile-1',
      profileContext: { profile: { primary_type: 'family', state: 'TN' } },
      now: NOW,
      searchItemNeedsImpl: async () => reportWith([trustedCatalog()]),
      officialGreenHomePathsImpl: () => [],
    })
    expect(result.programs).toHaveLength(0)
    expect(result.review_reasons).toContainEqual({
      reason: 'catalog_verification_unavailable',
      count: 1,
    })
    expect(result.search_coverage.source_errors).toContainEqual(expect.objectContaining({
      lane: 'catalog_verification',
      error: 'db unavailable',
    }))
  })`,
  )
  write(file, source)
}

// ---------------------------------------------------------------------------
// 3. Frontend source-trust defense and degraded-search UX tests.
// ---------------------------------------------------------------------------
{
  const file = 'src/pages/GreenHomePrograms.jsx'
  let source = read(file)
  source = replaceOnce(
    source,
    `function ProgramCard({ program }) {
  const url = safeExternalUrl(
    program.url || program.application_url || program.source_url || program.info_url,
  )`,
    `function ProgramCard({ program }) {
  const sourceTrust = String(program.no_cost_source_trust || '').toLowerCase()
  const trustedSource = ['official_government', 'verified_source'].includes(sourceTrust)
  const url = trustedSource
    ? safeExternalUrl(
        program.final_url || program.url || program.application_url || program.source_url || program.info_url,
      )
    : null`,
    'ProgramCard trust-gated URL',
  )
  source = replaceOnce(
    source,
    `  const sourceLabel = program.no_cost_source_trust === 'official_government'
    ? 'Open official source'
    : 'Open reviewed source'`,
    `  const sourceLabel = sourceTrust === 'official_government'
    ? 'Open official source'
    : 'Open reviewed source'`,
    'ProgramCard source label',
  )
  source = replaceOnce(
    source,
    `              {upgradeLabels.slice(0, 8).map((upgrade) => (
                <Badge key={upgrade} variant="secondary" className="font-normal">`,
    `              {upgradeLabels.slice(0, 8).map((upgrade, index) => (
                <Badge key={\`${'${upgrade}'}-${'${index}'}\`} variant="secondary" className="font-normal">`,
    'upgrade keys',
  )
  source = replaceOnce(
    source,
    `              {eligibility.map((item) => (
                <li key={item} className="flex items-start gap-2">`,
    `              {eligibility.map((item, index) => (
                <li key={\`${'${item}'}-${'${index}'}\`} className="flex items-start gap-2">`,
    'eligibility keys',
  )
  source = replaceOnce(
    source,
    `              This record has no usable source link and cannot be acted on yet.`,
    `              This record has no independently reviewed source link and cannot be acted on yet.`,
    'untrusted source message',
  )
  write(file, source)
}

{
  const file = 'src/pages/GreenHomePrograms.test.jsx'
  let source = read(file)
  source = replaceOnce(source, `policy_version: 'green_home_no_cost_v1'`, `policy_version: 'green_home_no_cost_v2'`, 'policy version fixture')
  source = replaceOnce(
    source,
    `      source_url: 'https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance',
      opportunity_kind: 'directory',`,
    `      source_url: 'https://stale.example/old-path',
      final_url: 'https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance',
      no_cost_source_trust: 'official_government',
      opportunity_kind: 'directory',`,
    'trusted final URL fixture',
  )

  const append = `

  it('labels a non-government independently reviewed source honestly', async () => {
    const response = successfulResponse()
    response.programs = [{
      ...response.programs[0],
      id: 'reviewed-utility',
      sponsor: 'Community Utility',
      no_cost_source_trust: 'verified_source',
      final_url: 'https://utility.example/no-cost-upgrades',
    }]
    searchMock.mockResolvedValueOnce(response)
    render(<GreenHomePrograms />)

    fireEvent.click(screen.getByRole('button', { name: /find no-cost programs/i }))

    const link = await screen.findByRole('link', { name: /open reviewed source/i })
    expect(link.getAttribute('href')).toBe('https://utility.example/no-cost-upgrades')
  })

  it('does not render an actionable link when source trust is absent', async () => {
    const response = successfulResponse()
    response.programs = [{
      ...response.programs[0],
      no_cost_source_trust: null,
      final_url: 'https://unreviewed.example/free-upgrades',
    }]
    searchMock.mockResolvedValueOnce(response)
    render(<GreenHomePrograms />)

    fireEvent.click(screen.getByRole('button', { name: /find no-cost programs/i }))

    expect(await screen.findByText(/no independently reviewed source link/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /open (?:official|reviewed) source/i })).toBeNull()
  })

  it('shows partial source coverage alongside usable results', async () => {
    const response = successfulResponse()
    response.search_coverage.source_errors = [
      { lane: 'web', error: 'provider timeout' },
    ]
    searchMock.mockResolvedValueOnce(response)
    render(<GreenHomePrograms />)

    fireEvent.click(screen.getByRole('button', { name: /find no-cost programs/i }))

    expect(await screen.findByText(/partial source coverage/i)).toBeTruthy()
    expect(screen.getByText('Weatherization Assistance Program')).toBeTruthy()
  })

  it('clears prior successful results when a repeat search fails', async () => {
    searchMock
      .mockResolvedValueOnce(successfulResponse())
      .mockRejectedValueOnce(new Error('Second search failed'))
    render(<GreenHomePrograms />)

    fireEvent.click(screen.getByRole('button', { name: /find no-cost programs/i }))
    expect(await screen.findByText('Weatherization Assistance Program')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /find no-cost programs/i }))
    expect(await screen.findByText(/the search could not be completed/i)).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByText('Weatherization Assistance Program')).toBeNull()
    })
  })`
  const close = source.lastIndexOf('\n})')
  if (close < 0) throw new Error('Could not locate GreenHomePrograms test suite close')
  source = source.slice(0, close) + append + source.slice(close)
  write(file, source)
}

// ---------------------------------------------------------------------------
// 4. Honest green-home source-review documentation.
// ---------------------------------------------------------------------------
{
  const file = 'docs/green-home-no-cost-programs.md'
  let source = read(file)
  source = replaceOnce(
    source,
    `**Feature status:** In implementation and review. This document does not establish Production Ready status.
**Policy version:** \`green_home_no_cost_v2\`
**Source review date:** 2026-08-10`,
    `**Feature status:** In implementation and review. This document does not establish production-ready status.
**Policy version:** \`green_home_no_cost_v2\`
**Source freshness window:** 60 days`,
    'feature status and freshness header',
  )
  source = replaceOnce(
    source,
    `3. The source is an official government source or carries an explicit verified-source trust state.
4. The source has not exceeded the configured review-freshness window.`,
    `3. The source is an allowlisted official government source or carries an independently recorded source-review trust state. URL reachability, \`verified_url\`, a successful \`link_status\`, or a government-looking hostname does not establish source trust.
4. The source has not exceeded the configured content-review freshness window, and its link has been verified independently within the link-freshness window.`,
    'independent source trust rule',
  )
  source = replaceOnce(
    source,
    `## Official starting paths

### U.S. Department of Energy Weatherization Assistance Program`,
    `## Official starting paths

| Source path | Content reviewed at | Expires after | Refresh owner | Refresh cadence | Current primary status |
|---|---:|---:|---|---|---|
| DOE Weatherization Assistance Program | 2026-08-10 | 60 days | GrantFlow official-source reviewer | Recheck at least every 30 days and after any federal program change | Eligible official no-cost starting path |
| HHS LIHEAP federal locator and FY2024 fact sheet | 2026-08-10 | 60 days | GrantFlow official-source reviewer | Recheck at least every 30 days, when a newer federal report appears, and before relying on any local offer | Review-only until a local administering source proves no household payment |

The classifier enforces these per-source review dates. An expired source is withheld from \`programs\` but remains visible in coverage diagnostics so stale evidence cannot masquerade as a verified zero-result search.

### U.S. Department of Energy Weatherization Assistance Program`,
    'per-source freshness table',
  )
  write(file, source)
}

// ---------------------------------------------------------------------------
// 5. Release health must block empty catalogs and empty direct-opportunity sets.
// ---------------------------------------------------------------------------
{
  const file = 'backend/services/missionHealthService.js'
  let source = read(file)
  source = replaceOnce(
    source,
    `    'release_catalog_snapshot_unavailable',
    'release_catalog_verified_pct_below_target',
    'visible_direct_link_requirement_failed',`,
    `    'release_catalog_snapshot_unavailable',
    'release_catalog_empty',
    'release_catalog_verified_pct_below_target',
    'visible_direct_catalog_empty',
    'visible_direct_link_requirement_failed',`,
    'empty catalog blocking codes',
  )
  const before = `  } else {
    if (
      releaseCatalogTotal > 0
      && releaseCatalogVerifiedPct < TARGETS.release_catalog_verified_pct_min
    ) {
      alerts.push({
        level: 'warn',
        code: 'release_catalog_verified_pct_below_target',
        detail: \`Only \${releaseCatalogVerifiedPct}% of the complete visible catalog is freshly link-verified (target ≥ \${TARGETS.release_catalog_verified_pct_min}%). The denominator includes direct opportunities, benefits, directories, referrals, and portals.\`,
      })
    }
    if (visibleDirectTotal > 0 && !visibleDirectAllVerified) {
      alerts.push({
        level: 'warn',
        code: 'visible_direct_link_requirement_failed',
        detail: \`\${visibleDirectVerified} of \${visibleDirectTotal} visible direct opportunities are freshly link-verified. Every visible direct opportunity must meet the link requirement.\`,
      })
    }
  }`
  const after = `  } else {
    if (releaseCatalogTotal === 0) {
      alerts.push({
        level: 'warn',
        code: 'release_catalog_empty',
        detail: 'The complete visible funding catalog is empty. A funding-discovery release cannot pass without active, visible resources.',
      })
    } else if (releaseCatalogVerifiedPct < TARGETS.release_catalog_verified_pct_min) {
      alerts.push({
        level: 'warn',
        code: 'release_catalog_verified_pct_below_target',
        detail: \`Only \${releaseCatalogVerifiedPct}% of the complete visible catalog is freshly link-verified (target ≥ \${TARGETS.release_catalog_verified_pct_min}%). The denominator includes direct opportunities, benefits, directories, referrals, and portals.\`,
      })
    }
    if (visibleDirectTotal === 0) {
      alerts.push({
        level: 'warn',
        code: 'visible_direct_catalog_empty',
        detail: 'No active, visible direct funding opportunity is available. Direct opportunities are required for GrantFlow purpose fulfillment.',
      })
    } else if (!visibleDirectAllVerified) {
      alerts.push({
        level: 'warn',
        code: 'visible_direct_link_requirement_failed',
        detail: \`\${visibleDirectVerified} of \${visibleDirectTotal} visible direct opportunities are freshly link-verified. Every visible direct opportunity must meet the link requirement.\`,
      })
    }
  }`
  source = replaceOnce(source, before, after, 'empty catalog release alerts')
  write(file, source)
}

{
  const file = 'tests/mission/mission-health-dashboard.test.mjs'
  let source = read(file)
  const firstBefore = `test('mission-health: empty DB returns ok=true and zero counts', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.equal(h.ok, true)
  assert.equal(h.counts.direct_opportunities_total, 0)
  assert.equal(h.counts.placeholder_opportunities, 0)
  assert.equal(h.alerts.length, 0)
  assert.ok(h.matcher_version)
  assert.ok(h.targets)
})`
  const firstAfter = `test('mission-health: empty DB stays live but blocks a production release', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.equal(h.ok, true)
  assert.equal(h.counts.direct_opportunities_total, 0)
  assert.equal(h.counts.placeholder_opportunities, 0)
  assert.equal(h.production_gate, false)
  assert.ok(h.release_blockers.some((blocker) => blocker.code === 'release_catalog_empty'))
  assert.ok(h.release_blockers.some((blocker) => blocker.code === 'visible_direct_catalog_empty'))
  assert.ok(h.matcher_version)
  assert.ok(h.targets)
})`

  const gateBefore = `test('mission-health: empty DB has production_gate=true and release_blockers=[]', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.equal(h.production_gate, true, 'empty/clean DB must clear the release gate')
  assert.deepEqual(h.release_blockers, [])
})`
  const gateAfter = `test('mission-health: empty DB fails the strict catalog release gates', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.equal(h.production_gate, false)
  assert.ok(h.release_blockers.some((blocker) => blocker.code === 'release_catalog_empty'))
  assert.ok(h.release_blockers.some((blocker) => blocker.code === 'visible_direct_catalog_empty'))
})`
  source = replaceOnce(source, gateBefore, gateAfter, 'empty DB production gate test')
  source = replaceOnce(
    source,
    `  assert.ok(MISSION_TARGETS.release_blocking_codes.includes('crawler_source_outcomes_stale'))`,
    `  assert.ok(MISSION_TARGETS.release_blocking_codes.includes('crawler_source_outcomes_stale'))
  assert.ok(MISSION_TARGETS.release_blocking_codes.includes('release_catalog_empty'))
  assert.ok(MISSION_TARGETS.release_blocking_codes.includes('visible_direct_catalog_empty'))`,
    'empty catalog target assertions',
  )
  write(file, source)
}

// ---------------------------------------------------------------------------
// 6. Production proof checks exact release contract, DB ledger semantics,
//    readiness, mission gate, catalog threshold, and visible-direct threshold.
// ---------------------------------------------------------------------------
{
  const file = 'scripts/production-deployment-proof.mjs'
  let source = read(file)
  source = replaceOnce(
    source,
    `import { buildRepositoryReleaseIdentity } from '../shared/releaseIdentity.js'`,
    `import {
  buildRepositoryReleaseIdentity,
  RELEASE_IDENTITY_CONTRACT,
} from '../shared/releaseIdentity.js'`,
    'release identity contract import',
  )
  source = source.replaceAll("'grantflow-release-identity-v1'", 'RELEASE_IDENTITY_CONTRACT')
  source = replaceOnce(
    source,
    `    'Production database migration identity matches release',`,
    `    'Production database migration ledger matches current release files',`,
    'honest database check name',
  )
  source = replaceOnce(
    source,
    `      && databaseMigrations?.matches_release === true`,
    `      && databaseMigrations?.matches_release === true
      && databaseMigrations?.checksum_columns_available === true
      && databaseMigrations?.stored_checksum_complete === true
      && databaseMigrations?.checksums_match === true
      && databaseMigrations?.name_parity_matches === true`,
    'database checksum completeness proof',
  )
  source = replaceOnce(
    source,
    `      order_matches: databaseMigrations?.order_matches ?? null,
      hash_provenance: databaseMigrations?.hash_provenance || null,`,
    `      order_matches: databaseMigrations?.order_matches ?? null,
      name_parity_matches: databaseMigrations?.name_parity_matches ?? null,
      checksum_columns_available: databaseMigrations?.checksum_columns_available ?? null,
      stored_checksum_complete: databaseMigrations?.stored_checksum_complete ?? null,
      checksums_match: databaseMigrations?.checksums_match ?? null,
      hash_provenance: databaseMigrations?.hash_provenance || null,`,
    'database checksum diagnostics',
  )

  const insertionMarker = `  const failures = checks.filter((check) => !check.pass)`
  const liveGateChecks = `  addAsync(
    checks,
    'Production database historical-byte attestation status is explicit',
    \`GET \${liveVersionUrl}\`,
    typeof databaseMigrations?.historical_applied_bytes_attested === 'boolean',
    {
      historical_applied_bytes_attested:
        databaseMigrations?.historical_applied_bytes_attested ?? null,
      note: databaseMigrations?.historical_applied_bytes_attested === true
        ? 'Every recorded migration was attested from applied bytes.'
        : 'Legacy rows match the current immutable checksum baseline, but their pre-baseline historical bytes cannot be retroactively proven.',
    },
  )

  const readyUrl = \`\${productionBaseUrl}/readyz\`
  let ready = null
  try {
    ready = await fetchJson(readyUrl)
  } catch (error) {
    ready = { ok: false, status: null, fetch_error: error?.message || String(error) }
  }
  addAsync(
    checks,
    'Production backend readiness and mission gate pass',
    \`GET \${readyUrl}\`,
    ready.ok
      && ready?.data?.ok === true
      && ready?.data?.status === 'ready'
      && ready?.data?.mission_gate === 'passed',
    {
      http_status: ready?.status ?? null,
      ok: ready?.data?.ok ?? null,
      status: ready?.data?.status ?? null,
      mission_gate: ready?.data?.mission_gate ?? null,
      reason: ready?.data?.reason ?? null,
      release_blockers: ready?.data?.release_blockers ?? null,
      error: ready?.fetch_error || ready?.parse_error || null,
    },
  )

  const missionUrl = \`\${productionBaseUrl}/api/health/mission\`
  let mission = null
  try {
    mission = await fetchJson(missionUrl)
  } catch (error) {
    mission = { ok: false, status: null, fetch_error: error?.message || String(error) }
  }
  const missionBlockers = Array.isArray(mission?.data?.release_blockers)
    ? mission.data.release_blockers
    : null
  const missionCatalog = mission?.data?.release_catalog || null
  const missionDirect = missionCatalog?.visible_direct || null
  const catalogTarget = Number(mission?.data?.targets?.release_catalog_verified_pct_min ?? 95)
  const directTarget = Number(mission?.data?.targets?.visible_direct_verified_pct_min ?? 100)

  addAsync(
    checks,
    'Production mission release gate has no blockers',
    \`GET \${missionUrl}\`,
    mission.ok
      && mission?.data?.production_gate === true
      && Array.isArray(missionBlockers)
      && missionBlockers.length === 0,
    {
      http_status: mission?.status ?? null,
      production_gate: mission?.data?.production_gate ?? null,
      release_blockers: missionBlockers,
      error: mission?.fetch_error || mission?.parse_error || mission?.data?.error || null,
    },
  )

  addAsync(
    checks,
    'Production complete catalog meets the fresh-link threshold',
    \`GET \${missionUrl}\`,
    mission.ok
      && Number(missionCatalog?.denominator_total) > 0
      && Number(mission?.data?.rates?.release_catalog_verified_pct) >= catalogTarget,
    {
      denominator_total: missionCatalog?.denominator_total ?? null,
      verified_fresh: missionCatalog?.verified_fresh ?? null,
      verified_pct: mission?.data?.rates?.release_catalog_verified_pct ?? null,
      target_pct: catalogTarget,
    },
  )

  addAsync(
    checks,
    'Production visible direct opportunities are present and all freshly verified',
    \`GET \${missionUrl}\`,
    mission.ok
      && Number(missionDirect?.total) > 0
      && missionDirect?.all_verified === true
      && Number(missionDirect?.verified_pct) >= directTarget,
    {
      total: missionDirect?.total ?? null,
      verified_fresh: missionDirect?.verified_fresh ?? null,
      all_verified: missionDirect?.all_verified ?? null,
      verified_pct: missionDirect?.verified_pct ?? null,
      target_pct: directTarget,
    },
  )

`
  source = replaceOnce(source, insertionMarker, liveGateChecks + insertionMarker, 'live readiness and mission proof')
  write(file, source)
}

{
  const file = 'tests/unit/no-fake-production-rule.test.mjs'
  let source = read(file)
  const before = `  assert.match(script, /shaMatches\\(expectedHead, frontendCommit\\)/)
  assert.match(script, /shaMatches\\(expectedHead, liveCommit\\)/)
  assert.doesNotMatch(script, /proves the current branch commit is already live/i)`
  const after = `  assert.match(script, /shaMatches\\(expectedHead, frontendCommit\\)/)
  assert.match(script, /shaMatches\\(expectedHead, liveCommit\\)/)
  assert.match(script, /RELEASE_IDENTITY_CONTRACT/)
  assert.match(script, /Production database migration ledger matches current release files/)
  assert.match(script, /stored_checksum_complete/)
  assert.match(script, /checksums_match/)
  assert.match(script, /\\/readyz/)
  assert.match(script, /\\/api\\/health\\/mission/)
  assert.match(script, /Production mission release gate has no blockers/)
  assert.match(script, /Production complete catalog meets the fresh-link threshold/)
  assert.match(script, /visible direct opportunities are present and all freshly verified/i)
  assert.doesNotMatch(script, /proves the current branch commit is already live/i)`
  source = replaceOnce(source, before, after, 'production proof structural assertions')
  write(file, source)
}

console.log('Applied final GrantFlow review-closure patch.')
