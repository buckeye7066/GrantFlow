import React from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Sparkles, Loader2 } from 'lucide-react';
import client from '@/api/client';

export default function AIFormField({ 
  label, 
  name, 
  value, 
  onChange, 
  placeholder, 
  aiPrompt,
  organization,
  onError,
  rows = 4 
}) {
  const [isGenerating, setIsGenerating] = React.useState(false);

  const handleAIGenerate = async () => {
    if (!organization || !aiPrompt) return;
    
    setIsGenerating(true);
    try {
      // Determine voice based on applicant type
      const isOrganization = organization.applicant_type === 'organization';
      const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(organization.applicant_type);
      const isIndividualNeed = ['individual_need', 'medical_assistance', 'family', 'other'].includes(organization.applicant_type);
      const isIndividual = isStudent || isIndividualNeed;
      
      let voiceInstruction;
      let pronounGuidance;
      
      if (isOrganization) {
        voiceInstruction = '⚠️ CRITICAL: This is an ORGANIZATION. Write in FIRST PERSON PLURAL (we, our, us) THROUGHOUT THE ENTIRE RESPONSE.';
        pronounGuidance = 'Use "we", "our", "us" in every sentence. NEVER use "I", "my", "me".';
      } else if (isStudent) {
        voiceInstruction = '⚠️ CRITICAL: This is a STUDENT INDIVIDUAL. Write in FIRST PERSON SINGULAR (I, my, me) THROUGHOUT THE ENTIRE RESPONSE.';
        pronounGuidance = 'Use "I", "my", "me" in every sentence. NEVER use "we", "our", "us". This is about ONE PERSON, not a group.';
      } else if (isIndividualNeed) {
        voiceInstruction = '⚠️ CRITICAL: This is an INDIVIDUAL seeking assistance. Write in FIRST PERSON SINGULAR (I, my, me) THROUGHOUT THE ENTIRE RESPONSE.';
        pronounGuidance = 'Use "I", "my", "me" in every sentence. NEVER use "we", "our", "us". This is about ONE PERSON and their personal situation.';
      } else {
        voiceInstruction = '⚠️ CRITICAL: This is an INDIVIDUAL. Write in FIRST PERSON SINGULAR (I, my, me) THROUGHOUT THE ENTIRE RESPONSE.';
        pronounGuidance = 'Use "I", "my", "me" in every sentence. NEVER use "we", "our", "us".';
      }

      const contextInfo = `
APPLICANT TYPE: ${organization.applicant_type || 'organization'} ${isOrganization ? '(ORGANIZATION)' : '(INDIVIDUAL)'}
Name: ${organization.name}
${organization.mission ? `Bio/Mission: ${organization.mission}` : ''}
${organization.primary_goal ? `Goal: ${organization.primary_goal}` : ''}
${organization.intended_major ? `Major: ${organization.intended_major}` : ''}
${organization.city && organization.state ? `Location: ${organization.city}, ${organization.state}` : ''}
${organization.gpa ? `GPA: ${organization.gpa}` : ''}
${organization.financial_need_level ? `Need Level: ${organization.financial_need_level}` : ''}
${organization.military_status ? `Military Status: ${organization.military_status}` : ''}
${organization.disability_status ? `Disability Status: ${organization.disability_status}` : ''}
${organization.veteran ? `Veteran: ${organization.veteran}` : ''}
${organization.health_conditions ? `Health Conditions: ${organization.health_conditions}` : ''}
${organization.family_size ? `Family Size: ${organization.family_size}` : ''}
${organization.housing_situation ? `Housing Situation: ${organization.housing_situation}` : ''}
${organization.emergency_context ? `Emergency Context: ${organization.emergency_context}` : ''}
${organization.business_type ? `Business Type: ${organization.business_type}` : ''}
${organization.years_in_operation ? `Years in Operation: ${organization.years_in_operation}` : ''}
${organization.income_level ? `Income Level: ${organization.income_level}` : ''}
${organization.race_ethnicity ? `Race/Ethnicity: ${organization.race_ethnicity}` : ''}
${organization.gender ? `Gender: ${organization.gender}` : ''}
${organization.first_generation_college ? `First-Generation College Student: ${organization.first_generation_college}` : ''}
${organization.caregiver_status ? `Caregiver Status: ${organization.caregiver_status}` : ''}
${organization.dependents ? `Dependents: ${organization.dependents}` : ''}
`;

      const fullPrompt = `${voiceInstruction}

${pronounGuidance}

CONTEXT ABOUT THE APPLICANT:
${contextInfo}

YOUR TASK: ${aiPrompt}

RESPONSE REQUIREMENTS:
- Write 2-3 paragraphs (100-200 words)
- Professional and compelling tone
- ${isIndividual ? 'Write from a PERSONAL perspective using "I", "my", "me"' : 'Write from an ORGANIZATIONAL perspective using "we", "our", "us"'}
- Be specific and authentic
- Do NOT include any meta-commentary or explanations
- Start writing the response directly

${isIndividual ? 'REMEMBER: You are writing as ONE INDIVIDUAL PERSON. Use I, my, me.' : 'REMEMBER: You are writing as an ORGANIZATION. Use we, our, us.'}`;

      const response = await client.integrations.Core.InvokeLLM({ prompt: fullPrompt });
      const generatedText = typeof response === 'string'
        ? response
        : (response?.output ?? response?.text ?? response?.content ?? null);
      if (!generatedText || typeof generatedText !== 'string' || !generatedText.trim()) {
        console.error('AI generation returned empty or unrecognised response:', response);
        return;
      }
      onChange({ target: { name, value: generatedText.trim() } });
    } catch (error) {
      console.error('AI generation failed:', error);
      // Do NOT overwrite the field – preserve whatever the user already typed.
      // Surface the failure through an optional onError prop so the parent can
      // display a plain-language toast/alert without losing field content.
      if (typeof onError === 'function') {
        onError('AI suggestion failed. Your existing text has been preserved.');
      }
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={name}>{label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleAIGenerate}
          disabled={isGenerating || !organization}
          className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Suggest with AI
            </>
          )}
        </Button>
      </div>
      <Textarea
        id={name}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={rows}
      />
    </div>
  );
}