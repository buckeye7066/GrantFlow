# GrantFlow Agent Automation Charter

> **Canonical doctrine for GrantFlow's autonomous agent system.**
> This is the single source of truth that every agent, adapter, scheduler, and
> route defers to. Where a per-agent doc and this charter disagree, **this
> charter wins** — update the per-agent doc, not the charter, unless the doctrine
> itself is changing.

Status: **active** · Owner/admin: `owner@example.invalid` · Last reviewed: 2026-07-07

The owner-ratified product thesis (four pillars + the measured Google-bar) and
the self-improvement loop this charter's agents serve are defined in
[canonical_rules.md](./canonical_rules.md) ("The product thesis"); the per-agent
mission/inputs/outputs one-pager is [AGENTS.md](./AGENTS.md).

---

## 1. Master Doctrine — Automation Is King

GrantFlow runs as an **automation-first funding engine**. The agents do the work;
the human reviews exceptions.

1. **Agents act, not merely advise.** A finding that ends in a report and no
   action is a failure of the agent, not a feature.
2. **Human involvement is the exception.** Escalate only for true *hard stops*
   (see §3). Everything else, the agent resolves and records.
3. **Background by default.** Every agent runs whether or not anyone is logged
   in, on schedules/locks/heartbeats (see [AGENT_CONTROL_CENTER.md](./AGENT_CONTROL_CENTER.md)).
4. **All work is persisted, audited, resumable, and visible.** If it isn't in a
   table with a run row and an audit trail, it didn't happen.
5. **Escalation is explicit and narrow.** Legal, destructive, credential,
   payment, or genuinely ambiguous decisions go to the admin — nothing else.

---

## 2. Canonical Agents

Each agent has exactly one home adapter under
`backend/services/agentControl/agentAdapters/` and one service area under
`backend/services/<agent>/`. **No agent overlaps another's job.**

| Agent | Role | Service area | Per-agent doc |
|-------|------|--------------|---------------|
| **Anya** | User guide, automation navigator, code-error repair operator, and the owner's morning brief | `backend/services/anya/` | (see Anya services) |
| **Amy** | Coverage-gap closer: synthetic crawler training + empirical KEEP/REVERT tuning (no adapter under `agentAdapters/` — she runs via `amyScheduler.js`) | `backend/services/amy/` | [AMY_AGENT.md](./AMY_AGENT.md) |
| **Yana** | Client discovery (lead intelligence) | `backend/services/yana/` | this charter §4 |
| **John** | Outreach draft writer (drafts only — never sends) | `backend/services/john/` | [JOHN_OUTREACH_AGENT.md](./JOHN_OUTREACH_AGENT.md) |
| **Sam** | Code supervisor / self-healing engineering | `backend/services/sam/` | [SAM_PRODUCTION_AGENT.md](./SAM_PRODUCTION_AGENT.md), [SAM_AGENT_AUDITOR.md](./SAM_AGENT_AUDITOR.md) |
| **Robert** | Funding discovery | `backend/services/robert/` | [ROBERT_FUNDING_DISCOVERY_AGENT.md](./ROBERT_FUNDING_DISCOVERY_AGENT.md) |
| **Hamilton** | Application completion autopilot | `backend/services/hamilton/` | [HAMILTON_APPLICATION_AGENT.md](./HAMILTON_APPLICATION_AGENT.md), [HAMILTON_AUTOMATION_AGENT.md](./HAMILTON_AUTOMATION_AGENT.md) |

**Hard separations that must never blur:**

- **Yana ≠ Hamilton.** Yana finds *clients*; Hamilton completes *applications*.
  They have different inputs, queues, telemetry, and stop semantics, and are kept
  as separate adapters on purpose.
- **Yana ≠ John.** Yana qualifies leads; John drafts outreach. Yana **never**
  writes or sends email. John **never** searches the web or sends — drafts only.
- **Robert ≠ Hamilton.** Robert finds *funding sources*; Hamilton *applies* to a
  user-selected one.

The lead pipeline (Yana → John) is documented further in
[YANA_LEAD_PIPELINE_AGENT.md](./YANA_LEAD_PIPELINE_AGENT.md) and
[AGENT_MISSION_CONTROL.md](./AGENT_MISSION_CONTROL.md).

---

## 3. Global Rules (binding on every agent)

**Data integrity**

- No fake data. No placeholder funding. No junk/dead-link/lorem/mock opportunities.
- No silent failures — every error is logged, surfaced, and (where safe) retried.
- One canonical matcher and one canonical reality gate. **No duplicate matching
  authorities.** Agents call the shared matcher; they do not re-implement it.
- No UI-only patches for backend problems. Fix the cause, not the symptom.

**Persistence & lifecycle**

- Profile-scoped persistence — every artifact ties back to a profile and a run.
- Work in the background whether or not anyone is logged in.
- Notify the user (toast if logged in; persistent notification on next login) or
  the admin when action is needed.
- Resume automatically after a blocker is resolved.

**Hard-stop escalation** — agents escalate to the admin **only** for:
missing required information that can't be derived · login/SSO required ·
MFA/2FA · CAPTCHA / anti-bot · payment required · wet/digital signature ·
legal attestation · portal-terms block · destructive DB change · credential or
secret handling · genuinely ambiguous decisions.

