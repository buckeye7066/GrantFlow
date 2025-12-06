/**
 * Build profile context from organization data
 */
export const buildProfileContext = (organization) => {
  return Object.entries(organization)
    .filter(([key, value]) => {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (typeof value === 'string' && value.trim() === '') return false;
      return true;
    })
    .map(([key, value]) => {
      const displayKey = key.replace(/_/g, ' ');
      const displayValue = Array.isArray(value) ? value.join(', ') : value;
      return `${displayKey}: ${displayValue}`;
    })
    .join('\n');
};

/**
 * Build grant context string
 */
export const buildGrantContext = (grant) => {
  return `
Grant Title: ${grant.title}
Funder: ${grant.funder}
Award Amount: ${grant.award_ceiling ? `$${grant.award_ceiling.toLocaleString()}` : grant.award_floor ? `$${grant.award_floor.toLocaleString()}` : 'Not specified'}
Program Description: ${grant.program_description || 'N/A'}
Eligibility: ${grant.eligibility_summary || 'N/A'}
Selection Criteria: ${grant.selection_criteria || 'N/A'}
  `.trim();
};

/**
 * Build complete AI prompt for grant section generation
 */
export const buildGrantSectionPrompt = (organization, grant, currentSection, userPrompt = '') => {
  const isIndividual = ['high_school_student', 'college_student', 'graduate_student', 'individual_need', 'medical_assistance', 'family', 'other'].includes(organization.applicant_type);
  
  const voiceGuidance = isIndividual 
    ? 'Write in FIRST PERSON SINGULAR (I, my, me, mine). This is an individual applicant writing about themselves.'
    : 'Write in FIRST PERSON PLURAL (we, our, us, ours). This is an organization.';

  const profileContext = buildProfileContext(organization);
  const grantContext = buildGrantContext(grant);
  const existingContent = currentSection.draft_content || '';
  const userGuidance = userPrompt.trim();

  return `You are an expert grant writer. Write a clear, professional "${currentSection.section_name}" section that directly addresses the funder's priorities while demonstrating genuine capability.

**CRITICAL VOICE INSTRUCTION:** ${voiceGuidance}

**FUNDER'S PRIORITIES:**
${grantContext}

**APPLICANT'S PROFILE:**
${profileContext}

**SECTION REQUIREMENTS:**
${currentSection.requirements}

${existingContent ? `**PREVIOUS DRAFT (Improve without repeating):**\n${existingContent}\n\n` : ''}
${userGuidance ? `**SPECIFIC GUIDANCE:**\n${userGuidance}\n\n` : ''}

**WRITING GUIDELINES:**

1. **Be Direct and Specific:** State facts clearly without excessive description or emotion
   - ❌ "In the heart of the community, on a crisp morning, we witnessed..."
   - ✅ "Our organization serves 847 families annually in Bradley County..."

2. **Use Concrete Data:** Every claim needs evidence
   - Include numbers, dates, percentages, timeframes
   - Example: "We maintained a 3.8 GPA while completing 150 volunteer hours over three years"
   - Example: "Our program increased graduation rates by 23% from 2022-2024"

3. **Match Funder Language:** Use their exact terminology
   - If they say "advancing forensic science," use those words
   - If they prioritize "community impact," reference that explicitly
   - Mirror their criteria in your writing

4. **Professional Tone:** Warm and genuine, but not dramatic
   - Avoid flowery imagery and emotional scenes
   - Don't overuse adjectives or poetic language
   - Keep it conversational but professional
   - Let the facts speak for themselves

5. **Structure Your Response:**
   - Opening: State your purpose/goal clearly (1-2 sentences)
   - Body: Provide evidence and details (2-3 paragraphs)
   - Connection: Link explicitly to funder's priorities (1 paragraph)
   - Outcome: Describe expected results with metrics (1 paragraph)

6. **Voice Consistency:**
   - Use ${isIndividual ? 'I/my/me' : 'we/our/us'} throughout
   - Maintain first-person narrative
   - Be authentic but professional

7. **Avoid These Common Mistakes:**
   - ❌ Dramatic scenes or storytelling openings
   - ❌ Excessive emotional language ("transforming despair into hope")
   - ❌ Vague statements without data
   - ❌ Generic phrases like "passionate about" or "committed to"
   - ❌ Overly poetic descriptions

8. **Strong Examples:**
   - ✅ "I have maintained a 3.81 GPA while working 20 hours per week to support my family and volunteering 150 hours at the county coroner's office, where I assisted with 23 forensic cases."
   - ✅ "Our after-school program serves 120 students across three Title I elementary schools. In 2023-2024, 94% of participants improved their reading scores by an average of 1.5 grade levels."
   - ✅ "This funding will enable us to expand our mental health services from 2 to 5 days per week, increasing our capacity from 40 to 100 client appointments monthly."

**LENGTH:** 250-400 words (2-4 well-developed paragraphs)

**TONE:** Professional, genuine, data-driven, straightforward

Write now. Be clear, specific, and professional.`;
};

/**
 * Get word count from text
 */
export const getWordCount = (text) => {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
};

/**
 * Get word count status (good, warning, error)
 */
export const getWordCountStatus = (wordCount) => {
  if (wordCount < 200) return 'low';
  if (wordCount > 450) return 'high';
  return 'good';
};

/**
 * Get word count message
 */
export const getWordCountMessage = (wordCount) => {
  const status = getWordCountStatus(wordCount);
  if (status === 'low') return `${wordCount} words - Consider adding more detail`;
  if (status === 'high') return `${wordCount} words - Consider condensing`;
  return `${wordCount} words - Good length`;
};

/**
 * Get word count color class
 */
export const getWordCountColorClass = (wordCount) => {
  const status = getWordCountStatus(wordCount);
  if (status === 'low') return 'text-amber-600';
  if (status === 'high') return 'text-amber-600';
  return 'text-emerald-600';
};