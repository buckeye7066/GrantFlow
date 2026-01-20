import { runComprehensiveCrawler as processComprehensiveCrawlerJob } from './comprehensiveCrawlerOptimized.js'
import { processNationalProgramsJob } from './nationalPrograms/index.js'

export async function processNationalJob(context) {
  const mode = context?.job?.parameters?.mode
  if (mode === 'programs') {
    return processNationalProgramsJob(context)
  }
  // Backwards compatible: default to existing nationwide opportunity crawl behavior
  return processComprehensiveCrawlerJob(context)
}

