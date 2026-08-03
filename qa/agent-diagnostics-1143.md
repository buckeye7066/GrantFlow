# PR #1143 one-shot diagnostics

## Exit codes

- `install`: `0`
- `lint`: `0`
- `typecheck`: `0`
- `tests`: `0`
- `build`: `0`

## install

```text
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@babel/parser@8.0.4',
npm warn EBADENGINE   required: { node: '^22.18.0 || >=24.11.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@babel/helper-string-parser@8.0.0',
npm warn EBADENGINE   required: { node: '^22.18.0 || >=24.11.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@babel/helper-validator-identifier@8.0.4',
npm warn EBADENGINE   required: { node: '^22.18.0 || >=24.11.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@babel/types@8.0.4',
npm warn EBADENGINE   required: { node: '^22.18.0 || >=24.11.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@capacitor/cli@8.4.2',
npm warn EBADENGINE   required: { node: '>=22.0.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@testing-library/jest-dom@7.0.0',
npm warn EBADENGINE   required: { node: '>=22', npm: '>=6', yarn: '>=1' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'concurrently@10.0.4',
npm warn EBADENGINE   required: { node: '>=22' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn deprecated whatwg-encoding@3.1.1: Use @exodus/bytes instead for a more spec-conformant and faster implementation
npm warn deprecated scmp@2.1.0: Just use Node.js's crypto.timingSafeEqual()
npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.
npm warn deprecated gm@1.25.1: The gm module has been sunset. Please migrate to an alternative. https://github.com/aheckmann/gm?tab=readme-ov-file#2025-02-24-this-project-is-not-maintained
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

> grant-flow@1.0.0 prepare
> node scripts/materialize-production-source.mjs

[source-materialization] link backlog lifecycle repair already present
[source-materialization] applied link backlog lifecycle correction
[source-materialization] link backlog candidate selection already safe
[source-materialization] applied link backlog candidate selection
[source-materialization] link backlog row isolation already present
[source-materialization] applied link backlog row isolation
[source-materialization] link verification success restore already present
[source-materialization] applied link verification success restore
[source-materialization] link backlog route lock already present
[source-materialization] applied link backlog route lock
[source-materialization] final link-backlog safety corrections already present
[source-materialization] applied link backlog final rescue and lock safety
[source-materialization] scheduled-retry mission anchors normalized
[source-materialization] applied link backlog scheduled-retry anchor normalization
[source-materialization] scheduled-retry lifecycle already present
[source-materialization] applied link backlog scheduled-retry lifecycle
[source-materialization] scheduled-retry portability already present
[source-materialization] applied link backlog scheduled-retry portability
[source-materialization] match-decision integrity already present
[source-materialization] applied persisted match-decision integrity
[source-materialization] prepared web-parity direct-source quality helpers
[source-materialization] applied web-parity source-quality prelude
[source-materialization] web-parity relevance, direct-source quality, and queue convergence applied
[source-materialization] applied web-parity relevance and queue correction
[source-materialization] finalized web-parity direct-source gate and exports
[source-materialization] applied web-parity direct-source finalization
[source-materialization] web-parity admin route already mounted
[source-materialization] applied web-parity background admin route
[source-materialization] Amy pre-profile work is bounded and fail-open
[source-materialization] Amy flywheel precision already present
[source-materialization] Amy exact-SHA cleanup already present
[source-materialization] Amy organization identity already deduplicated

added 1183 packages, and audited 1184 packages in 2m

303 packages are looking for funding
  run `npm fund` for details

3 high severity vulnerabilities

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
```

## lint

```text

> grant-flow@1.0.0 lint
> eslint --max-warnings 0 "src/**/*.{js,jsx}" "backend/**/*.js" "shared/**/*.js" "tests/unit/**/*.mjs"

```

## typecheck

```text

> grant-flow@1.0.0 typecheck
> tsc -p tsconfig.node.json --noEmit

```

## tests

