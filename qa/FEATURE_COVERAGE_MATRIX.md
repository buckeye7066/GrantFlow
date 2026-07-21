# EVA Feature Coverage Matrix

Auto-generated from `qa/portfolio-registry.json` + `qa/manifests/*.json` by
`qa/build-coverage-matrix.mjs`. Every portfolio app maps each advertised feature
to at least one automated journey **or** an explicit unautomated reason (enforced
by `validateManifest` + the totality test).

**Totals:** 19 apps · 111 features catalogued · 41 feature-groups with an automated journey · 41 journeys defined.

| Program | Runtime | Status | Features automated | Journeys | Notes |
|---|---|---|---|---|---|
| GrantFlow | web | available | 4/8 | 4 | 4 unautomated |
| FlexFactor | python-cli | available | 2/5 | 2 | 3 unautomated |
| Scout a Program | python-cli | available | 1/4 | 1 | 3 unautomated |
| SermonSmith | web | available | 2/8 | 3 | 6 unautomated |
| Repo Rewards | web | available | 2/5 | 2 | 3 unautomated |
| PromoPilot | web | available | 1/4 | 2 | 3 unautomated |
| Incognito | web | available | 3/6 | 2 | 3 unautomated |
| Mind Over Math | web | available | 2/6 | 2 | 4 unautomated |
| LiveHealth | web | available | 2/6 | 2 | 4 unautomated |
| Free and Clean | python-cli | available | 2/5 | 2 | 3 unautomated |
| GeneMap Discovery | web | available | 3/8 | 3 | 5 unautomated |
| ForgePress | electron | available | 1/4 | 1 | 3 unautomated |
| Family Stewardship Navigator | web | available | 2/7 | 2 | 5 unautomated |
| Family Castle Clash | web | available | 3/6 | 2 | 3 unautomated |
| Factory Deck | web | blocked_by_external_service | 2/6 | 2 | 4 unautomated |
| App Store Publisher | web | available | 2/6 | 2 | 4 unautomated |
| Are We Mice Or Are We Men | web | available | 2/7 | 2 | 5 unautomated |
| CRISPR Compass | web | available | 2/4 | 2 | 2 unautomated |
| Kidney Antigen Discovery | web | available | 3/6 | 3 | 3 unautomated |

## Reading this table

- **Status** is the truthful runtime availability from the registry
  (`available`, `blocked_by_external_service`, etc.). A blocked app still ships a
  manifest and a launch-smoke journey; its journeys report `blocked`, never a
  fabricated pass.
- **Features automated** = coverage entries backed by a journey ÷ total catalogued
  features. The remainder each carry an `unautomated_reason` in the manifest
  (e.g. "needs seeded DB fixture", "would submit real data — prohibited").
- **Journeys** = concrete end-user journeys defined in the manifest. Nightly runs
  execute each app's `nightly_critical_journeys`; the weekly run executes the full
  set.

Per-app prohibited-action policies and allowlists live in each
`qa/manifests/<app_id>.json`.
