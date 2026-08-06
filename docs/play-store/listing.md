# Google Play store listing — GrantFlow (`com.grantflow.app`)

Prepared 2026-07-13. Ready-to-paste copy plus final graphics for the Play
Console store listing. Publisher one-command script:
`app-store-publisher/scripts/grantflow-play-listing.mjs` (runs once the app
record exists in Play Console and the service account has app access +
"Manage store presence").

## App details

| Field | Value |
|---|---|
| App name | GrantFlow |
| Default language | en-US |
| Contact email | dr.johnwhite@axiombiolabs.org |
| Contact website | https://app.axiombiolabs.org |
| Privacy policy URL | https://app.axiombiolabs.org/privacy |
| Category | Business (or Finance) |

## Short description (80 chars max)

```
Find relevant grants, scholarships, and benefits with evidence-backed guidance
```

## Full description (4000 chars max)

```
GrantFlow helps you discover grants, scholarships, and benefit programs that may fit your profile, understand the evidence and unknowns, organize your work, and prepare honest application handoffs.

FIND FUNDING THAT FITS YOU
• Build a profile once; GrantFlow matches you against grants, scholarships, benefits, and local programs
• A versioned match decision explains why an opportunity appears relevant and what still needs human verification
• A provenance-aware funding library spanning federal and state grants, scholarships, foundations, and benefit programs

STAY ON TOP OF EVERYTHING
• A pipeline that tracks every opportunity from discovered → interested → drafting → submitted → awarded
• An application tracker from draft to outcome
• Deadline reminders by email or SMS so nothing slips
• Reports and analytics on your funding activity

LET AI DO THE HEAVY LIFTING
• AI drafting help for proposals and applications
• Document upload so applications can help fill themselves in
• Ask Anya, your in-app assistant, for help at any step
• You always approve what matters — GrantFlow prepares, you decide

Whole-life funding: federal & state grants, scholarships, benefits (SNAP, Medicaid, TANF), item funding (a vehicle, a laptop), and local foundations.

Subscriptions are available on the web.
```

## Graphics (in this folder)

| File | Use | Size |
|---|---|---|
| `icon-512.png` | App icon | 512×512 |
| `feature-graphic.png` | Feature graphic | 1024×500 |
| `01-welcome.png` … `06-applications.png` | Phone screenshots (upload in order: 01, 02, 04, 05, 03, 06) | 1080×2160 |

Screenshots captured 2026-07-13 from the live production app
(app.axiombiolabs.org): `01-welcome` is the public marketing page; the rest
are the signed-in workspace.

## Data safety form — answers consistent with /privacy

- Collects: email + name (account management); applicant profile details the
  user enters for matching (organization/individual facts, and eligibility
  facts like budget/income where provided); user-generated content
  (proposals, applications, documents); optional phone number (SMS deadline
  reminders). Encrypted in transit; stored connected-service credentials
  encrypted at rest.
- Shares with processors only: OpenAI / Anthropic (AI drafting & discovery),
  Stripe (web payments only — no in-app purchases), Resend (email), Twilio
  (optional SMS reminders), Vercel/Railway (hosting).
- No ads, no third-party advertising/tracking SDKs, no data sold.
- Payments happen only on the website; the app has no purchase flow (native
  billing gate, PR #929).

## Content rating questionnaire hints

Business/productivity finance-adjacent app. No ads, no gambling, no violence/
sexual content, no user-to-user social features exposed to the public. Target
audience: adults (18+) managing funding — do NOT target children.