**Safety (absolute — never, for any agent):** forge signatures · invent facts ·
bypass CAPTCHA · evade anti-bot systems · intercept 2FA · violate portal ToS ·
store raw credentials or card numbers · misuse FAFSA/FSA credentials · submit
unsafe legal attestations · expose secrets.

**Anya code-error repair rule:** when a code error is detected, Anya may make
any necessary code-error edit with full repository write access and without an
additional permission gate. She must log what changed, why it changed, backup or
rollback path, validation/tests attempted, and the result. This authority does
not override the absolute safety rules above.

---

## 4. Yana — Client Discovery (canonical rules)

Yana discovers prospective-client leads, qualifies them deterministically, and
forwards qualified leads to John.

- **Source layer:** the current, shippable layer is a **deterministic,
  network-free funnel over GrantFlow's own `organization` records**
  (`backend/services/yana/yanaLeadDiscovery.js`). This is the safe foundation the
  future broad-web crawler (up to 1,000+ sites) plugs into — it must keep the
  same qualify/cap/evidence contract.
- **Qualification gates (all four required):** a usable email · `lead_score ≥
  YANA_QUALIFY_THRESHOLD` (default 70) · at least one piece of public evidence ·
  at least one contact source URL.
- **Rolling cap (Rule 4):** Yana forwards **at most `YANA_DAILY_LEAD_CAP`
  (default 50) qualified leads to John per rolling 24-hour window**
  (`YANA_CAP_WINDOW_HOURS`, default 24). The window is *rolling*, measured
  backwards from now — not a calendar day — so Yana never bursts more than the
  cap in any 24h span. Highest-value leads (by `lead_score`, then urgency) are
  forwarded first. Implemented in `pushQualifiedToJohn()`; accounting
  (`cap`, `already_pushed_in_window`, `cap_reached`) is recorded on the run.
- **Yana never** sends email, completes applications, overlaps Hamilton, or
  forwards weak/fake/duplicate/low-evidence leads.
- **Tables:** `yana_lead_candidates`, `yana_lead_runs` (a *new* run table,
  distinct from the renamed `yana_runs`→`hamilton_runs`). John consumes via the
  registered Yana lead source (`johnYanaBridge`).

---

## 5. Background Execution Contract

Every agent that runs unattended must:

1. Run on a schedule or continuously, independent of login state.
2. Take a lock so duplicate runs never overlap.
3. Record heartbeats during long phases.
4. Persist a run row (start, complete/fail, summary) on every cycle.
5. Be pausable / stoppable / emergency-stoppable from the Agent Control Center.
6. Resume safely after restart or after a blocker clears.

See [AGENT_CONTROL_CENTER.md](./AGENT_CONTROL_CENTER.md) and
[AGENT_TELEMETRY_SCHEMA.md](./AGENT_TELEMETRY_SCHEMA.md) for the lock, heartbeat,
and telemetry schemas.

---

## 6. Sam's Automation Policy (defaults)

Sam may edit, save, test, and correct code — within guardrails:

- `auto_fix_safe = true` — deterministic, clearly-correct fixes applied directly.
- `auto_branch_risky = true` — risky fixes go to a branch/PR, never straight to main.
- `auto_commit_allowed` — configurable.
- `direct_main_commit = false` by default; enabled only by explicit admin policy.
- Never expose secrets. Never rewrite data destructively without a
  migration + rollback. Never hide an error or claim an untested fix worked.

---

## 7. Definition of Done (per the mission)

An agent feature is "done" only when: it acts (not just reports), persists every
artifact with a run + audit trail, runs in the background, escalates only true
hard stops, notifies the right party, resumes after blockers, introduces no fake
data / placeholder funding / silent failures / duplicate matching authority, and
ships with passing tests.

---

## 8. Self-Improvement Doctrine — the system only gets better

Binding on every agent (owner directive, 2026-07-06; full rule in
[canonical_rules.md](./canonical_rules.md) "The self-improvement loop"):

1. **Every owner-verified outcome becomes a golden expectation.** Verified
   results are appended as permanent nightly assertions (Sam check
   `coverage.goldenOutcomes`); expectations are data and are never silently
   removed.
2. **Every benchmark failure becomes queued work.** The web-parity benchmark
   (`system_kv` `web_parity_benchmark`, Sam check
   `coverage.webParityBenchmark`) measures each golden profile against a
   competent 30-minute web-search session; failures land in `system_kv`
   `web_parity_gap_queue` and the adapter wishlist — never in a shrug.
3. **No ratchet may regress without a red finding.** Parity scores, golden
   outcomes, and gap-scoreboard freshness are ratchets; a regression is a red
   Sam finding with a `recommended_fix`, not a trend line.
4. **Agent tasking is evidence-driven, never random.** Amy derives every
   training/crawl task from the gap scoreboard, structural matrix, and
   web-parity gap queue; tuning is empirical KEEP/REVERT (bounded, backed up,
   auto-reverted on mismatch).
5. **The owner stays in the loop, not on the hook.** Anya's morning brief
   surfaces what changed autonomously, the benchmark trend, top gaps,
   web-only finds awaiting judgment, and wishlist items needing a decision.
