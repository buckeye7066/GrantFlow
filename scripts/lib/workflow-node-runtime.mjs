import { load } from 'js-yaml'

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

export function validateWorkflowNodeRuntime(
  source,
  {
    workflowPath = 'workflow.yml',
    allowedInlineVersions = ['20.20.2'],
    allowedNodeVersionFiles = ['.nvmrc'],
    requiredRuntimeBeforeCommands = [],
  } = {},
) {
  let workflow
  try {
    workflow = load(source)
  } catch (error) {
    return [`${workflowPath}: could not parse YAML (${error?.message || error})`]
  }

  const failures = []
  const jobs = workflow?.jobs && typeof workflow.jobs === 'object' ? workflow.jobs : {}

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!Array.isArray(job?.steps)) continue

    let activePin = null
    const matchedRequirements = new Set()
    const jobRequirements = requiredRuntimeBeforeCommands.filter(
      (requirement) => requirement.job === undefined || requirement.job === jobName,
    )

    job.steps.forEach((step, stepIndex) => {
      const location = `${workflowPath} job ${jobName} step ${stepIndex + 1}`
      if (typeof step?.uses === 'string' && step.uses.startsWith('actions/setup-node@')) {
        const config = step.with && typeof step.with === 'object' ? step.with : {}
        const hasInlinePin = hasOwn(config, 'node-version')
        const hasFilePin = hasOwn(config, 'node-version-file')

        if (Number(hasInlinePin) + Number(hasFilePin) !== 1) {
          failures.push(`${location} must provide exactly one of node-version or node-version-file`)
          activePin = null
          return
        }

        activePin = hasInlinePin
          ? { field: 'node-version', value: String(config['node-version']) }
          : { field: 'node-version-file', value: String(config['node-version-file']) }

        if (hasInlinePin && !allowedInlineVersions.includes(activePin.value)) {
          failures.push(`${location} must pin an approved Node version; found ${activePin.value}`)
        }
        if (hasFilePin && !allowedNodeVersionFiles.includes(activePin.value)) {
          failures.push(`${location} must use an approved node-version-file; found ${activePin.value}`)
        }
        return
      }

      if (typeof step?.run !== 'string') return
      jobRequirements.forEach((requirement, requirementIndex) => {
        if (!step.run.includes(requirement.command)) return
        matchedRequirements.add(requirementIndex)
        if (activePin?.field !== requirement.field || activePin?.value !== requirement.value) {
          failures.push(
            `${location} command ${requirement.command} must run after ${requirement.field}: ${requirement.value}`,
          )
        }
      })
    })

    jobRequirements.forEach((requirement, requirementIndex) => {
      if (!matchedRequirements.has(requirementIndex)) {
        failures.push(`${workflowPath} job ${jobName} must contain command ${requirement.command}`)
      }
    })
  }

  return failures
}
