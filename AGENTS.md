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

## Codex cloud: GitHub access inside the task container

Two different things authenticate to GitHub, and they fail independently:

1. **Codex's native GitHub connector** — how a cloud task pushes its branch and
   opens a PR. This is server-side and needs nothing from the container. It has
   been working; PRs opened by Codex tasks arrive under `codex/<slug>` branches.
   If a task says it "cannot open a PR", check the task's PR panel before
   believing it — the connector may already have opened one.
2. **The `gh` CLI *inside* the container** — used when the agent itself runs
   `gh api`, `gh pr create`, or `git push`. This starts unauthenticated and is
   what produces the preflight warning *"GitHub CLI is not authenticated, and no
   repository remote is configured."*

`scripts/codex-cloud-setup.sh` fixes (2). It is pasted into the **setup script**
box of the Codex environment at
<https://chatgpt.com/codex/settings/environments> — it is kept in the repo so it
is reviewable and versioned, but the copy that actually runs is the one stored in
Codex settings. **If you change this file, paste the new contents into the Codex
environment too, or nothing changes.**

Two traps it encodes, both verified against gh 2.98.0:

- `gh auth login --with-token` **exits 1** when `GH_TOKEN`/`GITHUB_TOKEN` is set
  in the environment ("The value of the GITHUB_TOKEN environment variable is
  being used for authentication"). The env vars must be cleared for that one
  call — hence `env -u GITHUB_TOKEN -u GH_TOKEN`.
- Codex **strips secrets before the agent phase starts**, so the token is only
  visible to the setup script. `--insecure-storage` writes the credential to
  `~/.config/gh/hosts.yml`, and that file is what carries authentication into the
  agent phase.

`gh auth status` is not proof of anything — it prints a green check for a merely
*present* env token, including a revoked one. Prove auth with a real call
(`gh api user`), which is what the setup script does before it will exit 0.

Agent-phase network access is off by default in a Codex environment; the GrantFlow
environment is set to `custom` with a GitHub-only domain allowlist. If a task needs
to reach anything else at runtime, that allowlist is where to add it.

### Opening and merging PRs from a Codex task

Open the PR through Codex's own connector (that is the path that works from the
cloud sandbox). To merge it, run `scripts/codex-merge-pr.sh <pr-number>`.

That script is the merge path for agent-authored PRs, and it carries the evidence
gate: `main` auto-deploys to Vercel production and this repo has **no branch
protection** (removed by owner order 2026-08-20), so GitHub will not stop a red
merge — the gate has to live in the merge step. The script refuses unless the PR
is open, non-draft, conflict-free, has no failing or cancelled checks, and has
`test` and `test-suite` both **present and passing**. Green means it merges by
itself, with no approval step; red means it refuses and names the failing checks.
There is no dry-run mode.

Do not use `.github/workflows/auto-merge-recent-prs.yml` for this. It is the
scheduled sweeper, it additionally requires a human approval, and no agent-authored
PR has ever satisfied that — which is why a separate explicit merge path exists.
Do not add a second scheduled sweeper; two competing auto-mergers on one repo is a
defect.
