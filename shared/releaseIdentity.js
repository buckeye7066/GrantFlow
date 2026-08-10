import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FULL_SHA = /^[0-9a-f]{40}$/i
const WINDOWS_ABSOLUTE = /^[a-z]:\//i
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIR, '..')
export const RELEASE_IDENTITY_CONTRACT = 'grantflow-release-identity-v2'
export const MIGRATION_SET_CONTRACT = 'grantflow-migration-set-v2'
export const EVIDENCE_ARTIFACT_CONTRACT = 'grantflow-release-evidence-v1'
export const EVIDENCE_ARTIFACT_PATH = 'docs/production-readiness/grantflow.md'
export const MIGRATION_DIRECTORIES = Object.freeze({
  postgres: 'backend/db/postgres/migrations',
  sqlite: 'backend/db/migrations',
})

const repositoryCache = new Map()
const migrationCache = new Map()

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue
    out[key] = canonicalize(value[key])
  }
  return out
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath))
}

function canonicalRepoRoot(repoRoot) {
  return fs.realpathSync(path.resolve(repoRoot))
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function resolveContainedExistingPath(repoRoot, relativePath, label) {
  const root = canonicalRepoRoot(repoRoot)
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized || path.isAbsolute(normalized) || WINDOWS_ABSOLUTE.test(normalized)) {
    throw new Error(`${label} must be a non-empty repository-relative path`)
  }
  const requested = path.resolve(root, normalized)
  const resolved = fs.realpathSync(requested)
  if (!isContained(root, resolved)) {
    throw new Error(`${label} escapes the canonical repository root: ${normalized}`)
  }
  return { root, normalized, requested, resolved }
}

function readPackageVersion(repoRoot) {
  const packageFile = resolveContainedExistingPath(repoRoot, 'package.json', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(packageFile.resolved, 'utf8'))
  return String(pkg.version || 'unknown')
}

function listMigrationFiles(repoRoot, dialect) {
  const relativeDirectory = MIGRATION_DIRECTORIES[dialect]
  if (!relativeDirectory) throw new Error(`Unsupported migration dialect: ${dialect}`)
  const directoryInfo = resolveContainedExistingPath(
    repoRoot,
    relativeDirectory,
    `${dialect} migration directory`,
  )
  const names = fs.readdirSync(directoryInfo.resolved)
    .filter((name) => name.endsWith('.sql') || name.endsWith('.mjs'))
    .sort()
  const files = names.map((name) => {
    const relativeFile = normalizeRelativePath(path.join(relativeDirectory, name))
    const fileInfo = resolveContainedExistingPath(
      directoryInfo.root,
      relativeFile,
      `${dialect} migration file ${name}`,
    )
    const stat = fs.statSync(fileInfo.resolved)
    if (!stat.isFile()) throw new Error(`Migration entry is not a regular file: ${relativeFile}`)
    return {
      name,
      path: relativeFile,
      bytes: stat.size,
      sha256: sha256File(fileInfo.resolved),
    }
  })
  return { relativeDirectory, files }
}

export function buildMigrationSetManifest({
  repoRoot = DEFAULT_REPO_ROOT,
  dialect = 'postgres',
  useCache = true,
} = {}) {
  const resolvedRoot = canonicalRepoRoot(repoRoot)
  const cacheKey = `${resolvedRoot}|${dialect}`
  if (useCache && migrationCache.has(cacheKey)) return migrationCache.get(cacheKey)

  const { relativeDirectory, files } = listMigrationFiles(resolvedRoot, dialect)
  const payload = {
    contract: MIGRATION_SET_CONTRACT,
    dialect,
    directory: normalizeRelativePath(relativeDirectory),
    files,
  }
  const manifest = Object.freeze({
    ...payload,
    file_count: files.length,
    manifest_sha256: sha256(canonicalJson(payload)),
  })
  if (useCache) migrationCache.set(cacheKey, manifest)
  return manifest
}

export function buildEvidenceArtifact({
  repoRoot = DEFAULT_REPO_ROOT,
  relativePath = EVIDENCE_ARTIFACT_PATH,
} = {}) {
  const fileInfo = resolveContainedExistingPath(repoRoot, relativePath, 'release evidence artifact')
  const stat = fs.statSync(fileInfo.resolved)
  if (!stat.isFile()) throw new Error(`Release evidence artifact is not a regular file: ${fileInfo.normalized}`)
  return Object.freeze({
    contract: EVIDENCE_ARTIFACT_CONTRACT,
    path: fileInfo.normalized,
    bytes: stat.size,
    sha256: sha256File(fileInfo.resolved),
  })
}