```text

[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/runner/work/GrantFlow/GrantFlow[39m

 [32m✓[39m backend/tests/fundingSourceQueries.test.js [2m([22m[2m4 tests[22m[2m)[22m[32m 13[2mms[22m[39m
 [32m✓[39m backend/tests/coldStartFundingFallback.test.js [2m([22m[2m12 tests[22m[2m)[22m[32m 124[2mms[22m[39m
 [32m✓[39m backend/tests/productionProfileMatchingScope.test.js [2m([22m[2m12 tests[22m[2m)[22m[32m 14[2mms[22m[39m
 [32m✓[39m src/pages/itemFundingMatch.test.js [2m([22m[2m7 tests[22m[2m)[22m[32m 10[2mms[22m[39m
 [32m✓[39m backend/tests/fundingSourcesColdStartAuditGuard.test.js [2m([22m[2m2 tests[22m[2m)[22m[32m 4[2mms[22m[39m
 [32m✓[39m backend/tests/itemNeedSearch.test.js [2m([22m[2m33 tests[22m[2m)[22m[33m 480[2mms[22m[39m

[2m Test Files [22m [1m[32m6 passed[39m[22m[90m (6)[39m
[2m      Tests [22m [1m[32m70 passed[39m[22m[90m (70)[39m
[2m   Start at [22m 19:36:07
[2m   Duration [22m 3.36s[2m (transform 2.17s, setup 1.23s, import 4.64s, tests 645ms, environment 1ms)[22m

```

## build

