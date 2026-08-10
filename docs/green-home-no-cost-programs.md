# GrantFlow No-Cost Green Home Programs

**Feature status:** In implementation and review. This document does not establish Production Ready status.  
**Policy version:** `green_home_no_cost_v1`  
**Source review date:** 2026-08-09  
**User route:** `/GreenHomePrograms`  
**API route:** `POST /api/item-needs/:profileId/green-home`

## Purpose

Give a homeowner, household, or renter a clear path to legitimate programs that may provide energy-saving home improvements without requiring the applicant to borrow money or pay for the work.

The path searches for:

- home energy audits;
- weatherization;
- insulation and air sealing;
- eligible heating and cooling repair or replacement;
- heat pumps;
- geothermal heating and cooling;
- residential solar and battery installation;
- small residential wind systems.

A technology appearing in the search list is not a promise that a local program covers it. The administering provider determines household eligibility, property eligibility, and the measures approved after assessment.

## Strict primary-result rule

A record may appear in the primary `programs` list only when all of the following are true:

1. It concerns a supported residential energy or home-efficiency upgrade.
2. The source explicitly says that the assistance or covered work is free, no cost, fully funded, grant funded, direct install, or does not require repayment.
3. The source is an official government source or carries an explicit verified-source trust state.
4. The source has not exceeded the configured review-freshness window.
5. No text or structured field indicates a prohibited payment model.

Unknown cost terms fail closed into review. An unverified web result never enters the primary list merely because its title says “free.”

## Payment models excluded

The primary path excludes:

- loans;
- financing plans and lines of credit;
- PACE financing;
- leases and power-purchase agreements;
- tax credits or deductions;
- rebates;
- reimbursement-only offers;
- down payments or monthly payments;
- matching funds;
- cost sharing;
- applicant, homeowner, customer, or participant contributions;
- copays or out-of-pocket costs;
- purchase-first offers;
- programs whose cost terms cannot be proven.

Excluded and review-only records are counted by reason so a provider outage or ambiguous page cannot masquerade as a successful zero-result search. Raw review candidates are not returned to the normal user interface.

## Official starting paths

### U.S. Department of Energy Weatherization Assistance Program

Official information and application locator:

- https://www.energy.gov/cmei/scep/wap
- https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance

DOE describes WAP as free weatherization and energy-efficiency assistance for qualifying low-income households. A state, Tribal, or local provider determines eligibility and uses an energy assessment to decide which measures are installed. Homeowners and renters may apply, although renters generally require landlord permission.

### HHS Low Income Home Energy Assistance Program

Official program and current federal fact sheet:

- https://www.acf.hhs.gov/ocs/programs/liheap
- https://ocsannualreport.acf.hhs.gov/annual-report-fy24/liheap-fact-sheet

HHS states that LIHEAP may weatherize homes or provide minor energy-related home repairs. Available work, eligibility rules, and application procedures vary by the state, territory, or Tribe administering the benefit.

These are typed as a provider/application directory and a public-benefit path. Their presence does not claim that the selected household is approved or that a particular technology will be installed.

## Terminated-program guard

EPA Solar for All and the related Greenhouse Gas Reduction Fund path are explicitly excluded from current primary results because EPA announced the program's termination in August 2025. Historical pages may remain online and must not be presented as an active application path.

## Privacy boundary

External search receives only:

- a two-letter state code, when available; and
- a broad applicant class such as individual, family, nonprofit, small business, school, or government.

It must not receive:

- profile identifiers or names;
- email addresses or telephone numbers;
- street addresses;
- dates of birth;
- government or veteran identifiers;
- exact income, assets, bank, tax, or account data;
- disability diagnoses, medical details, or document contents;
- portal credentials or uploaded-document text.

The API returns the minimized outbound context and the allowed field list for auditability.

## Eligibility language

GrantFlow may say:

- “This is an explicit no-cost program path.”
- “You may qualify based on the administering provider's rules.”
- “The provider must confirm eligibility and covered work.”

GrantFlow may not say:

- “You qualify” before the provider confirms it.
- “You will receive solar, wind, geothermal, or a heat pump.”
- “Approved,” “awarded,” or “installation scheduled” without durable external evidence.

## Failure behavior

- Search-provider failure remains visible as partial coverage.
- Unknown cost terms become review-only.
- Unverified sources become review-only.
- Stale official evidence becomes review-only.
- Terminated programs are excluded.
- A failed request returns an error rather than an empty successful result.
- No payment-based record can be promoted by score alone.

## Tests

The release suite includes tests for:

- every prohibited payment category;
- structured loan, match, and upfront-payment flags;
- repayment-negation language;
- official, verified, unverified-catalog, and unverified-web trust states;
- terminated-program exclusion;
- source-review freshness;
- deduplication across upgrade searches;
- profile and tenant authorization;
- tier enforcement;
- typed provider failure;
- minimized outbound search context;
- client endpoint validation;
- user-visible no-payment explanation and withheld-result summaries;
- failure not becoming a false zero-result page.

## Remaining verification before release

- Full exact-head CI and production-image gates
- Fresh security, privacy, product, UX, accessibility, and release review
- Browser inspection of the preview route
- Authenticated profile-scoped preview journey
- Exact final-main deployment and production journey after merge
- Periodic official-source refresh and state/local provider expansion
