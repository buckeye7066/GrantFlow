import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import pino from 'pino';

const logger = pino({ name: 'prisma' });

function buildPrismaClient(): PrismaClient {
  const config: Prisma.PrismaClientOptions = {
    log: [