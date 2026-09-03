import { processComprehensiveCrawlerJob } from './crawlerOsCompatibility.js'
import { processNationalProgramsJob } from './nationalPrograms/index.js'

export async function processNationalJob(context) {
  const mode = context?.job?.parameters?.mode
  if (mode === 'programs') {
    return processNationalProgramsJob(context)
  }
  // Default funding discovery is profile-aware Crawler OS; no legacy global engine.
  return processComprehensiveCrawlerJob(context)
}

