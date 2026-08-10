import {
  buildRepositoryReleaseIdentity,
  resolveReleaseCommit,
} from '../shared/releaseIdentity.js'

export function resolveDeploymentCommit(env = process.env) {
  const resolved = resolveReleaseCommit({
    VERCEL_GIT_COMMIT_SHA: env.VERCEL_GIT_COMMIT_SHA,
    GITHUB_SHA: env.GITHUB_SHA,
  })
  return resolved.commit
    ? resolved
    : { commit: null, source: 'unavailable_local_build' }
}

export function deploymentVersionPlugin({
  env = process.env,
  repoRoot = process.cwd(),
} = {}) {
  return {
    name: 'grantflow-deployment-version',
    generateBundle() {
      const version = resolveDeploymentCommit(env)
      const releaseIdentity = buildRepositoryReleaseIdentity({
        repoRoot,
        commit: version.commit,
      })
      this.emitFile({
        type: 'asset',
        fileName: 'assets/deployment-version.json',
        source: JSON.stringify({
          contract: 'grantflow-frontend-deployment-version-v2',
          commit: version.commit,
          source: version.source,
          release_manifest_sha256: releaseIdentity.manifest_sha256,
          evidence_artifact_sha256: releaseIdentity.evidence_artifact.sha256,
        }, null, 2) + '\n',
      })
      this.emitFile({
        type: 'asset',
        fileName: 'assets/release-identity.json',
        source: JSON.stringify(releaseIdentity, null, 2) + '\n',
      })
    },
  }
}
