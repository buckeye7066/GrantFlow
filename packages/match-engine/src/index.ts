import OpenAI from 'openai';
import { prisma } from '@grantflow/prisma';
import { buildSearchStrategy } from '@grantflow/crawler-runtime';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export type MatchResult = {
  grantId: string;
  matchScore: number;
  recommended: boolean;
  rationale: string;
  tags: string[];
};

export const matchEngine = {
  async scoreProfile(
    profile: Awaited<ReturnType<typeof prisma.fundingProfile.findUnique>>,
    limit = 15,
  ): Promise<MatchResult[]> {
    if (!profile) return [];

    const strategy = buildSearchStrategy(profile);

    const grants = await prisma.grant.findMany({
      where: {
        status: { in: ['DISCOVERED', 'INTERESTED'] },
      },
      take: limit * 3,
      orderBy: { deadline: 'asc' },
    });

    const matches: MatchResult[] = [];

    for (const grant of grants) {
      const prompt = buildMatchPrompt(profile, strategy, grant);
      const response = await openai.responses.create({
        model: 'gpt-4.1-mini',
        input: prompt,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'GrantMatch',
            schema: {
              type: 'object',
              properties: {
                match_score: { type: 'number' },
                recommended: { type: 'boolean' },
                rationale: { type: 'string' },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['match_score', 'recommended', 'rationale'],
            },
          },
        },
      });

      const content = response.output[0]?.content?.[0];
      if (content?.type !== 'output_text') continue;

      const parsed = JSON.parse(content.text) as {
        match_score: number;
        recommended: boolean;
        rationale: string;
        tags?: string[];
      };

      matches.push({
        grantId: grant.id,
        matchScore: Math.max(0, Math.min(parsed.match_score ?? 0, 100)),
        recommended: parsed.recommended ?? false,
        rationale: parsed.rationale ?? '',
        tags: parsed.tags ?? [],
      });
    }

    return matches.sort((a, b) => b.matchScore - a.matchScore).slice(0, limit);
  },
};

function buildMatchPrompt(profile: any, strategy: any, grant: any) {
  const axes = (strategy.axes ?? strategy?.fundingAxes ?? []).map(
    (axis: any) => `- ${axis.label ?? axis}`,
  );

  return [
    'You are a matching assistant that determines how well a funding profile fits a grant.',
    '',
    `Profile (${profile.type ?? 'unknown'}): ${profile.name}`,
    profile.summary ? `Summary: ${profile.summary}` : '',
    axes.length ? `Funding Axes:\n${axes.join('\n')}` : '',
    '',
    `Grant: ${grant.title}`,
    grant.summary ? `Summary: ${grant.summary}` : '',
    grant.eligibility ? `Eligibility: ${JSON.stringify(grant.eligibility)}` : '',
    '',
    'Return JSON with match_score (0-100), recommended (boolean), rationale, tags.',
  ]
    .filter(Boolean)
    .join('\n');
}

