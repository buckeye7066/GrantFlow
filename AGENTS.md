# AGENTS.md — context entry point for Codex/ChatGPT and other CLI agents

Read, in order, before doing any work in this repo:

1. `CLAUDE.md` (repo root) — the broadcast channel: invariants, traps, the
   portal-automation chain, and the edit-lock protocol. **If
   `.agent-edit-lock` exists at the repo root, do read-only work only.**
2. `docs/agent-sync/` — dated cross-assistant session briefs; the newest file
   is the current state of in-flight work and owner directives. As of this
   pass the newest file by commit date is
   `docs/agent-sync/2026-08-05-funder-behavior-graph.md` (2026-08-05, later
   same-day than `2026-08-05-discovery-lane-budget-awardable.md`) — do not
   assume this pointer stays accurate; always list the directory and sort by
   filename date to find the true latest.
3. `docs/canonical_rules.md` — the owner-ratified product rules.

House rules that bind every assistant (Claude, Cursor, Codex/ChatGPT):

- Absolute honesty: "fixed"/"verified" only with session-local evidence;
  separate CHANGED / VERIFIED / UNKNOWN in every report.
- Program awareness: wire every change through its full dependency chain
  (callers, API/UI boundary, tests, docs) — see
  `.cursor/rules/program-awareness.mdc`.
- Main is branch-protected: ship via PR; the binding checks must be green.
- Enforce product rules at ONE choke point (writer gate + engine gate + boot
  net + guard test), never per-code-path — per-path fixes are how junk
  survives.
- The owner's verdict bar: a change matters only if it moves the end-to-end
  number (real source found → applied → submitted → confirmed). Lead reports
  with that, never activity counts.
