# Competitive comparison and owner audit — 2026-09-21

## Scope and evidence

Owner requested all existing work committed, pushed and merged to production's main branch; a signed-in functional audit; and comparison with three competitors with useful improvements integrated. Both live hosting configurations point to `buckeye7066/GrantFlow`, `main`: Vercel project `grant-flow`, Railway service `GrantFlow`. PR #1781 contains the preserved auth, signup, crawler diagnostics and Hamilton work. The follow-up changes here address calendar portability and browser-account isolation.

Instrumentl, GrantWatch and GrantForward are selected direct competitors covering nonprofit grant management, broad applicant discovery, and research funding. This is not a verified market-share ranking. Findings use official public documentation accessed September 21, 2026, plus GrantFlow source inspection and an authenticated owner browser. Competitor paid workspaces were not tested.

## Comparison

| Workflow | Competitor evidence | GrantFlow evidence and decision |
| --- | --- | --- |
| External deadlines | [Instrumentl calendar integration](https://help.instrumentl.com/en/articles/6554870-calendar-integration) publishes filtered calendar subscriptions with automatic updates, including tasks and funder deadlines. | GrantFlow had internal owner and end-user calendars but no export. Added monthly `.ics` snapshots to both calendars, respecting the selected profile and exact timestamps. Automatic subscription refresh is still a gap; the UI explicitly calls exports snapshots. |
| Discovery and lifecycle tracking | [GrantWatch discovery dashboard](https://resources.grantwatch.com/dashboard.php) combines matching, funder intelligence and grant/donor pipelines. | GrantFlow already has discovery, source-directory/foundation search, canonical pipeline stages, outreach, documents and reporting. Duplicating these would not improve the workflow. Calendar inspection instead exposed missing saved/preparation-stage deadlines and mixed-profile dates; both are corrected. |
| Reusable searches | [GrantForward tutorials](https://www.grantforward.com/support/tutorial?grid_view=true) describe saved grant lists, search sharing, personalized recommendations and alerts. | GrantFlow has saved search filters, history and hidden results in Funding Opportunities, but their browser keys were shared across accounts despite claiming per-user persistence. These are now account-scoped and switch immediately with authentication. Cross-device saved-search synchronization and scheduled search alerts remain gaps. |

GrantFlow's existing differentiators include individual and business profiles, needs-based discovery, evidence gates and Hamilton application preparation. Source availability does not prove these outperform competitors in live funding outcomes. No unsupported superiority or result-volume claim is made.

## CHANGED

- PR #1781 merged to `main` at `14e3173846e9618f3d3022b1e0a08a20108f0f13` after all 22 checks settled and both required suites passed. Follow-up PR: #1782.
- Owner discovery/catalog walkthrough exposed raw HTML descriptions. Shared result cards, catalog summaries/detail views and exports now render readable text without inserting source markup.
- Owner catalog showed decades-old NIH RePORTER records as standing programs with application controls. One shared historical-award classifier now feeds normalization, ingestion gates, read contracts, result classification, application eligibility and catalog/result-card presentation. A bounded boot repair updates known award-source catalog kinds only, preserving user-progressed grants. Source records remain available as reference material; pipeline and application creation are disabled for them.

- `.ics` export on owner and end-user calendars, for the displayed month. Date-only deadlines remain all-day, timestamps preserve cutoff times, event IDs remain stable, invalid dates are skipped and text is escaped/folded for calendar interchange.
- Owner calendar scopes its grant query and displayed pipeline dates to the selected profile. Saved, document-gathering and ready-to-submit grants now contribute deadlines. Due-today dates use local calendar days.
- Export is disabled if a contributing query fails or is still loading. Existing end-user milestone and Hamilton events are included with original dates.
- Saved searches, viewed grants and hidden grants use account-specific browser storage. Unknown legacy shared data is preserved but is not assigned to whichever user signs in next. This does not add cloud synchronization.

## VERIFIED

- PR #1781's exact merged commit was observed on both the frontend deployment artifact and backend health response. Production read-only health, readiness and profile-schema checks passed. Authenticated `/api/auth/me` returned the restored profile type/creator fields.
- Further owner interaction checks passed: business-profile search, pipeline text/profile filters, settings save with the original preference restored, document profile scoping, report scheduling dialog, and Hamilton's profile selector and reversible process/leave selections. No Hamilton submission was triggered.
- Nine focused tests cover account switching without unmounting, legacy-data isolation, malformed storage, signed-out actions, calendar profile filtering, month navigation, timed end-user export, date-only deadlines, invalid dates, UTF-8 folding and content escaping.
- Targeted ESLint passes.
- Authenticated owner navigation audit opened 36 visible routes: Calendar, MyProfiles, Organizations, Settings, DiscoverGrants, GreenHomePrograms, SavedGrants, FundingResults, SmartMatcher, ProfileMatcher, FundingOpportunities, FundingLibrary, FoundationSearch, Funder, DataSources, SourceDirectory, NOFOParser, AIGrantScorer, Pipeline, HamiltonProcessing, Applications, Proposals, Documents, PrintableApplication, GrantDeadline, GrantMonitoring, Reports, AdvancedAnalytics, Outreach, Automation, Billing, Budgets, Diagnostics, CrawlCoverage, Admin and Help. All rendered without uncaught browser errors.
- Selecting the owner's business profile in Discover restored profile-specific results and enabled the search control.
- Live catalog search narrowed results, a temporary saved search restored its filters, and deletion removed the temporary search. Opportunity detail opened with source/verification evidence. Pipeline loaded existing work and summary stages.
- 201 focused classification, read-contract and pipeline tests pass, including historical-award rejection for individuals and organizations despite a mocked high-score ACCEPT, plus idempotent bounded catalog reconciliation preserving application progress. Result-card/adapter/classifier follow-up passed 48 tests. Dynamic-SQL check passes.

## UNKNOWN / continuing verification

The 36-route check establishes navigation and loading, not every underlying function. Rapid full-page navigation eventually returned three HTTP 429 responses from background `/api/anya/match-suggestions/pending` polling; no other API failures were observed in that pass. External calendar-provider imports, real payments, outgoing email, and actual grant submissions have not been performed. Deployment and the broader functional walkthrough must be verified separately; local fixtures are not production evidence.
