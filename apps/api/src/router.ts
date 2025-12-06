import { initTRPC } from '@trpc/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from './context';

const DEFAULT_ADMIN_EMAIL =
  process.env.DEFAULT_ADMIN_EMAIL ?? 'admin@axiombiolabs.org';

const profileInputSchema = z.object({
  type: z.string(),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  address: z.record(z.any()).optional(),
  coreFlags: z.record(z.any()).optional(),
  qualifiers: z.record(z.any()).optional(),
  createdBy: z.string().optional(),
});

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
    create: t.procedure
      .input(profileInputSchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.fundingProfile.create({
          data: {
            type: input.type,
            name: input.name,
            email: input.email ?? null,
            phone: input.phone ?? null,
            address: input.address ?? {},
            coreFlags: input.coreFlags ?? {},
            qualifiers: input.qualifiers ?? {},
            createdBy: input.createdBy ?? DEFAULT_ADMIN_EMAIL,
          },
        });
      }),
    update: t.procedure
      .input(
        z.object({
          id: z.string(),
          data: profileInputSchema.partial(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { data } = input;
        const updateData: Record<string, unknown> = {};

        if (data.type !== undefined) updateData.type = data.type;
        if (data.name !== undefined) updateData.name = data.name;
        if (data.email !== undefined) updateData.email = data.email ?? null;
        if (data.phone !== undefined) updateData.phone = data.phone ?? null;
        if (data.address !== undefined) updateData.address = data.address ?? {};
        if (data.coreFlags !== undefined) updateData.coreFlags = data.coreFlags ?? {};
        if (data.qualifiers !== undefined) updateData.qualifiers = data.qualifiers ?? {};

        return ctx.prisma.fundingProfile.update({
          where: { id: input.id },
          data: updateData,
        });
      }),
    delete: t.procedure
      .input(z.string())
      .mutation(({ ctx, input }) =>
        ctx.prisma.fundingProfile.delete({ where: { id: input } }),
      ),
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

  session: t.router({
    me: t.procedure.query(() => ({
      id: 'local-admin',
      email: DEFAULT_ADMIN_EMAIL,
      name: 'Local Admin',
      role: 'admin',
    })),
  }),
});

