export const formatAddress = (organization) => {
  const parts = [
    organization.address,
    organization.city,
    organization.state,
    organization.zip
  ].filter(Boolean);
  
  return parts.join(', ').trim();
};

export const buildProfileContext = (organization) => {
  return Object.entries(organization)
    .filter(([, value]) => value && (!Array.isArray(value) || value.length > 0))
    .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join('\n');
};

export const buildPortalAnswerPrompt = (organization, grant, question) => {
  const profileContext = buildProfileContext(organization);
  
  const grantContext = `
- Grant Title: ${grant.title}
- Funder: ${grant.funder}
- Program Description: ${grant.program_description || 'N/A'}
  `.trim();

  return `You are an expert grant writing assistant. Your task is to answer a question from a grant application portal based on the provided context.

CONTEXT - APPLICANT PROFILE:
---
${profileContext}
---

CONTEXT - GRANT OPPORTUNITY:
---
${grantContext}
---

PORTAL QUESTION:
"${question}"

INSTRUCTIONS:
1. Synthesize information from BOTH the applicant profile and the grant opportunity context.
2. Draft a clear, concise, and compelling answer to the portal question.
3. The response should be ready to be pasted directly into the application. Do NOT add any extra conversational text, greetings, or explanations.
`;
};

export const validateAIResponse = (response) => {
  if (!response || typeof response !== 'string') {
    throw new Error('Invalid AI response: expected a non-empty string');
  }
  
  if (response.trim().length === 0) {
    throw new Error('AI returned an empty response');
  }
  
  return response.trim();
};

export const getCharacterCount = (text) => {
  return text ? text.length : 0;
};

export const getWordCount = (text) => {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
};