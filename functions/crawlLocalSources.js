import { createClientFromRequest } from "npm:@base44/sdk@0.8.4";
import {
  buildSearchStrategyForProfile,
  isOpportunityActive,
} from "./_shared/crawlerFramework.js";

function deriveRegionsFromProfile(profile) {
  const regions = [];
  if (!profile?.address) return regions;

  const { city, state, zip } = profile.address;
  if (state) {
    regions.push({
      label: `${city ? `${city}, ` : ""}${state}`,
      city: city ?? null,
      state,
      zip: zip ?? null,
    });
  }
  return regions;
}

function buildLocalPrompt(region, strategy) {
  const keywordList = Array.from(strategy.keywords ?? []);
  const keywords = keywordList.length > 0
    ? keywordList.join(", ")
    : "general assistance and scholarships";

  return [
    `Find local grants, scholarships, or assistance programs in ${region.label}.`,
    "Constraints:",
    "- Only include opportunities that are currently open or have rolling deadlines.",
    "- Prefer sources run by city agencies, county governments, local nonprofits, community foundations, or colleges.",
    "- For each result, include name, description, url, managing organization, and deadline (if available).",
    `- Use the following profile-aligned keywords to refine relevance: ${keywords}.`,
  ].join("\n");
}

function mapLLMItemToOpportunity(raw = {}, region = {}) {
  return {
    title: raw.title ?? raw.name ?? "Local Opportunity",
    descriptionMd: raw.description ?? raw.summary ?? "",
    url: raw.url ?? raw.link ?? null,
    sponsor: raw.organization ?? raw.provider ?? region.label ?? "Local Source",
    deadlineAt: raw.deadline ?? raw.close_date ?? raw.closingDate ?? null,
    source: "local_directory",
    source_id: raw.id ?? raw.slug ??
      `${region.state}-${region.city ?? "general"}-${raw.title ?? Date.now()}`,
    amount: raw.amount ?? null,
    geography: {
      state: region.state ?? null,
      city: region.city ?? null,
      zip: region.zip ?? null,
    },
    raw,
  };
}

async function crawlRegion(base44, profile, region, strategy, options) {
  const prompt = buildLocalPrompt(region, strategy);

  const response = await base44.integrations.Core.InvokeLLM({
    prompt,
    add_context_from_internet: true,
    response_json_schema: {
      type: "object",
      properties: {
        opportunities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              url: { type: "string" },
              organization: { type: "string" },
              deadline: { type: "string" },
              amount: { type: ["string", "number", "null"] },
            },
          },
        },
      },
    },
  });

  const items = response?.opportunities ?? response ?? [];
  const mapped = [];

  for (const raw of items) {
    const opportunity = mapLLMItemToOpportunity(raw, region);
    if (!opportunity.title || !opportunity.url) continue;
    if (
      !options.includeExpired &&
      !isOpportunityActive({ deadlineAt: opportunity.deadlineAt })
    ) {
      continue;
    }

    await base44.functions.invoke("processCrawledItem", {
      opportunity,
      profile_id: profile.id,
      strategy,
      region,
      test_mode: options.test_mode ?? false,
    });

    mapped.push(opportunity);
  }

  return mapped;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { profile_id, test_mode = false, includeExpired = false } = await req
      .json();

    if (!profile_id) {
      return Response.json({ ok: false, error: "profile_id is required" }, {
        status: 400,
      });
    }

    const sdk = base44.asServiceRole;
    const profile = await sdk.entities.FundingProfile.get(profile_id);
    if (!profile) {
      return Response.json({ ok: false, error: "Profile not found" }, {
        status: 404,
      });
    }

    const strategy = buildSearchStrategyForProfile(profile);
    const regions = deriveRegionsFromProfile(profile);
    if (regions.length === 0) {
      return Response.json({
        ok: true,
        result: { opportunities: [], regions: [] },
      });
    }

    const results = [];
    for (const region of regions) {
      const opportunities = await crawlRegion(
        base44,
        profile,
        region,
        strategy,
        {
          test_mode,
          includeExpired,
        },
      );
      results.push({ region, count: opportunities.length });
    }

    return Response.json({ ok: true, result: { regions: results, strategy } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
