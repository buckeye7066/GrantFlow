import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";
import { loadProfileContext } from "./_shared/matchingEngine.js";
import { invokeLLM } from "./_shared/aiUtils.js";

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const draft = body.draft ?? body.text ?? "";
  const voice = body.voice ?? "inspirational and evidence-backed";
  const instructions = body.instructions ??
    "Improve structure, clarity, and persuasiveness while preserving commitments and quantitative claims.";
  const profileId = body.profile_id ?? body.profileId ?? null;
  const organizationId = body.organization_id ?? body.organizationId ?? null;

  if (!draft || String(draft).trim().length === 0) {
    return Response.json({ error: "draft text is required" }, { status: 400 });
  }

  let context = null;
  if (profileId || organizationId) {
    context = await loadProfileContext(
      sdk,
      user,
      { profileId, organizationId },
    ).catch(() => null);
  }

  const prompt = [
    "Refine the following proposal narrative.",
    context ? `Profile Summary:\n${context.summary}\n` : "",
    context?.axes?.length
      ? `Funding Axes:\n${
        context.axes.map((axis) => `- ${axis.label}`).join("\n")
      }`
      : "",
    `Desired voice: ${voice}.`,
    "Instructions:",
    instructions,
    "",
    "Draft:",
    draft,
    "",
    "Return JSON with refined_markdown and bullet list of key improvements.",
  ].filter(Boolean).join("\n");

  const response = await invokeLLM(base44, {
    prompt,
    temperature: 0.5,
    responseSchema: {
      type: "object",
      properties: {
        refined_markdown: { type: "string" },
        improvements: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  });

  return {
    refined_markdown: response.refined_markdown ?? "",
    improvements: Array.isArray(response.improvements)
      ? response.improvements
      : [],
    profile_id: context?.profile?.id ?? null,
    organization_id: context?.organization?.id ?? null,
  };
}, { name: "refineProposalText" });
