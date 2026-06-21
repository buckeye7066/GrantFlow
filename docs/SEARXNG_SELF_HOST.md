# Self-Hosted Web Search (SearXNG) — "Our Own Brave"

GrantFlow's local / non-federal funding discovery (county scholarships, city
foundations, Yana contact enrichment) needs to **search the open web** from the
server. Federal sources (Grants.gov, SAM, USASpending, NIH) have APIs and are
unaffected by this doc.

The single web-search entry point is
`backend/services/crawlers/webSearchEngine.js → searchWeb()`. Its provider
chain is:

1. **SearXNG (self-hosted, PRIMARY)** — `SEARXNG_URL` set → keyless, unlimited,
   reliable from a datacenter IP.
2. **Brave Search API (fallback, when keyed)** — `BRAVE_SEARCH_API_KEY` set →
   metered/capped paid plan, kept as a backstop.
3. **DuckDuckGo HTML scraping (last resort)** — no key, but **dead from cloud
   IPs** (returns an HTTP 202 anti-bot challenge), so it no-ops in prod.

## Why SearXNG (the comparison)

| Option | Cost model | Rate limit | Reliable from datacenter IP? | Output quality for grant/scholarship queries | Setup effort |
| --- | --- | --- | --- | --- | --- |
| **SearXNG self-host (CHOSEN)** | **$0 per query**; only the Railway service's idle/runtime cost (~hobby tier) | **None** (it's your instance; you set limits) | **Yes** — it aggregates Google/Bing/DuckDuckGo/Brave-web/etc. server-side; SearXNG handles their bot defenses | High — real SERP results with URL + title + snippet; engine mix is tunable | Moderate — one Docker service on Railway, ~15 min (this runbook) |
| Brave Search API | Free $0 plan ~2k q/mo then paid; owner's key is **402 USAGE_LIMIT_EXCEEDED** ($5/mo cap, can't raise) | ~1 req/s free | Yes | High, independent index | Low (key only) — but **cost/cap is the blocker** |
| Google Programmable Search / Custom Search JSON | 100 q/day free, then **~$5 / 1000** (hard 10k/day cap) | 100/day free | Yes | High but restricted to your configured CSE scope | Low-moderate (key + CX) — **too few free queries** for discovery fan-out (8 queries × many profiles) |
| Tavily | ~1000 credits/mo free, then paid | Tiered | Yes | Good, LLM-oriented answers | Low (key) — free tier too small for unattended loops |
| Serper.dev | 2500 free queries once, then paid | Tiered | Yes | High (Google SERP proxy) | Low (key) — free is a one-time grant, then metered |
| SerpAPI | 100 q/mo free, then paid (pricey) | Tiered | Yes | High | Low (key) — free tier tiny |
| Marginalia | Free public API | Polite, small | Yes | Niche/indie index; **weak on local funder/.gov pages** | Low | 
| Mojeek | Paid API (no real free tier) | Tiered | Yes | Independent index, modest coverage | Low — **no free tier** |

**Decision:** SearXNG self-host. It is the only option that is simultaneously
**zero-per-query**, **unmetered**, **datacenter-reliable**, and **high-quality**
(because it proxies the major engines). Every keyed API either has a free tier
too small for an 8-query-per-profile discovery fan-out or costs real money per
query. SearXNG is literally "our own Brave." The keyed APIs remain wired as
fallbacks (set `BRAVE_SEARCH_API_KEY` if you ever want a backstop), and the code
needs zero changes to switch — it's all env-driven.

---

## Deploy runbook (Railway)

You will stand up a second Railway **service** (in the existing GrantFlow
project or its own) running the official `searxng/searxng` Docker image, then
point the backend at it via `SEARXNG_URL`.

### Option A — Railway dashboard (simplest)

1. Open the GrantFlow project in Railway → **New** → **Empty Service** (or
   **Deploy a Docker Image**).
2. Set the **Source / Image** to the public image:
   ```
   searxng/searxng:latest
   ```