```text

> grant-flow@1.0.0 prebuild
> node scripts/materialize-production-source.mjs && node scripts/ensure-build-natives.mjs

[source-materialization] link backlog lifecycle repair already present
[source-materialization] applied link backlog lifecycle correction
[source-materialization] link backlog candidate selection already safe
[source-materialization] applied link backlog candidate selection
[source-materialization] link backlog row isolation already present
[source-materialization] applied link backlog row isolation
[source-materialization] link verification success restore already present
[source-materialization] applied link verification success restore
[source-materialization] link backlog route lock already present
[source-materialization] applied link backlog route lock
[source-materialization] final link-backlog safety corrections already present
[source-materialization] applied link backlog final rescue and lock safety
[source-materialization] scheduled-retry mission anchors normalized
[source-materialization] applied link backlog scheduled-retry anchor normalization
[source-materialization] scheduled-retry lifecycle already present
[source-materialization] applied link backlog scheduled-retry lifecycle
[source-materialization] scheduled-retry portability already present
[source-materialization] applied link backlog scheduled-retry portability
[source-materialization] match-decision integrity already present
[source-materialization] applied persisted match-decision integrity
[source-materialization] prepared web-parity direct-source quality helpers
[source-materialization] applied web-parity source-quality prelude
[source-materialization] web-parity relevance, direct-source quality, and queue convergence applied
[source-materialization] applied web-parity relevance and queue correction
[source-materialization] finalized web-parity direct-source gate and exports
[source-materialization] applied web-parity direct-source finalization
[source-materialization] web-parity admin route already mounted
[source-materialization] applied web-parity background admin route
[source-materialization] Amy pre-profile work is bounded and fail-open
[source-materialization] Amy flywheel precision already present
[source-materialization] Amy exact-SHA cleanup already present
[source-materialization] Amy organization identity already deduplicated
[ensure-build-natives] ok (already present) {
  pkgs: [ '@rollup/rollup-linux-x64-gnu', '@esbuild/linux-x64' ],
  node: 'v20.20.2',
  ci: true,
  vercel: false,
  github_actions: true
}

> grant-flow@1.0.0 build
> vite build

[36mvite v8.1.5 [32mbuilding client environment for production...[36m[39m
[2K
transforming...✓ 4551 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                           2.21 kB │ gzip:   0.77 kB
dist/assets/print-CJlUdULM.css                            3.16 kB │ gzip:   0.79 kB
dist/assets/index-0sbaZcWE.css                          188.33 kB │ gzip:  27.40 kB
dist/assets/platform-DsUVRKXX.js                          0.15 kB │ gzip:   0.13 kB
dist/assets/items-CG5gBOHs.js                             0.26 kB │ gzip:   0.22 kB
dist/assets/safeUrl-pGZ6ur_E.js                           0.29 kB │ gzip:   0.19 kB
dist/assets/grantUtils-BsZXTpUr.js                        0.30 kB │ gzip:   0.20 kB
dist/assets/validators-D6KSzGYd.js                        0.33 kB │ gzip:   0.22 kB
dist/assets/fundingLibraryFormatters-CQ333R5M.js          0.35 kB │ gzip:   0.26 kB
dist/assets/amountDisplay-gysMp_QG.js                     0.37 kB │ gzip:   0.25 kB
dist/assets/aggregate-CP-SmtG1.js                         0.40 kB │ gzip:   0.21 kB
dist/assets/Incognito-BvBoHclS.js                         0.50 kB │ gzip:   0.35 kB
dist/assets/progress-CPbY_Gwz.js                          0.54 kB │ gzip:   0.36 kB
dist/assets/Money-Bt-_OkfF.js                             0.57 kB │ gzip:   0.39 kB
dist/assets/HelpTip-BnSKjjEm.js                           0.59 kB │ gzip:   0.36 kB
dist/assets/StatusDot-DFx-m8AT.js                         0.64 kB │ gzip:   0.38 kB
dist/assets/rolldown-runtime-b3L32Ng1.js                  0.69 kB │ gzip:   0.42 kB
dist/assets/AuthShell-B6QuLS8g.js                         0.73 kB │ gzip:   0.39 kB
dist/assets/useAuthenticatedAvatar-ExgnaJFu.js            0.79 kB │ gzip:   0.47 kB
dist/assets/radio-group-B44B9M4-.js                       0.84 kB │ gzip:   0.46 kB
dist/assets/popover-1ok3m0_c.js                           0.88 kB │ gzip:   0.47 kB
dist/assets/ServiceAgreement-DTSyHpXA.js                  0.91 kB │ gzip:   0.54 kB
dist/assets/dateUtils-BKFoZak8.js                         0.92 kB │ gzip:   0.39 kB
dist/assets/profileTypes-D2UNDuLy.js                      0.92 kB │ gzip:   0.52 kB
dist/assets/switch-BTqg1ltC.js                            0.93 kB │ gzip:   0.50 kB
dist/assets/documents-kHhBWMrZ.js                         0.93 kB │ gzip:   0.45 kB
dist/assets/comms-BKmgKSIl.js                             1.03 kB │ gzip:   0.37 kB
dist/assets/services-MMHlZgoq.js                          1.10 kB │ gzip:   0.38 kB
dist/assets/matching-07xNImWy.js                          1.11 kB │ gzip:   0.45 kB
dist/assets/grants-DV1gADAY.js                            1.13 kB │ gzip:   0.60 kB
dist/assets/tabs-BMUu83Z-.js                              1.21 kB │ gzip:   0.52 kB
dist/assets/preload-helper-BATLnrmA.js                    1.22 kB │ gzip:   0.70 kB
dist/assets/pipelineStages-B2CYWEEv.js                    1.36 kB │ gzip:   0.64 kB
dist/assets/ProfileSelect-B1Qu5Upp.js                     1.39 kB │ gzip:   0.71 kB
dist/assets/useTierEntitlements-DL3WWqNx.js               1.40 kB │ gzip:   0.79 kB
dist/assets/FieldHelpTip-B3EYd4qr.js                      1.45 kB │ gzip:   0.85 kB
dist/assets/CheckoutRequired-Bf8YIAgE.js                  1.47 kB │ gzip:   0.82 kB
dist/assets/foundations-10SQ5zKt.js                       1.59 kB │ gzip:   0.58 kB
dist/assets/table-DuKZ-8xi.js                             1.69 kB │ gzip:   0.60 kB
dist/assets/authenticatedDownload-DSzbzE_u.js             1.90 kB │ gzip:   0.81 kB
dist/assets/MatchScoreGuidanceBand-DcfIJvYC.js            1.91 kB │ gzip:   0.97 kB
dist/assets/savedGrantsStore-kfXE5BLb.js                  1.92 kB │ gzip:   0.85 kB
dist/assets/button-CPDk2mWo.js                            2.12 kB │ gzip:   1.06 kB
dist/assets/alert-dialog-DHcKtvgU.js                      2.16 kB │ gzip:   0.79 kB
dist/assets/use-toast-m9FuxqWj.js                         2.24 kB │ gzip:   1.15 kB
dist/assets/env-BM9EM91n.js                               2.29 kB │ gzip:   0.90 kB
dist/assets/ServiceAgreementGate-BN0m4THm.js              2.51 kB │ gzip:   1.27 kB
dist/assets/PortalLoginButton-CYdrDssV.js                 2.56 kB │ gzip:   1.16 kB
dist/assets/SetPassword-DQkH1Plg.js                       2.69 kB │ gzip:   1.23 kB
dist/assets/crawlers-DWKtPg9j.js                          2.96 kB │ gzip:   1.12 kB
dist/assets/MultiSelectCombobox-BSoj3pCt.js               2.98 kB │ gzip:   1.32 kB
dist/assets/QuickAddDialog-WNjbcvcm.js                    3.12 kB │ gzip:   1.40 kB
dist/assets/PrintPipeline-qZwAOsxm.js                     3.17 kB │ gzip:   1.41 kB
dist/assets/UploadFormDialog-fgruWQ94.js                  3.20 kB │ gzip:   1.45 kB
dist/assets/EndUserHelp-CzzgMpbk.js                       3.28 kB │ gzip:   1.44 kB
dist/assets/PrintablePipeline-CohCtxFB.js                 3.45 kB │ gzip:   1.37 kB
dist/assets/TierMatrix-BT-SERQ8.js                        3.60 kB │ gzip:   1.41 kB
dist/assets/AuthCallback-Gl22f3oa.js                      3.66 kB │ gzip:   1.71 kB
dist/assets/pipelineStageHelp-i-w7IPAB.js                 3.69 kB │ gzip:   1.34 kB
dist/assets/PricingCheckoutPanel-CrOFQyHy.js              3.84 kB │ gzip:   1.66 kB
dist/assets/NewProject-BdusmKsF.js                        4.03 kB │ gzip:   1.48 kB
dist/assets/HamiltonAutomationQueue-CuDdv3n8.js           4.07 kB │ gzip:   1.70 kB
dist/assets/PricingRequired-CRneA57U.js                   4.31 kB │ gzip:   1.66 kB
dist/assets/AutomatedSearchConfig-6GiAQRBo.js             4.38 kB │ gzip:   1.86 kB
dist/assets/BackfillContacts-D1ggcEcY.js                  4.71 kB │ gzip:   1.80 kB
dist/assets/hamiltonWatchedOpen-Ci-krlOZ.js               4.76 kB │ gzip:   2.00 kB
dist/assets/SavedGrants-DIWYQAud.js                       4.90 kB │ gzip:   1.84 kB
dist/assets/PrintAwardSummary-D4UPGK_M.js                 4.93 kB │ gzip:   1.70 kB
dist/assets/HamiltonHardStopChecklist-DL2NUxmY.js         5.31 kB │ gzip:   2.07 kB
dist/assets/VNextFinishPacket-kCWBbNg2.js                 5.38 kB │ gzip:   1.62 kB
dist/assets/VNextApplication-B3kUXWt8.js                  5.56 kB │ gzip:   2.05 kB
dist/assets/Login-D1jq3SjR.js                             5.57 kB │ gzip:   2.36 kB
dist/assets/zustand-vendor-DgBGBzsw.js                    5.88 kB │ gzip:   2.29 kB
dist/assets/UploadApplicationForm-B2QbmFYb.js             5.92 kB │ gzip:   2.34 kB
dist/assets/Diagnostics--upnX6zq.js                       6.07 kB │ gzip:   2.62 kB
dist/assets/Budgets-a_x0vD_E.js                           6.16 kB │ gzip:   2.01 kB
dist/assets/profileTypeOptions-CUBb0ANT.js                7.11 kB │ gzip:   2.37 kB
dist/assets/DocumentItem-DkPCu2CA.js                      7.45 kB │ gzip:   3.04 kB
dist/assets/Help-CSAxLfVd.js                              7.79 kB │ gzip:   2.95 kB
dist/assets/BudgetDetail-dB7gJv7s.js                      8.00 kB │ gzip:   2.15 kB
dist/assets/AdvancedFilters-DQfmDZve.js                   8.10 kB │ gzip:   2.19 kB
dist/assets/OneTimeFix-CcSvHBR4.js                        8.24 kB │ gzip:   2.75 kB
dist/assets/GrantDeadline-DVb-x7O9.js                     8.52 kB │ gzip:   2.46 kB
dist/assets/Pricing-D1G2oIg3.js                           8.64 kB │ gzip:   2.69 kB
dist/assets/PrivacyPolicy-B92kJJyy.js                     8.68 kB │ gzip:   3.06 kB
dist/assets/HamiltonInlineHardStopFix-W6N5ru6t.js         8.86 kB │ gzip:   3.20 kB
dist/assets/Stewardship-RvD4qJOY.js                       9.10 kB │ gzip:   3.00 kB
dist/assets/ZeroResultGuidance-DMu4f_bM.js                9.28 kB │ gzip:   3.16 kB
dist/assets/Outreach-qGQQFUyu.js                          9.62 kB │ gzip:   2.89 kB
dist/assets/AdvancedAnalytics-CQCXffI1.js                 9.67 kB │ gzip:   2.55 kB
dist/assets/EndUserCalendar-CkC1zYgX.js                   9.69 kB │ gzip:   3.60 kB
dist/assets/ComplianceReportDetail-Cij53taV.js            9.82 kB │ gzip:   2.70 kB
dist/assets/Services-tXNzQnos.js                         10.28 kB │ gzip:   2.99 kB
dist/assets/HamiltonProcessing-CWG69wTn.js               10.49 kB │ gzip:   3.85 kB
dist/assets/HamiltonAutopilotAuthorization-DtG64ssm.js   10.63 kB │ gzip:   3.50 kB
dist/assets/HamiltonLiveLogin-DtotoU_3.js                10.82 kB │ gzip:   3.87 kB
dist/assets/PrintProfilePacket-ViZftcJI.js               11.09 kB │ gzip:   3.20 kB
dist/assets/ProfileMatcher-BrwPPnUL.js                   11.14 kB │ gzip:   3.74 kB
dist/assets/Proposals-dlU0r-R0.js                        11.14 kB │ gzip:   3.74 kB
dist/assets/AnyaIntakeResults-BrG80X89.js                11.35 kB │ gzip:   3.72 kB
dist/assets/Apply-BCfY69-B.js                            11.44 kB │ gzip:   3.62 kB
dist/assets/AIGrantScorer-D9Oe9gRu.js                    11.65 kB │ gzip:   4.02 kB
dist/assets/FundingResults-CufXdk5v.js                   11.69 kB │ gzip:   4.46 kB
dist/assets/hamilton-DrxnxjD_.js                         11.97 kB │ gzip:   2.87 kB
dist/assets/CrawlCoverage-R_2tyQkI.js                    12.05 kB │ gzip:   3.71 kB
dist/assets/Calendar-CgEdnz9O.js                         12.15 kB │ gzip:   4.07 kB
dist/assets/EndUserPipeline-BQni3DMe.js                  12.82 kB │ gzip:   4.31 kB
dist/assets/FundingLibrary-DL6dlCTz.js                   13.02 kB │ gzip:   4.05 kB
dist/assets/Landing-BEzuylz9.js                          13.08 kB │ gzip:   3.81 kB
dist/assets/toCanonicalResult-CzKJL65O.js                13.20 kB │ gzip:   4.41 kB
dist/assets/GrantMonitoring-CF8hJDxQ.js                  13.42 kB │ gzip:   3.91 kB
dist/assets/command-Cnw5zfIi.js                          14.04 kB │ gzip:   5.37 kB
dist/assets/Reports-fopC5vDn.js                          14.11 kB │ gzip:   4.19 kB
dist/assets/PipelineAutomationPanel-CqtoHUWV.js          14.32 kB │ gzip:   4.15 kB
dist/assets/SubmissionAssistant-BLwvd2Rw.js              14.75 kB │ gzip:   4.00 kB
dist/assets/Settings-B_Bnct3d.js                         14.93 kB │ gzip:   3.43 kB
dist/assets/ServiceApplication-DlQJNquQ.js               15.44 kB │ gzip:   4.39 kB
dist/assets/InvoiceView-D_MTTfCQ.js                      15.56 kB │ gzip:   4.54 kB
dist/assets/profileAvatarAI-BRuVZxgb.js                  15.79 kB │ gzip:   5.63 kB
dist/assets/Start-BFgqjWO7.js                            16.20 kB │ gzip:   5.01 kB
dist/assets/MyProfiles-DCagPGGI.js                       16.23 kB │ gzip:   4.96 kB
dist/assets/Funder-DA5O7N1G.js                           16.46 kB │ gzip:   5.09 kB
dist/assets/HamiltonTaskDrawer-DErgTyXK.js               17.20 kB │ gzip:   4.80 kB
dist/assets/client-cNOKpHaJ.js                           18.18 kB │ gzip:   5.96 kB
dist/assets/Applications-BrOMzE1p.js                     18.34 kB │ gzip:   4.94 kB
dist/assets/SourceRegistry-BQzlDCfz.js                   18.47 kB │ gzip:   5.55 kB
dist/assets/CoverageEvidence-zt02ts-Q.js                 18.66 kB │ gzip:   5.64 kB
dist/assets/Organizations-CJAR_nWn.js                    18.89 kB │ gzip:   6.10 kB
dist/assets/Documents-CvaHTOAh.js                        20.68 kB │ gzip:   6.19 kB
dist/assets/DataSources-BsO5rB4G.js                      20.73 kB │ gzip:   6.24 kB
dist/assets/CreateInvoice-CRToLc8S.js                    21.56 kB │ gzip:   6.62 kB
dist/assets/Pipeline-mjedIAYu.js                         22.86 kB │ gzip:   7.64 kB
dist/assets/NOFOParser-SMqcJzHX.js                       24.17 kB │ gzip:   7.71 kB
dist/assets/SearchResults-wcKwXKTg.js                    25.00 kB │ gzip:   8.50 kB
dist/assets/FoundationSearch-B6h4va6d.js                 27.08 kB │ gzip:   7.27 kB
dist/assets/utils-BlIHIBVp.js                            27.45 kB │ gzip:   8.76 kB
dist/assets/BillingSheet-Be8NOaBN.js                     27.51 kB │ gzip:   6.18 kB
dist/assets/date-fns-bwzg82WA.js                         27.73 kB │ gzip:   8.26 kB
dist/assets/ItemFunding-BaO5XDo-.js                      31.56 kB │ gzip:   9.43 kB
dist/assets/query-CNmuyzF_.js                            32.45 kB │ gzip:   9.97 kB
dist/assets/Billing-Kg5whU-z.js                          32.66 kB │ gzip:   8.75 kB
dist/assets/index.esm-B109dAwB.js                        36.27 kB │ gzip:  13.09 kB
dist/assets/SmartMatcher-Cp_Reifw.js                     36.44 kB │ gzip:   9.61 kB
dist/assets/SourceDirectory-eaLYAO0J.js                  38.93 kB │ gzip:  10.53 kB
dist/assets/AddExpenseForm-DDLTl9w9.js                   39.01 kB │ gzip:  12.49 kB
dist/assets/KanbanBoard-BJ13p2mq.js                      41.64 kB │ gzip:  12.48 kB
dist/assets/PrintableApplication-Dt-XebEn.js             41.75 kB │ gzip:   6.50 kB
dist/assets/ProfilePortalsCard-v-LKeWob.js               46.12 kB │ gzip:  13.03 kB
dist/assets/ComprehensiveApplicationForm-DWMvqVzl.js     51.14 kB │ gzip:  12.25 kB
dist/assets/Dashboard-DyhDIFmo.js                        53.12 kB │ gzip:  13.57 kB
dist/assets/lucide-react-CnuAHLJx.js                     53.89 kB │ gzip:  17.21 kB
dist/assets/FundingOpportunities-wKLcbih9.js             61.39 kB │ gzip:  17.00 kB
dist/assets/DiscoverGrants-BuyUeuhu.js                   65.45 kB │ gzip:  20.61 kB
dist/assets/zod-DJaR4B6y.js                              68.63 kB │ gzip:  18.54 kB
dist/assets/Automation-CV9gmkZl.js                       70.73 kB │ gzip:  16.07 kB
dist/assets/OrganizationProfile-kj4HlFZY.js              84.72 kB │ gzip:  20.11 kB
dist/assets/dnd.esm-GXK7o5Ni.js                          89.66 kB │ gzip:  27.64 kB
dist/assets/GrantDetail-C3-V3mMR.js                     105.44 kB │ gzip:  27.15 kB
dist/assets/OrganizationForm-Ddmq_d0D.js                116.25 kB │ gzip:  24.38 kB
dist/assets/lib-BljN4xpf.js                             117.14 kB │ gzip:  36.18 kB
dist/assets/react-vendor-DdXjt8AI.js                    145.11 kB │ gzip:  47.00 kB
dist/assets/radix-ui-CtqhiztB.js                        294.70 kB │ gzip:  80.55 kB
dist/assets/Admin-DOCNNHZF.js                           319.10 kB │ gzip:  72.99 kB
dist/assets/recharts-CnJc7QuI.js                        421.77 kB │ gzip: 121.60 kB
dist/assets/ProfileDetail-BvG_BUEu.js                   426.50 kB │ gzip: 111.96 kB
dist/assets/index-DqwtEQx7.js                           576.20 kB │ gzip: 170.49 kB

[32m✓ built in 3.97s[39m
```
