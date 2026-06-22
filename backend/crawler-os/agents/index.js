// crawler-os/agents/index.js
//
// The agent fleet. createFleet wires all six canonical agents against shared
// deps (store, fetcher, env, clock, plus optional outreach config / drivers).
//
// CYCLE_ORDER is the doctrine full-cycle order:
//   Sam -> Robert -> Yana -> John -> Hamilton -> (Sam postflight)
// Anya is the user-facing guide and is intentionally NOT part of the automated
// cycle; she is invoked on demand to explain and route.

import { createRobert } from './robert.js';
import { createYana } from './yana.js';
import { createJohn } from './john.js';
import { createHamilton } from './hamilton.js';
import { createSam } from './sam.js';
import { createAnya } from './anya.js';

export const CYCLE_ORDER = Object.freeze(['sam', 'robert', 'yana', 'john', 'hamilton']);

/**
 * createFleet — build all agents.
 * @param {{ store:object, fetcher?:object, env?:object, clock?:Function,
 *   outreach?:object, portalDriver?:object, discover?:Function }} deps
 */
export function createFleet(deps = {}) {
  return {
    sam: createSam(deps),
    robert: createRobert(deps),
    yana: createYana(deps),
    john: createJohn(deps),
    hamilton: createHamilton(deps),
    anya: createAnya(deps),
  };
}

export default { createFleet, CYCLE_ORDER };
