export async function invokeLLM(base44, {
  prompt,
  responseSchema,
  temperature = 0.7,
  maxOutputTokens = 800,
  addContext = false,
}) {
  if (!prompt || typeof prompt !== "string") {
    throw new Error("Prompt is required for LLM invocation");
  }

  const payload = {
    prompt,
    temperature,
    max_output_tokens: maxOutputTokens,
    add_context_from_internet: addContext,
  };

  if (responseSchema) {
    payload.response_json_schema = responseSchema;
  }

  const response = await base44.integrations.Core.InvokeLLM(payload);
  if (!response) {
    throw new Error("LLM call returned no response");
  }
  return response;
}

export function formatSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections
    .map((section) => {
      if (typeof section === "string") {
        return { id: section, title: section.replace(/_/g, " ") };
      }
      if (section && typeof section === "object") {
        return {
          id: section.id ?? section.key ?? section.title ?? "section",
          title: section.title ?? section.name ?? section.id ?? "Section",
          instructions: section.instructions ?? section.prompt ?? "",
        };
      }
      return null;
    })
    .filter(Boolean);
}