3. **Variables** (Service → Variables) — set these on the SearXNG service:
   ```
   SEARXNG_BASE_URL = https://<your-searxng-service>.up.railway.app/
   SEARXNG_SECRET   = <run: openssl rand -hex 32>
   INSTANCE_NAME    = grantflow-search
   ```
   `SEARXNG_BASE_URL` must match the public domain Railway assigns (set it after
   step 5 once you know the domain, then redeploy).
4. **Networking** → **Generate Domain** so the service gets a public HTTPS URL.
   Railway exposes one port; SearXNG listens on **8080** — set the service's
   target port to `8080` if prompted.
5. The default SearXNG config has the **JSON format DISABLED**. You must enable
   it (the backend calls `?format=json`). Easiest: add a `settings.yml` override
   via a `SEARXNG_SETTINGS` mount or commit a tiny config. The minimal change:
   ```yaml
   # settings.yml
   search:
     formats:
       - html
       - json
   ```
   On the stock image you can instead set the env var the image reads, or bake
   a `settings.yml` into a small wrapper image (Option B). If you skip this,
   `searchWeb` will log `HTTP 403` / empty results — that's the JSON-format gate.
6. Once deployed and the domain is live, **set the backend var** on the
   **GrantFlow backend** service:
   ```
   SEARXNG_URL = https://<your-searxng-service>.up.railway.app
   ```
   (No trailing `/search` needed — the provider appends it. A bare host or a
   `.../search` URL both work.)
7. Redeploy the backend (Railway redeploys on var change). Done — `searchWeb`
   now logs `SearXNG search provider active (primary)` on boot.

### Option B — wrapper image with JSON enabled (recommended, reproducible)

Commit this Dockerfile somewhere (e.g. `infra/searxng/Dockerfile`) and point a
Railway service at it; it bakes in the JSON-enabled config so there's no manual
toggle:

```dockerfile
FROM searxng/searxng:latest
# Enable the JSON output format the GrantFlow backend calls with ?format=json.
# (Stock image ships HTML-only.)
RUN sed -i 's/- html/- html\n    - json/' /usr/local/searxng/searx/settings.yml \
    || true
COPY settings.yml /etc/searxng/settings.yml
ENV SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
EXPOSE 8080
```

`infra/searxng/settings.yml`:
```yaml
use_default_settings: true
server:
  secret_key: "set-via-SEARXNG_SECRET-env"   # Railway env overrides this
  limiter: false                             # internal-only instance, no public limiter
search:
  formats:
    - html
    - json
  safe_search: 0
```

Then in Railway: create the service from this build, generate a domain, set
`SEARXNG_SECRET` + `INSTANCE_NAME`, and set `SEARXNG_URL` on the backend as in
Option A step 6.

### Verify

After the backend redeploys with `SEARXNG_URL` set:

```bash
# From your machine, confirm the instance returns JSON:
curl 'https://<your-searxng-service>.up.railway.app/search?q=Bradley+County+scholarship&format=json' | head -c 400
```

You should get a JSON object with a `results` array. In GrantFlow, run a
discovery on a profile with a city/county and confirm `web_search` leads appear
(they were empty before because DDG was blocked).

---

## Backend env vars (summary)

| Var | Service | Required? | Purpose |
| --- | --- | --- | --- |
| `SEARXNG_URL` | **GrantFlow backend** (Railway) | **Yes, to enable** | Base URL of the SearXNG instance. Set it → SearXNG becomes the primary web-search backend. Unset → falls through to Brave/DDG (current behavior). |
| `SEARXNG_ENGINES` | GrantFlow backend | Optional | Comma-separated engine allowlist passed to SearXNG (e.g. `google,bing,duckduckgo`). Default: instance default mix. |
| `SEARXNG_SECRET` | SearXNG service | Yes (on the SearXNG side) | SearXNG's own secret key. |
| `INSTANCE_NAME` | SearXNG service | Optional | Display name for the instance. |
| `BRAVE_SEARCH_API_KEY` | GrantFlow backend | Optional | Kept as a metered fallback if you ever raise the Brave plan. |

**The one action that flips this on: set `SEARXNG_URL` on the GrantFlow backend
service** (after the SearXNG instance is up with JSON enabled). No code deploy
needed beyond the change that shipped this provider.