export function resolveReleaseCommit(env = process.env) {
  for (const [source, value] of [
    ['RAILWAY_GIT_COMMIT_SHA', env.RAILWAY_GIT_COMMIT_SHA],
    ['VERCEL_GIT_COMMIT_SHA', env.VERCEL_GIT_COMMIT_SHA],
    ['GITHUB_SHA', env.GITHUB_SHA],
    ['GIT_COMMIT_SHA', env.GIT_COMMIT_SHA],
  ]) {
    const commit = String(value || '').trim().toLowerCase()
    if (FULL_SHA.test(commit)) return { commit, source }
  }
  return { commit: null, source: 'unavailable_local_build' }
}

function summarizeMigrationSet(manifest) {
  return {
    contract: manifest.contract,
    dialect: manifest.dialect,
    directory: manifest.directory,
    file_count: manifest.file_count,
    manifest_sha256: manifest.manifest_sha256,
  }
}

export function buildRepositoryReleaseIdentity({
  repoRoot = DEFAULT_REPO_ROOT,
  commit = null,
  packageVersion = null,
  useCache = true,
} = {}) {
  const resolvedRoot = canonicalRepoRoot(repoRoot)
  const normalizedCommit = FULL_SHA.test(String(commit || '').trim())
    ? String(commit).trim().toLowerCase()
    : null
  const resolvedPackageVersion = packageVersion || readPackageVersion(resolvedRoot)
  const cacheKey = `${resolvedRoot}|${normalizedCommit || 'null'}|${resolvedPackageVersion}`
  if (useCache && repositoryCache.has(cacheKey)) return repositoryCache.get(cacheKey)

  const postgres = buildMigrationSetManifest({
    repoRoot: resolvedRoot,
    dialect: 'postgres',
    useCache,
  })
  const sqlite = buildMigrationSetManifest({
    repoRoot: resolvedRoot,
    dialect: 'sqlite',
    useCache,
  })
  const evidenceArtifact = buildEvidenceArtifact({ repoRoot: resolvedRoot })
  const payload = {
    contract: RELEASE_IDENTITY_CONTRACT,
    commit: normalizedCommit,
    package_version: resolvedPackageVersion,
    migration_sets: {
      postgres: summarizeMigrationSet(postgres),
      sqlite: summarizeMigrationSet(sqlite),
    },
    evidence_artifact: evidenceArtifact,
  }
  const identity = Object.freeze({
    ...payload,
    manifest_sha256: sha256(canonicalJson(payload)),
  })
  if (useCache) repositoryCache.set(cacheKey, identity)
  return identity
}

function migrationIdentityFromFiles(dialect, directory, files) {
  const payload = {
    contract: MIGRATION_SET_CONTRACT,
    dialect,
    directory,
    files,
  }
  return sha256(canonicalJson(payload))
}

function normalizeStoredChecksum(value) {
  const checksum = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(checksum) ? checksum : null
}

function provenanceCounts(rows) {
  const counts = {}
  for (const row of rows || []) {
    const provenance = String(row?.checksum_provenance || '').trim() || 'missing'
    counts[provenance] = (counts[provenance] || 0) + 1
  }
  return counts
}

