# GrantFlow Feature Inventory

Date: 2026-08-07
AppName: **grant-flow** (confirmed, no change)

## Classification Legend
| Label | Meaning |
|-------|---------|
| Working | Functional, real data, production-safe |
| Partial | Functions but incomplete or unreliable |
| Broken | Not operational end-to-end |
| Simulated | Uses mock/fabricated data in production paths |
| Disconnected | Code exists but not wired to UI/API/data |
| Obsolete | Replaced or no longer relevant |

## 1. Identity & Tenancy
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| User registration & login | Partial | Session cookies exist; CSRF hardening incomplete. Risk: medium. |
| Organization switcher | Working | Needs tenant-filter audit on all queries. |
| Role-based access control | Partial | Roles exist in config; enforcement missing on several routes. Risk: high. |
| Account deletion | Disconnected | Endpoint stub returns success; no data purge or audit event. Risk: high. |
| Tenant isolation in workers | Partial | `tenantId` in payloads inconsistent; re-check missing. Risk: critical. |

## 2. Crawler / Ingestion
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| `crawler-os` adapter framework (12 adapters) | Partial | Structurally sound; several adapters return simulated fixtures when upstream fails or credentials absent. Risk: high. |
| Grants.gov adapter | Partial | Uses legacy XML endpoints; no pagination metadata retained. |
| Simpler.Grants.gov adapter | Disconnected | Adapter file missing; research confirms API is available. Risk: high. |
| USASpending.gov adapter | Disconnected | Not implemented; ideal for historical awards only. |
| NIH RePORTER adapter | Disconnected | Not implemented. |
| NSF / SBIR / state portals | Simulated | Placeholder data in seed fixtures. Risk: high. |
| Raw-record retention | Broken | Raw payloads not persisted to object storage; no content hashing. |
| Provenance (FieldProvenance) | Disconnected | Schema defined in spec; not created. Risk: high. |
| Checkpointing / incremental sync | Partial | Scheduler exists; no durable checkpoint state. |
| Rate limiting / backoff | Partial | Per-adapter delay only; no shared backoff. |
| Dead-letter handling | Obsolete | Old queue code removed; BullMQ DLQ not wired. |

## 3. Opportunities
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| Opportunity search | Partial | Uses Postgres; full-text index missing on key columns. |
| Opportunity detail | Partial | Some fields fabricated from profile inference. Risk: high. |
| Status separation (open/closed/forecast) | Broken | Same listing used; closed grants appear as open. Risk: critical. |
| Source transparency UI | Disconnected | No provenance panel in UI. |
| Deduplication | Partial | Hash-based only; no entity resolution or merge history. |

## 4. Matching
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| `matchEngine.js` | Partial | Single opaque score; hard eligibility not separated. Risk: critical. |
| Eligibility gate | Simulated | Boolean returned from heuristic; not enforced in ranking. |
| Relevance / competitiveness / readiness split | Disconnected | Not implemented. |
| Researcher/CV matching | Disconnected | Profile fields exist; no publication ingest. |
| Benchmark tests | Obsolete | Old scoring fixtures no longer match engine. |

## 5. Funder Intelligence
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| Funder profiles | Simulated | `funderBehavior.js` uses synthetic defaults. Risk: high. |
| Historical awards as open opps | Broken | Display path returns awards in opportunity list. Risk: critical. |
| IRS 990/990-PF ingest | Partial | `propublica990Adapter.js` fetches; no normalization. |

## 6. Documents & Knowledge
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| Document upload | Working | File validation partial; malware-scan missing. Risk: medium. |
| Knowledge library | Partial | Items stored; `approvedForAiUse` flag ignored by AI path. Risk: high. |
| Text extraction | Partial | PDF only; no structured extraction regression tests. |
| Prompt-injection flagging | Broken | `promptInjectionFlags` column not created. Risk: high. |

## 7. Proposal Development
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| Proposal workspace | Partial | No requirement matrix; AI ignores word/char limits. |
| AI drafting | Partial | Provider abstraction exists; citation enforcement missing. Risk: high. |
| Collaboration (comments/approvals) | Partial | Comments exist; approvals and version compare missing. |
| Submission packet generation | Disconnected | Button present but no backend. Risk: high. |

## 8. Lifecycle / Pipeline
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| Pipeline stages | Working | Stages defined; transitions not gated. |
| Submission confirmation gate | Broken | Item can be marked submitted without confirmation. Risk: critical. |
| Post-award (reporting, spenddown, cost share) | Disconnected | Schema defined; not implemented. |
| Calendar/deadlines | Partial | Tasks have dueDate; no aggregate calendar view. |

## 9. Alerts & Saved Searches
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| Saved searches | Partial | Stored; no alert evaluation worker. |
| Funder following | Disconnected | Follow table not created. |
| Deadline-change alerts | Broken | No diffing against previous fetch. |

## 10. Security / Observability
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| CSRF protection | Broken | Missing on mutation routes. Risk: critical |
| SSRF protection on URL fetch | Partial | `safeUrl.js` checks protocol; DNS redirect gap. Risk: high. |
| Audit events | Partial | Some events logged; no before/after hashes. |
| Structured logging | Working | pino in use; redaction incomplete. |
| Metrics / traces | Disconnected | OpenTelemetry imported; not initialized. |

## 11. Testing
| Feature | Classification | Notes / Risk |
|---------|---------------|-------------|
| Unit tests | Partial | Crawler-os suites strong; backend services thin. |
| Migration tests | Obsolete | No migration test harness. |
| Connector contract tests | Disconnected | No interface contract suite. |
| E2E (Playwright) | Partial | Smoke only; no applicant-type journeys. |
| Performance tests | Disconnected | None. |
| Accessibility (axe) | Disconnected | Pipeline stage only; no runtime checks. |

## Summary Counts
| Status | Count |
|--------|-------|
| Working | 7 |
| Partial | 22 |
| Broken | 8 |
| Simulated | 4 |
| Disconnected | 16 |
| Obsolete | 4 |

## Migration Risk Highlights
1. Existing opportunities without provenance must be backfilled or quarantined before enforcing `opportunity_requires_source`.
2. Historical awards currently mixed with opportunities; separation migration must run before UI enforces distinct views.
3. Submission gating introduced in two phases: warn then enforce.
4. Deduplication changes must preserve all source records.
5. Tenant isolation gaps in workers and exports are critical; fix before adding new shared connectors.

## Recommended Phase Order
1. **Harden & remove simulation**: production paths, status separation, submission gate, tenant isolation, CSRF.
2. **Real ingestion**: connector framework, provenance, raw records, checkpointing, dedup.
3. **Matching**: split eligibility/relevance/competitiveness/readiness; benchmarks; researcher flow.
4. **Proposal & AI safety**: requirement matrix, approved-knowledge gating, citations, safety flags.
5. **Funder intel & post-award**: historical awards, IRS 990 normalization, reporting/spenddown.
6. **Operational readiness & test coverage**: observability, perf, E2E journeys, adversarial cases.
