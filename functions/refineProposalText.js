import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { content, refinement_type, grant_id } = await req.json();
    if (!content || !refinement_type) return Response.json({ error: 'content and refinement_type required' }, { status: 400 });

    const prompts = {
      clarity: 'Improve clarity of this text: ' + content,
      persuasiveness: 'Make this more compelling and persuasive: ' + content,
      grammar: 'Fix grammar, punctuation, spelling in: ' + content,
      conciseness: 'Make this more concise: ' + content,
      expansion: 'Expand this with more detail: ' + content
    };

    const refinedContent = await base44.integrations.Core.InvokeLLM({ prompt: prompts[refinement_type] || content });

    return Response.json({ success: true, original: content, refined: refinedContent, changes: { original_words: content.split(/\s+/).length, refined_words: refinedContent.split(/\s+/).length } });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});