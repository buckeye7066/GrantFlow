#!/usr/bin/env bash
# Codex Cloud setup script — GitHub CLI + git credentials for the task container.
#
# WHY THIS EXISTS
#   Codex cloud containers start with an unauthenticated `gh` ("GitHub CLI is not
#   authenticated, and no repository remote is configured"). Codex itself can still
#   push a branch and open a PR through its native GitHub connector, but anything the
#   agent runs *inside* the container (gh pr create, gh api, git push) has no
#   credential of its own.
#
# HOW IT WORKS
#   Codex strips `secrets` from the environment before the agent phase starts, so a
#   GITHUB_TOKEN secret is visible HERE and nowhere else. This script spends that
#   one-time visibility on `gh auth login`, which persists the credential to
#   ~/.config/gh/hosts.yml. That FILE survives into the agent phase, so gh stays
#   authenticated even though the env var is gone. Storing the token as a plain
#   env_var instead would work too, but would expose it to every command the agent
#   (and any repo code it runs) executes. This is the smaller blast radius.
#
# CONTRACT
#   Idempotent, and it FAILS LOUDLY. A setup script that shrugs and continues
#   unauthenticated recreates the exact defect it was written to fix.
set -euo pipefail

fail() { echo "FATAL(codex-setup): $*" >&2; echo "FAILED: $*" >>"$HOME/.codex-setup-marker" 2>/dev/null || true; exit 1; }
note() { echo "codex-setup: $*"; }

# Breadcrumb the agent phase can read, so "the script failed" is distinguishable
# from "the script never ran at all". Written before anything can fail.
: >"$HOME/.codex-setup-marker" 2>/dev/null || true
echo "started $(date -u +%FT%TZ) rev=2" >>"$HOME/.codex-setup-marker" 2>/dev/null || true
note "STARTING (rev 2)"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo" || fail "not root and no sudo available"
fi

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
# Report presence by LENGTH ONLY -- never echo the value into the setup log.
if [ -n "$TOKEN" ]; then
  note "GITHUB_TOKEN/GH_TOKEN secret visible to setup: yes (${#TOKEN} chars)"
  echo "token_visible=yes len=${#TOKEN}" >>"$HOME/.codex-setup-marker" 2>/dev/null || true
else
  note "GITHUB_TOKEN/GH_TOKEN secret visible to setup: NO"
  echo "token_visible=no" >>"$HOME/.codex-setup-marker" 2>/dev/null || true
fi
[ -n "$TOKEN" ] || fail "no GITHUB_TOKEN/GH_TOKEN secret is set for this environment.
  Add it at https://chatgpt.com/codex/settings/environments -> this environment -> Secrets."

# --- 1. Make sure gh exists -------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  note "gh not present; installing GitHub CLI from the official apt repo"
  $SUDO mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
    || fail "could not fetch the GitHub CLI apt keyring"
  $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq gh || fail "apt-get install gh failed"
fi
command -v gh >/dev/null 2>&1 || fail "gh is still not on PATH after install"
note "gh version: $(gh --version | head -1)"

# --- 2. Authenticate gh -----------------------------------------------------
# TRAP: `gh auth login` exits 1 with "The value of the GITHUB_TOKEN environment
# variable is being used for authentication" whenever GH_TOKEN/GITHUB_TOKEN is set.
# Verified against gh 2.98.0. So the env vars must be unset for this one call --
# `printf '%s' "$GITHUB_TOKEN" | gh auth login --with-token` on its own ALWAYS FAILS.
# --insecure-storage forces the credential into ~/.config/gh/hosts.yml rather than a
# keyring that would not exist in (or survive) this container.
GH_CLEAN="env -u GITHUB_TOKEN -u GH_TOKEN"
printf '%s' "$TOKEN" | $GH_CLEAN gh auth login --hostname github.com --with-token --insecure-storage \
  || fail "gh auth login --with-token rejected the token (revoked? expired? wrong prefix?)"

# Prove it took with a real API call. `gh auth status` is NOT proof -- it reports a
# green check for a merely-present env token, which is how a dead credential hides.
LOGIN="$($GH_CLEAN gh api user --jq .login)" \
  || fail "gh api user failed after login -- the token is present but not valid"
[ -n "$LOGIN" ] || fail "gh api user returned an empty login"
note "authenticated to github.com as: $LOGIN"

# --- 3. Hand the credential to git ------------------------------------------
$GH_CLEAN gh auth setup-git --hostname github.com || fail "gh auth setup-git failed"

# Commit identity is DERIVED from whichever account the token belongs to, never
# hardcoded: no personal address ends up in this repo (a privacy guard test
# enforces that) or in the commit metadata, and the script stays portable to any
# account. GitHub's noreply form is <id>+<login>@users.noreply.github.com and
# still links commits to the right profile.
GH_ID="$($GH_CLEAN gh api user --jq .id)" || fail "could not read the account id from gh api user"
git config --global user.name  "$LOGIN"
git config --global user.email "${GIT_AUTHOR_EMAIL:-${GH_ID}+${LOGIN}@users.noreply.github.com}"
git config --global --replace-all safe.directory '*'
note "git identity: $(git config --global user.name) <$(git config --global user.email)>"

# --- 4. Make sure every checked-out repo has an origin remote ---------------
found_repo=0
for d in "${CODEX_WORKSPACE:-/workspace}"/*/ ; do
  [ -d "${d}.git" ] || continue
  found_repo=1
  (
    cd "$d"
    if ! git remote get-url origin >/dev/null 2>&1; then
      git remote add origin "https://github.com/${GITHUB_REPOSITORY_OWNER:-$LOGIN}/$(basename "$d").git"
      note "added missing origin for $(basename "$d")"
    fi
    note "$(basename "$d") origin = $(git remote get-url origin)"
  )
done
[ "$found_repo" = "1" ] || note "WARNING: no git checkout found under ${CODEX_WORKSPACE:-/workspace}"

# --- 5. Project dependencies -----------------------------------------------
# Setting a custom setup script REPLACES Codex's automatic setup (the env's
# use_auto_setup must be false or this script never runs at all -- that is why
# revision 1 appeared to do nothing). Auto-setup was what installed project
# dependencies, so this restores that behaviour rather than silently removing it.
#
# Best-effort by design: a failed dependency install is reported loudly but does
# NOT abort setup, because this script's contract is GitHub access. A hard failure
# here would take away the very credential the agent needs to report the problem.
for d in "${CODEX_WORKSPACE:-/workspace}"/*/ ; do
  [ -d "$d" ] || continue
  ( cd "$d"
    if   [ -f pnpm-lock.yaml ]  && command -v pnpm >/dev/null 2>&1; then pnpm install --frozen-lockfile
    elif [ -f yarn.lock ]       && command -v yarn >/dev/null 2>&1; then yarn install --frozen-lockfile
    elif [ -f package-lock.json ]; then npm ci
    elif [ -f package.json ];     then npm install
    fi
    if   [ -f poetry.lock ]     && command -v poetry >/dev/null 2>&1; then poetry install
    elif [ -f requirements.txt ]; then pip install -r requirements.txt
    fi
  ) || note "WARNING: dependency install failed in $(basename "$d") — continuing; the agent will see the failure when it builds."
done

echo "ok gh_login=$LOGIN $(date -u +%FT%TZ)" >>"$HOME/.codex-setup-marker" 2>/dev/null || true
note "OK — gh authenticated as $LOGIN, git credential helper and identity configured."
