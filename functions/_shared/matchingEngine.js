import { buildSearchStrategyForProfile } from "./crawlerFramework.js";
import { deriveProfileSummary, listFundingAxes } from "./profileSchema.js";
import { enforceOwnership } from "./security.js";
import { logPHIAccess } from "./phiAuditLogger.js";

const DEFAULT_GRANT_STATUSES = [
  "open",
  "interested",
  "discovered",
  "draft",
];

function normalizeProfile(profile = {}, organization = null) {
  const qualifiers = profile.qualifiers ?? organization?.qualifiers ?? {};
  const address = profile.address ?? organization?.address ?? {};

  return {
    ...profile,
    qualifiers,
    address,
    core_fields: profile.core_fields ?? {},
  };
}

async function loadFundingProfile(sdk, profileId) {
  if (!profileId) return null;
  return await sdk.entities.FundingProfile.get(profileId).catch(() => null);
}

async function loadOrganization(sdk, organizationId) {
  if (!organizationId) return null;
  return await sdk.entities.Organization.get(organizationId).catch(() => null);
}

export async function loadProfileContext(sdk, user, identifiers = {}) {
  const { profileId, organizationId } = identifiers;

  let profile = null;
  let organization = null;

  if (profileId) {
    profile = await loadFundingProfile(sdk, profileId);
    if (!profile) throw new Error("Profile not found");
    enforceOwnership(user, profile, "owner_id");

    if (profile.organization_id) {
      organization = await loadOrganization(sdk, profile.organization_id);
      if (organization) enforceOwnership(user, organization, "owner_id");
    }
  } else if (organizationId) {
    organization = await loadOrganization(sdk, organizationId);
    if (!organization) throw new Error("Organization not found");
    enforceOwnership(user, organization, "owner_id");

    if (organization.profile_id) {
      profile = await loadFundingProfile(sdk, organization.profile_id);
    }

    if (!profile) {
      profile = {
        id: `org:${organization.id}`,
        primary_type: organization.type ?? "Organization",
        name: organization.name,
        qualifiers: organization.qualifiers ?? {},
        address: organization.address ?? {
          city: organization.city ?? null,
          state: organization.state ?? null,
          county: organization.county ?? null,
          zip: organization.zip ?? null,
        },
      };
    }
  } else {
    throw new Error("profile_id or organization_id is required");
  }

  const normalized = normalizeProfile(profile, organization);
  const strategy = buildSearchStrategyForProfile(normalized);
  const summary = deriveProfileSummary(normalized);
  const axes = listFundingAxes(normalized.qualifiers ?? {});

  return {
    profile: normalized,
    organization,
    strategy,
    summary,
    axes,
  };
}

export async function recordMatchAccess(sdk, context, user, functionName) {
  try {
    await logPHIAccess(sdk, {
      action: "match_profile_to_grants",
      entity: context.organization ? "Organization" : "FundingProfile",
      entity_id: context.organization
        ? context.organization.id
        : context.profile.id,
      function_name: functionName,
      metadata: { user_id: user.id },
    });
  } catch (error) {
    console.warn("Failed to record PHI access:", error.message);
  }
}

export async function findCandidateGrants(sdk, context, options = {}) {
  const limit = Number(options.limit) || 20;
  const filters = {
    status: { in: DEFAULT_GRANT_STATUSES },
  };

  if (context.strategy.geography.state) {
    filters.state = context.strategy.geography.state;
  }

  const grantOptions = {
    limit: limit * 3,
    offset: 0,
    order: [{ column: "deadline_at", ascending: true }],
  };

  const grants = await sdk.entities.Grant.filter(filters, grantOptions)
    .catch(() => []);
  return Array.isArray(grants) ? grants : [];
}

export async function scoreGrantAgainstProfile(base44, context, grant) {
  const keywords = Array.from(context.strategy.keywords ?? []);
  const axes = context.axes ?? [];
  const prompt = [
    "You are matching a funding profile to a grant opportunity.",
    `Profile Summary:\n${context.summary}`,
    axes.length
      ? `Funding Axes:\n${axes.map((axis) => `- ${axis.label}`).join("\n")}`
      : null,
    keywords.length ? `Search Keywords: ${keywords.join(", ")}` : null,
    "Grant Details:",
    `Title: ${grant.title ?? "Untitled"}`,
    grant.summary ? `Summary: ${grant.summary}` : null,
    grant.description ? `Description: ${grant.description}` : null,
    grant.eligibility_summary
      ? `Eligibility: ${grant.eligibility_summary}`
      : null,
    `Status: ${grant.status ?? "unknown"}`,
    `Deadline: ${grant.deadline_at ?? grant.due_at ?? "unknown"}`,
    "",
    "Return JSON with:",
    "- match_score (0-100)",
    "- recommended (boolean)",
    "- rationale (string)",
    "- tags (array of short strings)",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await base44.integrations.Core.InvokeLLM({
      prompt,
      add_context_from_internet: false,
      response_json_schema: {
        type: "object",
        properties: {
          match_score: { type: "number" },
          recommended: { type: "boolean" },
          rationale: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    });

    const score = Math.max(
      0,
      Math.min(Number(response?.match_score ?? 0), 100),
    );
    return {
      match_score: score,
      recommended: typeof response?.recommended === "boolean"
        ? response.recommended
        : score >= 60,
      rationale: response?.rationale ?? "Auto-generated match analysis.",
      tags: Array.isArray(response?.tags) ? response.tags : [],
      raw: response,
    };
  } catch (error) {
    return {
      match_score: 0,
      recommended: false,
      rationale: `Unable to score grant: ${error.message}`,
      tags: ["error"],
      raw: null,
    };
  }
}

export async function matchGrants(base44, sdk, context, options = {}) {
  const limit = Number(options.limit) || 10;
  const candidates = await findCandidateGrants(sdk, context, {
    limit,
  });

  const matches = [];
  for (const grant of candidates) {
    const score = await scoreGrantAgainstProfile(base44, context, grant);
    matches.push({
      grant_id: grant.id,
      title: grant.title,
      status: grant.status,
      amount: grant.amount ?? grant.estimated_amount ?? null,
      deadline_at: grant.deadline_at ?? grant.due_at ?? null,
      match_score: score.match_score,
      recommended: score.recommended,
      rationale: score.rationale,
      tags: score.tags,
    });
  }

  matches.sort((a, b) => b.match_score - a.match_score);
  return matches.slice(0, limit);
}
