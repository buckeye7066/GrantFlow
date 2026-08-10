import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FULL_SHA = /^[0-9a-f]{40}$/i
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIR, '..')
export const RELEASE_IDENTITY_CONTRACT = 'grantflow-release-identity-v1'
export const MIGRATION_SET_CONTRACT = 'grantflow-migration-set-v1'
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

function readPackageVersion(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  return String(pkg.version || 'unknown')
}

function listMigrationFiles(repoRoot, dialect) {
  const relativeDirectory = MIGRATION_DIRECTORIES[dialect]
  if (!relativeDirectory) throw new Error('Unsupported migration dialect: ' + dialect)
  const directory = path.join(repoRoot, relativeDirectory)
  const names = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.sql') || name.endsWith('.mjs'))
    .sort((a, b) => a.localeCompare(b))
  return { relativeDirectory, directory, names }
}

export function buildMigrationSetManifest({
  repoRoot = DEFAULT_REPO_ROOT,
  dialect = 'postgres',
  useCache = true,
} = {}) {
  const resolvedRoot = path.resolve(repoRoot)
  const cacheKey = resolvedRoot + '|' + dialect
  if (useCache && migrationCache.has(cacheKey)) return migrationCache.get(cacheKey)

  const { relativeDirectory, directory, names } = listMigrationFiles(resolvedRoot, dialect)
  const files = names.map((name) => {
    const fullPath = path.join(directory, name)
    const stat = fs.statSync(fullPath)
    return {
      name,
      path: normalizeRelativePath(path.join(relativeDirectory, name)),
      bytes: stat.size,
      sha256: sha256File(fullPath),
    }
  })
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
  const normalizedPath = normalizeRelativePath(relativePath)
  const fullPath = path.join(path.resolve(repoRoot), normalizedPath)
  const stat = fs.statSync(fullPath)
  return Object.freeze({
    contract: EVIDENCE_ARTIFACT_CONTRACT,
    path: normalizedPath,
    bytes: stat.size,
    sha256: sha256File(fullPath),
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
  const resolvedRoot = path.resolve(repoRoot)
  const normalizedCommit = FULL_SHA.test(String(commit || '').trim())
    ? String(commit).trim().toLowerCase()
    : null
  const resolvedPackageVersion = packageVersion || readPackageVersion(resolvedRoot)
  const cacheKey = resolvedRoot + '|' + (normalizedCommit || 'null') + '|' + resolvedPackageVersion
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

  const expectedByName = new Map(expected.files.map((file) => [file.name, file]))
  const appliedNames = (rows || []).map((row) => String(row?.name || '')).filter(Boolean)
  const expectedNames = expected.files.map((file) => file.name)
  const expectedSet = new Set(expectedNames)
  const appliedSet = new Set(appliedNames)
  const pending = expectedNames.filter((name) => !appliedSet.has(name))
  const unexpected = appliedNames.filter((name) => !expectedSet.has(name))
  const orderMatches = appliedNames.length === expectedNames.length
    && appliedNames.every((name, index) => name === expectedNames[index])

  const appliedFiles = appliedNames.map((name) => {
    const expectedFile = expectedByName.get(name)
    return expectedFile
      ? {
          name: expectedFile.name,
          path: expectedFile.path,
          bytes: expectedFile.bytes,
          sha256: expectedFile.sha256,
        }
      : {
          name,
          path: null,
          bytes: null,
          sha256: null,
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
  const matchesRelease = Boolean(
    releaseMigration
      && pending.length === 0
      && unexpected.length === 0
      && orderMatches
      && appliedSha256 === releaseMigration.manifest_sha256
      && expected.manifest_sha256 === releaseMigration.manifest_sha256,
  )

  return {
    available: true,
    contract: 'grantflow-database-migration-identity-v1',
    dialect,
    hash_provenance: 'release_file_hashes_mapped_to_ordered_database_migration_names',
    historical_applied_bytes_attested: false,
    applied_count: appliedNames.length,
    expected_count: expected.file_count,
    applied_sha256: appliedSha256,
    expected_sha256: expected.manifest_sha256,
    release_migration_set_sha256: releaseMigration?.manifest_sha256 || null,
    pending,
    unexpected,
    order_matches: orderMatches,
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
