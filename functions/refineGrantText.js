import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";
import { invokeLLM } from "./_shared/aiUtils.js";

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const grantId = body.grant_id ?? body.grantId ?? null;
  const draft = body.draft ?? body.text ?? "";
  const instructions = body.instructions ??
    "Strengthen clarity, alignment with funder priorities, and persuasive impact while preserving factual details.";

  if (!grantId) {
    return Response.json({ error: "grant_id is required" }, { status: 400 });
  }

  if (!draft || String(draft).trim().length === 0) {
    return Response.json({ error: "draft text is required" }, { status: 400 });
  }

  const grant = await sdk.entities.Grant.get(grantId).catch(() => null);
  if (!grant) {
    return Response.json({ error: "Grant not found" }, { status: 404 });
  }
  enforceOwnership(user, grant, "created_by");

  const prompt = [
    "You are refining grant narrative content.",
    `Grant Title: ${grant.title ?? "Untitled"}`,
    grant.summary ? `Grant Summary: ${grant.summary}` : "",
    "",
    "Instructions:",
    instructions,
    "",
    "Draft to refine:",
    draft,
    "",
    "Return JSON with refined_markdown (Markdown).",
  ].filter(Boolean).join("\n");

  const response = await invokeLLM(base44, {
    prompt,
    temperature: 0.45,
    responseSchema: {
      type: "object",
      properties: {
        refined_markdown: { type: "string" },
        key_changes: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  });

  return {
    grant_id: grantId,
    refined_markdown: response.refined_markdown ?? "",
    key_changes: Array.isArray(response.key_changes)
      ? response.key_changes
      : [],
  };
}, { name: "refineGrantText" });
