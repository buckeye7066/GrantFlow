import type { Plugin } from 'vite'

export interface DeploymentVersion {
  commit: string | null
  source: string
}

export function resolveDeploymentCommit(
  env?: Record<string, string | undefined>,
): DeploymentVersion

export function deploymentVersionPlugin(options?: {
  env?: Record<string, string | undefined>
}): Plugin
