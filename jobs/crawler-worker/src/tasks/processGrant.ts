import { prisma } from '@grantflow/prisma';
import { buildSearchStrategy } from '@grantflow/crawler-runtime';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type ProcessGrantPayload = {
  profileId: string;
  grantId: string;
};

export async function processGrantJob(payload: ProcessGrantPayload) {
  const { profileId, grantId } = payload;

  const profile = await prisma.fundingProfile.findUnique({
    where: { id: profileId },
  });

  if (!profile) {
    console.warn(`[crawler-worker] profile ${profileId} not found`);
    return;
  }

  const grant = await prisma.grant.findUnique({
    where: { id: grantId },
  });

  if (!grant) {
    console.warn(`[crawler-worker] grant ${grantId} not found`);
    return;
  }

  const strategy = buildSearchStrategy(profile);

  const prompt = [
    'Assess whether a grant is a good fit for the profile.',
    `Profile: ${profile.name} (${profile.type})`,
    `Grant: ${grant.title}`,
    grant.summary ? `Summary: ${grant.summary}` : '',
    `Strategy keywords: ${strategy.keywords.join(', ')}`,
    '',
    'Return JSON with suitability (0-100), rationale.',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: prompt,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'GrantAssessment',
        schema: {
          type: 'object',
          properties: {
            suitability: { type: 'number' },
            rationale: { type: 'string' },
          },
          required: ['suitability', 'rationale'],
        },
      },
    },
  });

  const content = response.output[0]?.content?.[0];
  if (content?.type !== 'output_text') return;

  const parsed = JSON.parse(content.text) as {
    suitability: number;
    rationale: string;
  };

  await prisma.grant.update({
    where: { id: grantId },
    data: {
      matchScore: Math.max(0, Math.min(parsed.suitability ?? 0, 100)),
      aiSummary: parsed.rationale,
      aiStatus: 'ready',
    },
  });
}

