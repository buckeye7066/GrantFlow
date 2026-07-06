# Product

## Register

product

## Users

Individuals, families, students, nonprofits, churches, schools, volunteer fire/EMS departments, small businesses, and local governments looking for real funding. Most are NOT grant professionals — they are ordinary people (often in stressful circumstances: caregiving, medical debt, reentry, housing insecurity) or overstretched volunteers at small organizations. Many are first-time grant seekers; some prefer non-English languages (Russian is an active user language). They arrive skeptical of "grant finder" scams and need reassurance that the opportunities are real.

The owner/operator (admin) is a separate power user with agent dashboards, but the design default is the non-expert applicant.

## Product Purpose

GrantFlow finds REAL funding opportunities (grants, scholarships, assistance programs) matched to a user's actual profile, then walks them through a pipeline from discovery to submitted application — with AI help (Anya the in-app guide, Hamilton the form-filling automation) doing as much of the heavy lifting as the user permits. Success = a user with no grant-writing experience discovers a genuine, eligible opportunity and gets an application submitted with minimal manual effort. Core anti-goals: never fabricate opportunities, never show junk/placeholder matches, avoid zero-result dead ends (fallback thresholds 50→30→15→0).

## Brand Personality

Warm, plainspoken, trustworthy. Anya's voice defines the register: first-person, reassuring, low-pressure ("There are no wrong answers here"), emoji-light. The product should feel like a competent friend who happens to know grants — not like enterprise software, not like a government portal, and not like a hype-y "free money!" site.

## Anti-references

- "Free grant money" scam sites: no urgency banners, no inflated dollar claims, no dark patterns.
- Government portals (Grants.gov, SAM.gov): no dense jargon walls, no acronym-first navigation — GrantFlow exists to shield users from those.
- Enterprise CRM density (Salesforce-style): the pipeline board must stay legible to a first-time user.
- Developer-facing error copy leaking to end users (config/env instructions belong in logs, not alerts).

## Design Principles

1. **Real data, plainly explained.** Every number and match must be genuine; explain "why you're seeing this" rather than hiding scoring. Never a fake/demo layer.
2. **Anya carries the hand-holding.** Guidance, onboarding, and recovery flow through Anya's warm voice, anchored to her avatar — not through disconnected tooltips or docs links.
3. **No dead ends.** Every empty state, zero-result crawl, and error offers a next step the user can actually take. Blocking a user on an action they can't complete is a defect.
4. **Consent before automation.** Hamilton's power is opt-in and legible: plain-language choices ("I'll review before anything submits"), never surprise submissions.
5. **Low-literacy-safe.** Short sentences, no grant jargon without explanation, generous touch targets, works on a phone — many users only have a phone.

## Accessibility & Inclusion

No formal WCAG target committed yet; treat WCAG 2.1 AA as the working bar. Priorities: plain-language copy (users under stress, ESL users — bilingual packets already ship in Russian), mobile responsiveness on all applicant-facing surfaces (onboarding, discovery, pipeline), visible focus states, ≥4.5:1 body-text contrast, and reduced-motion alternatives for coachmark/tour animations.
