# Connector Configuration Guide

This document describes every source connector in GrantFlow, its authentication requirements, and the exact credential key needed to enable it. **No secrets or API keys are listed here** — only the environment variable name you must set.

If a credentialed connector is not configured, GrantFlow remains fully functional for all other connectors and features. The system reports the exact missing credential in the Admin → Connector Health panel.

---

## Credential Configuration

All connector credentials are configured via environment variables (see `backend/.env.example`). The system checks for the presence of each required key at startup and during sync attempts. A connector with `isCredentialSatisfied: false` is never called — no fabricated data is produced.

## Public Connectors (No Credentials Required)

### Grants.gov REST

| Property | Value |
|---|---|
| **sourceType** | `grants.gov` |
| **authType** | `none` |
| **requiredCredentialKey** | _(none)_ |
| **isCredentialSatisfied** | Always `true` |
| **baseUrl** | `https://api.grants.gov/v1/api/` |
| **rateLimitPerMin** | 120 |
| **syncStrategy** | incremental (cursor-based) |

The primary public connector. Fetches published federal grant opportunities. No credentials required.

### Federal Register

| Property | Value |
|---|---|
| **sourceType** | `federal-register` |
| **authType** | `none` |
| **requiredCredentialKey** | _(none)_ |
| **isCredentialSatisfied** | Always `true` |
| **baseUrl** | `https://www.federalregister.gov/api/v1/` |
| **rateLimitPerMin** | 200 |

Public API for federal rulemaking and notice documents. No credentials required.

### ProPublica Nonprofit Explorer (990/990-PF)

| Property | Value |
|---|---|
| **sourceType** | `propublica-990` |
| **authType** | `header` |
| **requiredCredentialKey** | `PROPUBLICA_API_KEY` |
| **isCredentialSatisfied** | `true` if env var is set and non-empty |
| **baseUrl** | `https://projects.propublica.org/nonprofits/api/` |
| **rateLimitPerMin** | 100 |

Provides 990/990-PF data for funder intelligence. A ProPublica API key is recommended for higher rate limits but the public endpoints work without one. If rate limit errors occur, set the credential.

### Agency RSS Feeds

| Property | Value |
|---|---|
| **sourceType** | `agency-rss` |
| **authType** | `none` |
| **requiredCredentialKey** | _(none)_ |
| **isCredentialSatisfied** | Always `true` |
| **syncStrategy** | RSS/XML feed polling |

Public RSS/Atom feeds from federal and state agencies. No credentials required.

---

## Credentialed Connectors (Require Credentials)

### SAM.gov

| Property | Value |
|---|---|
| **sourceType** | `sam.gov` |
| **authType** | `api-key` |
| **requiredCredentialKey** | `SAM_GOV_API_KEY` |
| **isCredentialSatisfied** | `true` only if `SAM_GOV_API_KEY` is set |
| **baseUrl** | `https://api.sam.gov/` |
| **rateLimitPerMin** | 10 |
| **syncStrategy** | incremental |

Obtain an API key from https://sam.gov (free registration required). Without this key, the SAM.gov connector shows `isCredentialSatisfied: false` and is skipped during sync. All other connectors continue to function normally.

**Missing credential message (displayed in UI):**
> 