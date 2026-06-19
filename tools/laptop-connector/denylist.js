/**
 * denylist — the privacy boundary that sits BEFORE the check-off gate.
 *
 * The owner asked to scan "all of C: and G:". That breadth sweeps in regulated
 * and privileged data that legally must not flow into GrantFlow (which forwards
 * text to third-party AI processors). This denylist excludes those folders by
 * default. It is editable — the admin can remove entries with a legal basis —
 * but it ships PROTECTIVE.
 *
 * Matching is path-substring based, case-insensitive, on normalized (forward-
 * slash, lowercased) paths. Any file or directory whose path contains one of
 * these segments is skipped entirely (the walker never descends into it).
 */

// Regulated / privileged / sensitive — do NOT ingest into a cloud SaaS.
export const PROTECTED_DENYLIST = [
  // PHI — TherapAI clinical documentation (HIPAA). Hard exclude.
  '/therap-auto',
  // Active legal dispute evidence (Affirm / Springs / CRISPR toolkit).
  '/affirmcallcapture',
  '/affirmspringsevidence',
  '/call931capture',
  '/forwarded931flag',
  '/callrecordings',
  // Privacy vault (Incognito) — canonical + stale copy.
  '/incognito',
  // Private one-family financial planning data.
  '/family-stewardship-navigator',
]

// System / junk / non-document trees — skip for correctness + speed.
export const SYSTEM_DENYLIST = [
  '/windows',
  '/program files',
  '/program files (x86)',
  '/programdata',
  '/appdata',
  '/$recycle.bin',
  '/system volume information',
  '/recovery',
  '/node_modules',
  '/.git',
  '/.cache',
  '/.npm',
  '/.vscode',
  '/dist',
  '/build',
  '/.next',
  '/venv',
  '/__pycache__',
  // Temp trees (any 'temp'/'tmp' segment) — scratch, not real documents.
  '/temp/',
  '/tmp/',
  // AI-tool + dev caches: contain pasted/scratch content (often sensitive) and
  // generated noise, NOT the owner's real documents. Never ingest.
  '/.cursor',
  '/.claude',
  '/paste-cache',
  '/.continue',
  '/.ollama',
  '/.idea',
  '/.gradle',
  '/.m2',
  '/.nuget',
  '/.android',
  '/.docker',
  // Credential / secret stores — must never be parsed into a SaaS.
  '/.aws',
  '/.ssh',
  '/.gnupg',
  '/.azure',
  '/.config/gcloud',
]

/**
 * Normalize a Windows or POSIX path for matching: lowercase, forward slashes,
 * leading slash so segment matches like '/incognito' are anchored on boundaries.
 */
export function normalizeForMatch(p) {
  let s = String(p || '').replace(/\\/g, '/').toLowerCase()
  // Strip drive letter (c:/ → /) so '/windows' style segments match uniformly.
  s = s.replace(/^[a-z]:/, '')
  if (!s.startsWith('/')) s = `/${s}`
  return s
}

export function buildDenylist(extra = []) {
  const all = [...PROTECTED_DENYLIST, ...SYSTEM_DENYLIST, ...(Array.isArray(extra) ? extra : [])]
  return all.map((s) => normalizeForMatch(s))
}

/**
 * True if the path is denied. `denied` is the precomputed list from buildDenylist.
 */
export function isDenied(path, denied) {
  const norm = normalizeForMatch(path)
  return denied.some((seg) => norm.includes(seg))
}
