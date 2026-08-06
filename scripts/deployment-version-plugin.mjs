const FULL_SHA = /^[0-9a-f]{40}$/i

export function resolveDeploymentCommit(env = process.env) {
  for (const [source, value] of [
    ['VERCEL_GIT_COMMIT_SHA', env.VERCEL_GIT_COMMIT_SHA],
    ['GITHUB_SHA', env.GITHUB_SHA],
  ]) {
    const commit = String(value || '').trim().toLowerCase()
    if (FULL_SHA.test(commit)) return { commit, source }
  }
  return { commit: null, source: 'unavailable_local_build' }
}

export function deploymentVersionPlugin({ env = process.env } = {}) {
  return {
    name: 'grantflow-deployment-version',
    generateBundle() {
      const version = resolveDeploymentCommit(env)
      this.emitFile({
        type: 'asset',
        fileName: 'assets/deployment-version.json',
        source: `${JSON.stringify({
          contract: 'grantflow-frontend-deployment-version-v1',
          commit: version.commit,
          source: version.source,
        }, null, 2)}\n`,
      })
    },
  }
}
