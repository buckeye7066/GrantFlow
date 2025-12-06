import { prisma } from '@grantflow/prisma';
import { matchEngine } from '@grantflow/match-engine';
import { pipelineScrubber } from './services/pipelineScrubber';
import { automationRunner } from './services/automationRunner';

export type Context = Awaited<ReturnType<typeof createContext>>;

export async function createContext() {
  return {
    prisma,
    matchEngine,
    pipelineScrubber,
    automationRunner,
  };
}

