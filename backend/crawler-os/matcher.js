// crawler-os/matcher.js
//
// BACK-COMPAT SHIM. There is exactly one matching authority:
// matchEngine.computeMatchDecision. Older call sites that imported
// `matchOpportunity` keep working by delegating here. This file contains NO
// scoring logic of its own — duplicating decision logic is forbidden by doctrine.

import { computeMatchDecision, WEIGHTS } from './matchEngine.js';

export const matchOpportunity = computeMatchDecision;
export { computeMatchDecision, WEIGHTS };
export default { matchOpportunity: computeMatchDecision, computeMatchDecision, WEIGHTS };
