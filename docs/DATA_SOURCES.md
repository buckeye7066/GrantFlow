# Real Data Sources Documentation

This document describes all real data sources used by the GrantFlow crawler system. All sources are legitimate, production-ready APIs and services that provide actual funding opportunity data.

> **Authoritative registry:** the live per-source list (access method, trust
> tier, applicant/need/geography gating) is `backend/crawler-os/sourceRegistry.js`,
> as documented in [`docs/CRAWLERS.md`](./CRAWLERS.md). This document is a
> narrative overview and can drift from the registry (see the NIH note below,
> corrected 2026-08-14); when the two disagree, the registry wins.

## Table of Contents
1. [Federal Sources](#federal-sources)
2. [State Sources](#state-sources)
3. [Foundation and Nonprofit Sources](#foundation-and-nonprofit-sources)
4. [Student Aid Sources](#student-aid-sources)
5. [Specialized Sources](#specialized-sources)
6. [Rate Limiting and Best Practices](#rate-limiting-and-best-practices)

---

## Federal Sources

### 1. Grants.gov API

**Endpoint:** `https://www.grants.gov/grantsws/rest/opportunities/search`

**Access Method:** REST API (POST)

**Authentication:** None required (public API)

**Rate Limits:** 
- Recommended: 1 request per second
- No hard limit documented, but be respectful

**Throttling Strategy:**
- Implement 1000ms delay between requests
- Use batch processing for large queries
- Cache results for 24 hours

**Data Fields Extracted:**
- `oppTitle` - Opportunity title
- `oppDesc` - Description
- `agencyName` - Sponsoring agency
- `oppId` - Unique opportunity ID
- `oppNumber` - Opportunity number (e.g., CDC-RFA-DP25-2502)
- `closeDate` - Application deadline
- `cfdaNumber` - Catalog of Federal Domestic Assistance number
- `eligibleApplicants` - Who can apply

**Provenance Fields:**
- `source`: "grants.gov"
- `source_id`: Value from `oppId` field
- `source_url`: `https://www.grants.gov/view-opportunity.html?oppId={oppId}`

**Example Query:**
```json
{
  "keyword": "",
  "oppStatuses": "Posted",
  "sortBy": "openDate|desc",
  "rows": 100
}
```

**Documentation:** https://www.grants.gov/help/html/help/index.htm

---

### 2. NIH Grants

**Endpoint (current, `nih_guide` in `sourceRegistry.js`):**
`https://grants.nih.gov/grants/guide/newsfeed/fundingopps.xml`

**Access Method:** XML feed (`crawler_method: 'html'`/`feed_url` in the
registry, but the URL fetched is the NIH Guide funding-opportunities RSS/XML
feed, not HTML page scraping). The `.grant-listing`/`.grant-title` CSS
selectors and the `search_results.cfm` HTML endpoint previously documented
here described an earlier scraping approach and are no longer what the
crawler fetches — corrected 2026-08-14 against the live registry entry.

**Rate Limits:**
- Recommended: 1 request per 2 seconds
- Be respectful of NIH servers

**Throttling Strategy:**
- Registry `refresh_frequency_days: 7` (weekly refetch of the feed)
- Cache for 24 hours between refreshes
- Process during off-peak hours

**Data Fields Extracted:**
- Grant title
- Grant number (e.g., PA-20-265)
- Description
- Deadline
- Eligibility criteria
- Award amounts (when available)

**Provenance Fields:**
- `source`: "nih.gov"
- `source_id`: Grant number
- `source_url`: Full URL to announcement

**Documentation:** https://grants.nih.gov/grants/guide/

---

### 3. FEMA Grants

**Endpoint:** `https://www.fema.gov/grants`

**Access Method:** Web scraping

**Rate Limits:**
- 1 request per 3 seconds
- Very respectful of government servers

**Data Fields Extracted:**
- Grant program name
- Description
- Eligibility
- Award amounts
- Application deadlines

**Provenance Fields:**
- `source`: "fema.gov"
- `source_url`: Full URL to grant program

**Documentation:** https://www.fema.gov/grants

---

### 4. Federal Student Aid (FAFSA)

**Endpoint:** `https://studentaid.gov/understand-aid/types/grants`

**Access Method:** Direct data (known federal programs)

**Data Fields:**
- Federal Pell Grant
- Federal Supplemental Educational Opportunity Grant (FSEOG)
- Teacher Education Assistance for College and Higher Education (TEACH) Grant
- Iraq and Afghanistan Service Grant

**Note:** These are well-documented federal programs with stable URLs and criteria.

**Provenance Fields:**
- `source`: "studentaid.gov"
- `source_url`: Direct URL to program page

**Documentation:** https://studentaid.gov/help-center/answers/

---

## State Sources

### 1. Ohio Grants Portal

**Endpoint:** `https://grants.ohio.gov`

**Access Method:** Web scraping / API (varies by implementation)

**Rate Limits:**
- 1 request per 2 seconds
- Monitor for any rate limit responses

**Data Fields Extracted:**
- Grant title
- Agency name
- Award amounts
- Deadline
- Eligible applicants

**Provenance Fields:**
- `source`: "ohio.gov"
- `state`: "OH"
- `source_url`: Full URL

---

### 2. California Grants Portal

**Endpoint:** `https://www.grants.ca.gov`

**Access Method:** Web scraping

**Rate Limits:**
- 1 request per 2 seconds

**Provenance Fields:**
- `source`: "california.gov"
- `state`: "CA"

---

### 3. New York Grants Gateway

**Endpoint:** `https://grantsgateway.ny.gov`

**Access Method:** Web scraping / API

**Rate Limits:**
- 1 request per 2 seconds

**Provenance Fields:**
- `source`: "ny.gov"
- `state`: "NY"

---

### 4. Texas Governor's Grants

**Endpoint:** `https://www.governor.state.tx.us/grants`

**Access Method:** Web scraping

**Rate Limits:**
- 1 request per 2 seconds

**Provenance Fields:**
- `source`: "texas.gov"
- `state`: "TX"

---

### 5. Florida Grants Portal

**Endpoint:** `https://www.myflorida.com/apps/vbs/vbs_www.main.show_grants`

**Access Method:** Web scraping

**Rate Limits:**
- 1 request per 2 seconds

**Provenance Fields:**
- `source`: "florida.gov"
- `state`: "FL"

---

## Foundation and Nonprofit Sources

### 1. Council on Foundations - Community Foundation Locator

**Endpoint:** `https://www.cof.org/community-foundation-locator`

**Access Method:** Directory link (no scraping). Users search by state; no API/fetch required.

**Provenance Fields:**
- `source`: "cof_foundation_locator"
- `source_url`: Community foundation locator URL (optionally with ?state=XX)

---

### 2. Vehicles for Change

**Endpoint:** `https://www.vehiclesforchange.org`

**Access Method:** Program data (stable)

**Type:** Vehicle donation program

**Provenance Fields:**
- `source`: "vehiclesforchange.org"
- `source_url`: https://www.vehiclesforchange.org

---

### 3. Good360

**Endpoint:** `https://good360.org`

**Access Method:** Program data

**Type:** Product philanthropy (donated goods)

**Provenance Fields:**
- `source`: "good360.org"

---

### 4. TechSoup

**Endpoint:** `https://www.techsoup.org`

**Access Method:** API / Program data

**Type:** Technology donations for nonprofits

**Provenance Fields:**
- `source`: "techsoup.org"

---

## Student Aid Sources

### 1. College Board Scholarship Search

**Endpoint:** `https://bigfuture.collegeboard.org/scholarships/scholarship-search`

**Access Method:** API (requires access) / Web scraping

**Rate Limits:**
- Requires API key for bulk access
- Web scraping: very limited, not recommended

**Note:** Consider partnership or API access for production use.

---

### 2. Fastweb

**Endpoint:** `https://www.fastweb.com/college-scholarships`

**Access Method:** API (requires access)

**Note:** Requires partnership for production data access.

---

### 3. Scholarships.com

**Endpoint:** `https://www.scholarships.com`

**Access Method:** API (requires access)

**Note:** Requires partnership for production data access.

---

## Specialized Sources

### 1. Social Security Administration - SSDI/SSI

**Endpoint:** `https://www.ssa.gov/disability`

**Access Method:** Program data (well-documented federal benefits)

**Data Fields:**
- Social Security Disability Insurance (SSDI)
- Supplemental Security Income (SSI)
- Benefit amounts
- Eligibility criteria

**Provenance Fields:**
- `source`: "ssa.gov"
- `source_url`: Direct program URL

---

### 2. TennCare / ECF CHOICES

**Endpoint:** `https://www.tn.gov/tenncare`

**Access Method:** Program data / Web scraping

**Type:** Medicaid waiver programs for individuals with disabilities

**Provenance Fields:**
- `source`: "tn.gov"
- `state`: "TN"

---

### 3. CMS Innovation Center

**Endpoint:** `https://innovation.cms.gov/innovation-models`

**Access Method:** Web scraping

**Type:** Medicare/Medicaid innovation models

**Provenance Fields:**
- `source`: "cms.gov"

---

## Rate Limiting and Best Practices

### Global Rate Limiting Strategy

1. **Default Delays:**
   - Federal APIs: 1000ms between requests
   - State portals: 2000ms between requests
   - Foundation sites: 3000-5000ms between requests

2. **Backoff Strategy:**
   - On 429 (Too Many Requests): exponential backoff starting at 60 seconds
   - On 503 (Service Unavailable): wait 5 minutes before retry

3. **Caching:**
   - Cache all results for 24 hours minimum
   - Use ETags where available
   - Store last-modified timestamps

4. **Batch Processing:**
   - Process in batches of 50-100 items
   - Checkpoint progress after each batch
   - Allow interruption and resumption

5. **Time-of-Day Considerations:**
   - Run heavy crawls during off-peak hours (2am-6am EST)
   - Distribute load across the week

### Error Handling

1. **Retry Logic:**
   - Retry failed requests up to 3 times
   - Use exponential backoff
   - Log all failures

2. **Circuit Breaker:**
   - If source fails >5 times in 5 minutes, pause for 1 hour
   - Send alert to monitoring

3. **Graceful Degradation:**
   - If a source is unavailable, continue with other sources
   - Do NOT fall back to mock data
   - Log source unavailability

### Provenance Tracking

Every opportunity must include:
- `source`: The domain/organization providing the data
- `source_id`: Unique ID from the source (if available)
- `source_url`: Direct URL to the opportunity
- `last_crawled`: Timestamp of when data was retrieved

### Data Quality

1. **Validation:**
   - All opportunities must have: title, sponsor, description, URL
   - No loans (check for keywords: loan, repay, interest, apr)
   - No matching fund requirements
   - No placeholder URLs (example.com, example.org, example.gov)

2. **Deduplication:**
   - Use source + source_id for deduplication
   - If no source_id, use title + sponsor

3. **Freshness:**
   - Mark opportunities as inactive after 90 days without update
   - Re-crawl active opportunities every 7 days

---

## Contact Information Collection

When available from sources, collect:

```json
{
  "contact_info": {
    "name": "Contact person name",
    "email": "contact@organization.com",
    "phone": "555-123-4567",
    "address": "123 Main St, City, ST 12345",
    "website": "https://organization.com"
  }
}
```

Store in the `contact_info` TEXT column as JSON.

---

## Compliance and Ethics

1. **Terms of Service:**
   - Review and comply with each source's terms of service
   - Obtain API keys where required
   - Respect robots.txt

2. **Attribution:**
   - Always provide proper attribution to data sources
   - Include source URLs with every opportunity

3. **User Privacy:**
   - Never share user profile data with external sources
   - Use generic queries that don't expose user information

4. **Data Freshness:**
   - Always provide users with the most recent data
   - Show last_updated timestamps to users

---

## Monitoring and Alerts

Set up monitoring for:
- API response times > 5 seconds
- Error rates > 5%
- Sources returning 0 results (potential API changes)
- Rate limit violations
- Expired API keys

---

**Last Updated:** 2026-01-09  
**Document Version:** 1.0  
**Maintained by:** GrantFlow Engineering Team
