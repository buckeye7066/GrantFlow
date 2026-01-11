# PR Notes: #141 (DO NOT MERGE)

## Summary

PR **#141** (`copilot/improve-source-taxonomy-again` → `main`) is an **empty “plan PR”**: GitHub shows **0 changed files / 0 additions / 0 deletions**.

Locally, the branch is **ahead by 1 commit** (message: `Initial plan`) but produces **no file diff** against `main`.

**Merging #141 would do nothing**—no taxonomy changes would land.

## Evidence (local)

- The remote branch exists: `origin/copilot/improve-source-taxonomy-again`
- `git log origin/main..origin/copilot/improve-source-taxonomy-again` shows **one commit**.
- `git diff --stat origin/main..origin/copilot/improve-source-taxonomy-again` shows **no output** (no file changes).

## What replaces PR #141

We will replace this plan-only PR with a real implementation PR on:

- Branch: `fix/source-taxonomy-naming`

### Goal (real fix)

Eliminate the naming collision where **`source_type`** is used for two different concepts:

1. **Organization/source classification** (many values; used in UI/forms, e.g. `university`, `service_club_rotary`, etc.)
2. **Listing type** (few values: `OPPORTUNITY|PROGRAM|DIRECTORY`; used in crawler/ingestion logic)

### Strategy

- Keep org/source classification as **`source_type`** (UI + Source Directory)
- Use **`listing_type`** (or an equivalent explicit name) for the crawler/ingestion concept
- Maintain backward compatibility for one release by returning/mapping legacy fields explicitly (no silent meaning changes)

## Action

**Close PR #141** as “no code changes / empty diff” and review the replacement PR instead.

