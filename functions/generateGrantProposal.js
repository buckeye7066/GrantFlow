import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";
import { loadProfileContext } from "./_shared/matchingEngine.js";
import { formatSections, invokeLLM } from "./_shared/aiUtils.js";

const DEFAULT_SECTIONS = [
  { id: "executive_summary", title: "Executive Summary" },
  { id: "needs_assessment", title: "Needs Assessment" },
  { id: "program_description", title: "Program Description" },
  { id: "impact_and_outcomes", title: "Impact and Outcomes" },
  { id: "budget_overview", title: "Budget Overview" },
  { id: "sustainability", title: "Sustainability" },
];

function buildProposalPrompt({ profileSummary, axes, grant, sections }) {
  const axisText = axes.length
    ? `Funding Axes:\n${axes.map((axis) => `- ${axis.label}`).join("\n")}\n`
    : "";

  const sectionInstructions = sections.map((section, index) => {
    const instructions = section.instructions
      ? `Instructions: ${section.instructions}`
      : "Provide a concise, persuasive narrative (200-250 words).";
    return `${index + 1}. ${section.title}\n${instructions}`;
  }).join("\n\n");

  return [
    "Generate proposal sections tailored to the following profile and grant.",
    "Profile Summary:",
    profileSummary,
    axisText ? axisText : "",
    "Grant Details:",
    `Title: ${grant.title ?? "Untitled"}`,
    grant.summary ? `Summary: ${grant.summary}` : "",
    grant.description ? `Description: ${grant.description}` : "",
    grant.eligibility_summary
      ? `Eligibility: ${grant.eligibility_summary}`
      : "",
    `Deadline: ${grant.deadline_at ?? grant.due_at ?? "unknown"}`,
    "",
    "Sections to generate (return in the same order):",
    sectionInstructions,
    "",
    "Use inspiring, grant-ready language and avoid repeating the same phrases.",
    "Return JSON with an array 'sections', each object containing: id, title, and content_markdown.",
  ].filter(Boolean).join("\n");
}

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const profileId = body.profile_id ?? body.profileId ?? null;
  const organizationId = body.organization_id ?? body.organizationId ?? null;
  const grantId = body.grant_id ?? body.grantId ?? null;
  const sections = formatSections(body.sections ?? DEFAULT_SECTIONS);

  if (!grantId) {
    return Response.json({ error: "grant_id is required" }, { status: 400 });
  }

  if (sections.length === 0) {
    return Response.json({
      error: "At least one proposal section is required",
    }, { status: 400 });
  }

  const grant = await sdk.entities.Grant.get(grantId).catch(() => null);
  if (!grant) {
    return Response.json({ error: "Grant not found" }, { status: 404 });
  }
  enforceOwnership(user, grant, "created_by");

  const context = await loadProfileContext(
    sdk,
    user,
    {
      profileId,
      organizationId: organizationId ?? grant.organization_id ?? null,
    },
  );

  const prompt = buildProposalPrompt({
    profileSummary: context.summary,
    axes: context.axes,
    grant,
    sections,
  });

  const response = await invokeLLM(base44, {
    prompt,
    temperature: 0.55,
    maxOutputTokens: 1600,
    responseSchema: {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              content_markdown: { type: "string" },
            },
          },
        },
      },
    },
  });

  const generatedSections = Array.isArray(response.sections)
    ? response.sections
    : [];

  return {
    profile_id: context.profile.id,
    organization_id: context.organization?.id ?? null,
    grant_id: grantId,
    sections: generatedSections.map((section, index) => ({
      id: section.id ?? sections[index]?.id ?? `section_${index + 1}`,
      title: section.title ?? sections[index]?.title ?? `Section ${index + 1}`,
      content_markdown: section.content_markdown ?? "",
    })),
  };
}, { name: "generateGrantProposal" });
