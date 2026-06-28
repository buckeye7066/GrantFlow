// crawler-os/stages.js
//
// Compatibility facade for crawler-os imports. The canonical pipeline stage
// list and transition helpers live in shared/pipelineStages.js so crawler OS,
// backend validators, UI buckets, and agent workflow cannot drift.

import {
  PIPELINE_STAGE,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  isValidStage,
  canTransition,
  assertTransition,
} from '../../shared/pipelineStages.js'

export {
  PIPELINE_STAGE,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  isValidStage,
  canTransition,
  assertTransition,
}

export default {
  PIPELINE_STAGE,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  isValidStage,
  canTransition,
  assertTransition,
}
