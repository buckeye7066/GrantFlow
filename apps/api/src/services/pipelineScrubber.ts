import { prisma } from '@grantflow/prisma';

type ScrubInput = {
  profileId?: string;
  organizationId?: string;
  dryRun?: boolean;
  removeGrants?: boolean;
};

export const pipelineScrubber = {
  async scrub(input: ScrubInput = {}) {
    const { profileId, dryRun = true, removeGrants = false } = input;

    const queueEntries = await prisma.processingQueue.findMany({
      where: {
        profileId: profileId ?? undefined,
      },
      take: 500,
    });

    const mismatched = [];

    for (const entry of queueEntries) {
      const grant = await prisma.grant.findUnique({
        where: { id: entry.grantId },
      });

      const entryProfileId = entry.profileId ?? null;
      const grantProfileId = grant?.profileId ?? null;

      if (!grant || (entryProfileId && grantProfileId !== entryProfileId)) {
        const record: Record<string, unknown> = {
          queueId: entry.id,
          grantId: entry.grantId,
          entryProfileId,
          grantProfileId,
        };

        if (!dryRun) {
          await prisma.processingQueue.delete({ where: { id: entry.id } });
          if (removeGrants && grant) {
            await prisma.grant.update({
              where: { id: grant.id },
              data: {
                status: 'ARCHIVED',
                removedReason: 'Removed by pipeline scrubber',
              },
            });
          }
        }

        mismatched.push(record);
      }
    }

    return { scanned: queueEntries.length, mismatched, dryRun };
  },
};