export async function buildDatabaseMigrationIdentity(db, {
  repoRoot = DEFAULT_REPO_ROOT,
  releaseIdentity = null,
} = {}) {
  const dialect = String(db?.dialect || '').trim().toLowerCase()
  if (!db || typeof db.prepare !== 'function') {
    return {
      available: false,
      dialect: dialect || null,
      matches_release: false,
      error: 'database_unavailable',
    }
  }
  if (!MIGRATION_DIRECTORIES[dialect]) {
    return {
      available: false,
      dialect: dialect || null,
      matches_release: false,
      error: 'unsupported_database_dialect',
    }
  }

  const expected = buildMigrationSetManifest({ repoRoot, dialect })
  let rows
  let checksumColumnsAvailable = true
  try {
    rows = await db.prepare(
      `SELECT id, name, checksum_sha256, checksum_provenance, applied_at
         FROM _migrations
        ORDER BY id`,
    ).all()
  } catch (checksumError) {
    checksumColumnsAvailable = false
    try {
      rows = await db.prepare(
        'SELECT id, name, applied_at FROM _migrations ORDER BY id',
      ).all()
    } catch (error) {
      return {
        available: false,
        dialect,
        matches_release: false,
        expected_count: expected.file_count,
        expected_sha256: expected.manifest_sha256,
        error: error?.message || String(error),
      }
    }
  }

  const expectedByName = new Map(expected.files.map((file) => [file.name, file]))
  const appliedNames = (rows || []).map((row) => String(row?.name || '')).filter(Boolean)
  const expectedNames = expected.files.map((file) => file.name)
  const expectedSet = new Set(expectedNames)
  const appliedSet = new Set(appliedNames)
  const pending = expectedNames.filter((name) => !appliedSet.has(name))
  const unexpected = appliedNames.filter((name) => !expectedSet.has(name))
  const orderMatches = appliedNames.length === expectedNames.length
    && appliedNames.every((name, index) => name === expectedNames[index])
  const nameParityMatches = pending.length === 0 && unexpected.length === 0 && orderMatches

  const checksumMissing = []
  const checksumMismatches = []
  const appliedFiles = appliedNames.map((name, index) => {
    const expectedFile = expectedByName.get(name)
    const row = rows[index] || {}
    const storedChecksum = normalizeStoredChecksum(row.checksum_sha256)
    if (!storedChecksum) checksumMissing.push(name)
    else if (expectedFile && storedChecksum !== expectedFile.sha256) {
      checksumMismatches.push({
        name,
        stored_sha256: storedChecksum,
        release_sha256: expectedFile.sha256,
      })
    }
    return expectedFile
      ? {
          name: expectedFile.name,
          path: expectedFile.path,
          bytes: expectedFile.bytes,
          sha256: storedChecksum,
        }
      : {
          name,
          path: null,
          bytes: null,
          sha256: storedChecksum,
        }
  })

  const appliedSha256 = migrationIdentityFromFiles(
    dialect,
    expected.directory,
    appliedFiles,
  )
  const repositoryIdentity = releaseIdentity || buildRepositoryReleaseIdentity({
    repoRoot,
    commit: null,
  })
  const releaseMigration = repositoryIdentity.migration_sets?.[dialect] || null
  const storedChecksumComplete = checksumColumnsAvailable && checksumMissing.length === 0
  const checksumsMatch = storedChecksumComplete && checksumMismatches.length === 0
  const matchesRelease = Boolean(
    releaseMigration
      && nameParityMatches
      && checksumsMatch
      && appliedSha256 === releaseMigration.manifest_sha256
      && expected.manifest_sha256 === releaseMigration.manifest_sha256,
  )
  const provenance = provenanceCounts(rows)
  const historicalAppliedBytesAttested = Boolean(
    rows?.length
      && Object.keys(provenance).length === 1
      && provenance.applied_bytes === rows.length,
  )

  return {
    available: true,
    contract: 'grantflow-database-migration-identity-v2',
    dialect,
    hash_provenance: checksumColumnsAvailable
      ? 'stored_database_migration_checksums_compared_with_release_file_hashes'
      : 'migration_names_only_checksum_columns_unavailable',
    checksum_columns_available: checksumColumnsAvailable,
    stored_checksum_complete: storedChecksumComplete,
    historical_applied_bytes_attested: historicalAppliedBytesAttested,
    checksum_provenance_counts: provenance,
    applied_count: appliedNames.length,
    expected_count: expected.file_count,
    applied_sha256: appliedSha256,
    expected_sha256: expected.manifest_sha256,
    release_migration_set_sha256: releaseMigration?.manifest_sha256 || null,
    pending,
    unexpected,
    checksum_missing: checksumMissing,
    checksum_mismatches: checksumMismatches,
    order_matches: orderMatches,
    name_parity_matches: nameParityMatches,
    checksums_match: checksumsMatch,
    matches_release: matchesRelease,
    first_applied_at: rows?.[0]?.applied_at || null,
    last_applied_at: rows?.at?.(-1)?.applied_at || null,
  }
}

export function clearReleaseIdentityCaches() {
  repositoryCache.clear()
  migrationCache.clear()
}

export default {
  buildDatabaseMigrationIdentity,
  buildEvidenceArtifact,
  buildMigrationSetManifest,
  buildRepositoryReleaseIdentity,
  canonicalJson,
  clearReleaseIdentityCaches,
  resolveReleaseCommit,
  sha256,
  sha256File,
}
