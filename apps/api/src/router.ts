import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import type { Context } from './context';
import { TRPCError } from '@trpc/server';

const t = initTRPC.context<Context>().create();

export const appRouter = t.router({
  health: t.procedure.query(() => ({
    ok: true,
    timestamp: new Date().toISOString(),
  })),

  profile: t.router({
    list: t.procedure.query(({ ctx }) =>
      ctx.prisma.fundingProfile.findMany({
        orderBy: { createdAt: 'desc' },
      }),
    ),
    byId: t.procedure.input(z.string()).query(({ ctx, input }) =>
      ctx.prisma.fundingProfile.findUnique({
        where: { id: input },
      }),
    ),
    upsert: t.procedure
      .input(
        z.object({
          id: z.string().optional(),
          type: z.string(),
          name: z.string(),
          email: z.string().optional(),
          phone: z.string().optional(),
          address: z.record(z.any()).optional(),
          coreFlags: z.record(z.any()).optional(),
          qualifiers: z.record(z.any()),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.id) {
          return ctx.prisma.fundingProfile.update({
            where: { id: input.id },
            data: input,
          });
        }
        return ctx.prisma.fundingProfile.create({ data: input });
      }),
  }),

  grants: t.router({
    list: t.procedure
      .input(
        z
          .object({
            profileId: z.string().optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        ctx.prisma.grant.findMany({
          where: input?.profileId ? { profileId: input.profileId } : {},
          orderBy: { updatedAt: 'desc' },
        }),
      ),
    matchProfile: t.procedure
      .input(
        z.object({
          profileId: z.string(),
          limit: z.number().min(1).max(50).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const profile = await ctx.prisma.fundingProfile.findUnique({
          where: { id: input.profileId },
        });
        if (!profile) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found' });
        }
        return ctx.matchEngine.scoreProfile(profile, input.limit ?? 15);
      }),
    scrub: t.procedure
      .input(
        z
          .object({
            profileId: z.string().optional(),
            dryRun: z.boolean().optional(),
            removeGrants: z.boolean().optional(),
          })
          .optional(),
      )
      .mutation(({ ctx, input }) => ctx.pipelineScrubber.scrub(input)),
  }),

  automation: t.router({
    runBatch: t.procedure
      .input(
        z.object({
          queue: z.array(
            z.enum(['smartAutomation', 'autoAdvance', 'localCrawler']),
          ),
          payload: z.record(z.any()).optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.automationRunner.run(input)),
  }),
});

