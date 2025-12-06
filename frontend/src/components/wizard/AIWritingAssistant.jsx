import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Sparkles, 
  Wand2, 
  RefreshCw, 
  Copy, 
  CheckCircle2, 
  Loader2,
  Tags,
  Lightbulb,
  ArrowRight,
  FileText,
  Target,
  Zap,
  AlertTriangle
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { base44 } from '@/api/base44Client';

export default function AIWritingAssistant({ 
  grant, 
  organization, 
  initialText = '',
  sectionType = 'general',
  onTextGenerated,
  wordLimit = null 
}) {
  const [activeTab, setActiveTab] = useState('guidance');
  const [inputText, setInputText] = useState(initialText);
  const [outputText, setOutputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [copiedGenerate, setCopiedGenerate] = useState(false);
  const [copiedRefine, setCopiedRefine] = useState(false);
  
  // Refinement options
  const [focus, setFocus] = useState('clarity');
  const [tone, setTone] = useState('professional');
  
  // Keyword suggestions
  const [keywordSuggestions, setKeywordSuggestions] = useState(null);
  const [selectedKeywords, setSelectedKeywords] = useState([]);
  
  // Funder guidance
  const [funderGuidance, setFunderGuidance] = useState(null);
  const [isLoadingGuidance, setIsLoadingGuidance] = useState(false);
  
  const { toast } = useToast();

  const handleFetchGuidance = async () => {
    if (!grant?.id) {
      toast({
        variant: 'destructive',
        title: 'Missing Information',
        description: 'Grant data required for guidance',
      });
      return;
    }

    setIsLoadingGuidance(true);
    setFunderGuidance(null);

    try {
      const llmResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `You are an expert MBA-level grant writing consultant. Analyze this funding opportunity and provide strategic guidance for writing a winning application.

FUNDING OPPORTUNITY:
Title: ${grant.title}
Funder: ${grant.funder}
${grant.program_description ? `Program Description: ${grant.program_description}` : ''}
${grant.eligibility_summary ? `Eligibility: ${grant.eligibility_summary}` : ''}
${grant.selection_criteria ? `Selection Criteria: ${grant.selection_criteria}` : ''}
${grant.url ? `URL: ${grant.url}` : ''}

APPLICANT:
Name: ${organization?.name || 'Not specified'}
Type: ${organization?.applicant_type || 'Not specified'}
Mission: ${organization?.mission || 'Not specified'}
Focus Areas: ${organization?.focus_areas?.join(', ') || 'Not specified'}

SECTION BEING WRITTEN: ${sectionType.replace(/_/g, ' ')}

Research the funder's website, past awards, and priorities. Provide MBA-level strategic guidance.`,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          properties: {
            funder_priorities: {
              type: "array",
              items: { type: "string" },
              description: "Key priorities and values of this funder based on research"
            },
            what_funder_looks_for: {
              type: "array",
              items: { type: "string" },
              description: "Specific elements funders want to see in applications"
            },
            past_award_insights: {
              type: "string",
              description: "Insights from past awards or funded projects if available"
            },
            section_requirements: {
              type: "object",
              properties: {
                must_include: { type: "array", items: { type: "string" } },
                avoid: { type: "array", items: { type: "string" } },
                tone_guidance: { type: "string" },
                structure_tips: { type: "string" }
              }
            },
            strategic_recommendations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  recommendation: { type: "string" },
                  rationale: { type: "string" }
                }
              },
              description: "MBA-level strategic recommendations for this section"
            },
            differentiators: {
              type: "array",
              items: { type: "string" },
              description: "What would make this application stand out"
            },
            common_mistakes: {
              type: "array",
              items: { type: "string" },
              description: "Common mistakes to avoid"
            },
            sample_strong_phrases: {
              type: "array",
              items: { type: "string" },
              description: "Sample strong phrases or language patterns to use"
            }
          }
        }
      });

      setFunderGuidance(llmResponse);
      toast({
        title: '📚 Guidance Generated',
        description: 'Strategic insights loaded for your section',
      });
    } catch (error) {
      console.error('[AIWritingAssistant] Guidance error:', error);
      toast({
        variant: 'destructive',
        title: 'Guidance Failed',
        description: error.message || 'Could not fetch funder guidance',
      });
    } finally {
      setIsLoadingGuidance(false);
    }
  };

  const handleGenerate = async () => {
    if (!grant?.id || !organization?.id) {
      toast({
        variant: 'destructive',
        title: 'Missing Information',
        description: 'Grant and organization data required for generation',
      });
      return;
    }

    setIsProcessing(true);
    setOutputText('');

    try {
      console.log('[AIWritingAssistant] Using InvokeLLM directly for generation...');
      
      // Build context from funder guidance if available
      const guidanceContext = funderGuidance ? `
FUNDER PRIORITIES (from research):
${funderGuidance.funder_priorities?.join('\n- ') || 'Not available'}

WHAT FUNDER LOOKS FOR:
${funderGuidance.what_funder_looks_for?.join('\n- ') || 'Not available'}

SECTION REQUIREMENTS:
- Must include: ${funderGuidance.section_requirements?.must_include?.join(', ') || 'Not specified'}
- Avoid: ${funderGuidance.section_requirements?.avoid?.join(', ') || 'Not specified'}
- Tone: ${funderGuidance.section_requirements?.tone_guidance || 'Professional'}

DIFFERENTIATORS TO HIGHLIGHT:
${funderGuidance.differentiators?.join('\n- ') || 'Not available'}
` : '';

      // Build comprehensive profile context for personalized writing
      const profileContext = [];
      if (organization.age) profileContext.push(`Age: ${organization.age}`);
      if (organization.gpa) profileContext.push(`GPA: ${organization.gpa}`);
      if (organization.intended_major) profileContext.push(`Field of Study: ${organization.intended_major}`);
      if (organization.current_college) profileContext.push(`Current School: ${organization.current_college}`);
      if (organization.target_colleges?.length) profileContext.push(`Target Colleges: ${organization.target_colleges.join(', ')}`);
      if (organization.city && organization.state) profileContext.push(`Location: ${organization.city}, ${organization.state}`);
      if (organization.household_income) profileContext.push(`Household Income: $${organization.household_income.toLocaleString()}`);
      
      // Special circumstances for authentic storytelling
      const specialCircumstances = [];
      if (organization.first_generation) specialCircumstances.push('first-generation college student');
      if (organization.low_income) specialCircumstances.push('from a low-income background');
      if (organization.foster_youth) specialCircumstances.push('foster youth');
      if (organization.homeless) specialCircumstances.push('experienced housing insecurity');
      if (organization.single_parent) specialCircumstances.push('raised by a single parent');
      if (organization.caregiver) specialCircumstances.push('serves as a caregiver');
      if (organization.veteran || organization.military_service?.veteran) specialCircumstances.push('veteran/military family');
      if (organization.cancer_survivor) specialCircumstances.push('cancer survivor');
      if (organization.chronic_illness) specialCircumstances.push('overcomes chronic illness');
      if (organization.disabilities?.length) specialCircumstances.push(`manages ${organization.disabilities.join(', ')}`);
      if (organization.lgbtq) specialCircumstances.push('LGBTQ+');
      if (organization.new_immigrant || organization.refugee) specialCircumstances.push('immigrant/refugee background');
      
      // Use InvokeLLM directly instead of backend function
      const llmResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `You are an expert grant writer ghostwriting for an applicant. Generate a compelling ${sectionType.replace(/_/g, ' ')} response written IN FIRST PERSON from the applicant's perspective.

CRITICAL: This response must be UNIQUE to this specific funder. No two funders are the same, so this application should NOT look like any other application. Tailor every sentence to ${grant.funder}'s specific priorities, language, and values.

APPLICANT PROFILE:
Name: ${organization.name}
Type: ${organization.applicant_type?.replace(/_/g, ' ') || 'individual'}
${profileContext.length > 0 ? 'Details:\n- ' + profileContext.join('\n- ') : ''}
${specialCircumstances.length > 0 ? '\nPersonal Circumstances: ' + specialCircumstances.join(', ') : ''}

Mission/Purpose: ${organization.mission || organization.primary_goal || 'Not provided'}
Unique Story: ${organization.unique_story || organization.special_circumstances || 'Not provided'}
Goals: ${organization.goals || 'Not provided'}
Challenges: ${organization.challenges_barriers || organization.barriers_faced || 'Not provided'}
Extracurriculars: ${organization.extracurricular_activities?.join(', ') || 'Not provided'}
Awards: ${organization.awards_achievements?.join(', ') || organization.competitions_awards?.join(', ') || 'Not provided'}

FUNDER: ${grant.funder}
GRANT: ${grant.title}
PROGRAM DESCRIPTION: ${grant.program_description || 'See grant listing'}
${grant.eligibility_summary ? `ELIGIBILITY REQUIREMENTS: ${grant.eligibility_summary}` : ''}
${grant.selection_criteria ? `SELECTION CRITERIA: ${grant.selection_criteria}` : ''}
${grant.url ? `FUNDER URL: ${grant.url}` : ''}

${guidanceContext}

${wordLimit ? `WORD LIMIT: ${wordLimit} words maximum - be concise` : ''}

WRITING REQUIREMENTS - MBA LEVEL QUALITY:
1. WRITE IN FIRST PERSON ("I am...", "My experience...", "I will...")
2. TAILOR SPECIFICALLY TO ${grant.funder} - use their language, mirror their values
3. Be authentic and personal - draw from the applicant's real experiences
4. Use specific, quantifiable outcomes where possible
5. Show understanding of the funder's mission and how applicant aligns
6. Demonstrate maturity, self-awareness, and growth mindset
7. Include a compelling hook in the opening sentence
8. End with forward-looking impact statement
9. NO generic phrases like "I am passionate about" - be specific
10. Reference specific programs, values, or initiatives of ${grant.funder} if known

Write as if you ARE the applicant speaking directly to ${grant.funder}. Make it authentic, compelling, and impossible to confuse with any other application. Return ONLY the response text.`,
        add_context_from_internet: true
      });

      const responseText = typeof llmResponse === 'string' ? llmResponse : (llmResponse?.content || llmResponse?.response || '');
      
      if (responseText) {
        setOutputText(responseText);
        
        if (onTextGenerated) {
          onTextGenerated(responseText);
        }
        
        toast({
          title: '✨ Draft Generated',
          description: `Created ${responseText.split(/\s+/).length} word response`,
        });
      } else {
        throw new Error('No response generated');
      }
    } catch (error) {
      console.error('[AIWritingAssistant] Generation error:', error);
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message || 'Could not generate draft',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRefine = async () => {
    if (!inputText || inputText.trim().length < 10) {
      toast({
        variant: 'destructive',
        title: 'Text Required',
        description: 'Enter text to refine (at least 10 characters)',
      });
      return;
    }

    setIsProcessing(true);
    setOutputText('');

    try {
      console.log('[AIWritingAssistant] Using InvokeLLM for text refinement...');
      
      // Use InvokeLLM directly instead of backend function
      const llmResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `You are an expert grant writer. Refine the following text to improve its ${focus} while maintaining a ${tone} tone.

ORIGINAL TEXT:
${inputText}

${wordLimit ? `WORD LIMIT: ${wordLimit} words maximum` : ''}

Improve the text for grant application purposes. Focus on ${focus}. Use a ${tone} tone.
Return ONLY the refined text, no explanations.`,
        add_context_from_internet: false
      });

      const refinedText = typeof llmResponse === 'string' ? llmResponse : (llmResponse?.content || llmResponse?.response || '');
      
      if (refinedText) {
        setOutputText(refinedText);
        
        if (onTextGenerated) {
          onTextGenerated(refinedText);
        }
        
        toast({
          title: '✨ Text Refined',
          description: 'Text has been improved',
          duration: 5000,
        });
      } else {
        throw new Error('No refined text returned');
      }
    } catch (error) {
      console.error('[AIWritingAssistant] Refinement error:', error);
      toast({
        variant: 'destructive',
        title: 'Refinement Failed',
        description: error.message || 'Could not refine text',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSuggestKeywords = async () => {
    if (!grant?.id || !organization?.id) {
      toast({
        variant: 'destructive',
        title: 'Missing Information',
        description: 'Grant and organization data required',
      });
      return;
    }

    setIsProcessing(true);
    setKeywordSuggestions(null);

    try {
      console.log('[AIWritingAssistant] Using InvokeLLM for keyword suggestions...');
      
      // Use InvokeLLM directly instead of backend function
      const llmResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `You are an expert grant writer. Analyze this grant opportunity and organization to suggest optimal keywords.

ORGANIZATION: ${organization.name}
FOCUS AREAS: ${organization.focus_areas?.join(', ') || 'Not provided'}
MISSION: ${organization.mission || 'Not provided'}

GRANT: ${grant.title}
FUNDER: ${grant.funder}
PROGRAM: ${grant.program_description || 'See grant listing'}

${inputText || outputText ? `APPLICATION TEXT:\n${inputText || outputText}` : ''}

Suggest keywords that would strengthen this grant application.`,
        response_json_schema: {
          type: "object",
          properties: {
            keywords: {
              type: "object",
              properties: {
                primary: { type: "array", items: { type: "string" } },
                secondary: { type: "array", items: { type: "string" } },
                all_unique: { type: "array", items: { type: "string" } }
              }
            },
            tags: { type: "array", items: { type: "string" } },
            missing_opportunities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  keyword: { type: "string" },
                  reason: { type: "string" },
                  suggested_usage: { type: "string" }
                }
              }
            }
          }
        }
      });

      const result = llmResponse || {};
      
      if (result.keywords) {
        setKeywordSuggestions({ success: true, ...result });
        setSelectedKeywords([]);
        
        toast({
          title: '🏷️ Keywords Generated',
          description: `Found ${result.keywords?.all_unique?.length || 0} relevant keywords`,
        });
      } else {
        throw new Error('No suggestions returned');
      }
    } catch (error) {
      console.error('[AIWritingAssistant] Keywords error:', error);
      toast({
        variant: 'destructive',
        title: 'Suggestion Failed',
        description: error.message || 'Could not generate keywords',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCopy = (text, setter) => {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
    
    toast({
      title: 'Copied to Clipboard',
      description: 'Text has been copied',
    });
  };

  const handleApplyKeywords = () => {
    if (selectedKeywords.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No Keywords Selected',
        description: 'Select keywords to apply',
      });
      return;
    }

    const keywordText = selectedKeywords.join(', ');
    
    toast({
      title: '✅ Keywords Ready',
      description: `${selectedKeywords.length} keywords selected`,
    });
    
    // Copy to clipboard automatically
    navigator.clipboard.writeText(keywordText);
  };

  const toggleKeyword = (keyword) => {
    setSelectedKeywords(prev => 
      prev.includes(keyword)
        ? prev.filter(k => k !== keyword)
        : [...prev, keyword]
    );
  };

  return (
    <Card className="border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-purple-900">
          <Sparkles className="w-5 h-5" />
          AI Writing Assistant
        </CardTitle>
        <CardDescription>
          Generate drafts, refine text, and optimize keywords for your grant application
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="guidance" className="gap-2">
              <Lightbulb className="w-4 h-4" />
              Guidance
            </TabsTrigger>
            <TabsTrigger value="generate" className="gap-2">
              <Wand2 className="w-4 h-4" />
              Generate
            </TabsTrigger>
            <TabsTrigger value="refine" className="gap-2">
              <RefreshCw className="w-4 h-4" />
              Refine
            </TabsTrigger>
            <TabsTrigger value="keywords" className="gap-2">
              <Tags className="w-4 h-4" />
              Keywords
            </TabsTrigger>
          </TabsList>

          {/* GUIDANCE TAB */}
          <TabsContent value="guidance" className="space-y-4">
            <Alert className="bg-indigo-50 border-indigo-200">
              <Lightbulb className="h-4 w-4 text-indigo-600" />
              <AlertDescription className="text-indigo-900">
                AI researches the funder's website, past awards, and priorities to provide MBA-level strategic guidance for writing this section.
              </AlertDescription>
            </Alert>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">
                  Section: {sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </Label>
                <Badge variant="outline" className="bg-indigo-50 text-indigo-700">
                  {grant?.funder || 'Unknown Funder'}
                </Badge>
              </div>

              <Button
                onClick={handleFetchGuidance}
                disabled={isLoadingGuidance}
                className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700"
                size="lg"
              >
                {isLoadingGuidance ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Researching Funder...
                  </>
                ) : (
                  <>
                    <Lightbulb className="w-5 h-5 mr-2" />
                    Get Funder Guidance & Requirements
                  </>
                )}
              </Button>

              {funderGuidance && (
                <div className="space-y-4 mt-4">
                  {/* Funder Priorities */}
                  {funderGuidance.funder_priorities?.length > 0 && (
                    <div className="p-4 bg-white rounded-lg border-2 border-indigo-200">
                      <div className="flex items-center gap-2 mb-3">
                        <Target className="w-4 h-4 text-indigo-600" />
                        <h4 className="font-semibold text-indigo-900">Funder Priorities</h4>
                      </div>
                      <ul className="space-y-2">
                        {funderGuidance.funder_priorities.map((priority, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-sm">
                            <span className="text-indigo-500 mt-0.5">•</span>
                            <span>{priority}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* What Funder Looks For */}
                  {funderGuidance.what_funder_looks_for?.length > 0 && (
                    <div className="p-4 bg-white rounded-lg border-2 border-green-200">
                      <div className="flex items-center gap-2 mb-3">
                        <CheckCircle2 className="w-4 h-4 text-green-600" />
                        <h4 className="font-semibold text-green-900">What This Funder Looks For</h4>
                      </div>
                      <ul className="space-y-2">
                        {funderGuidance.what_funder_looks_for.map((item, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-sm">
                            <CheckCircle2 className="w-3 h-3 text-green-600 mt-1 flex-shrink-0" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Past Award Insights */}
                  {funderGuidance.past_award_insights && (
                    <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
                      <div className="flex items-center gap-2 mb-2">
                        <FileText className="w-4 h-4 text-amber-600" />
                        <h4 className="font-semibold text-amber-900">Insights from Past Awards</h4>
                      </div>
                      <p className="text-sm text-amber-900">{funderGuidance.past_award_insights}</p>
                    </div>
                  )}

                  {/* Section Requirements */}
                  {funderGuidance.section_requirements && (
                    <div className="p-4 bg-white rounded-lg border-2 border-blue-200">
                      <div className="flex items-center gap-2 mb-3">
                        <FileText className="w-4 h-4 text-blue-600" />
                        <h4 className="font-semibold text-blue-900">Section Requirements</h4>
                      </div>
                      <div className="space-y-3 text-sm">
                        {funderGuidance.section_requirements.must_include?.length > 0 && (
                          <div>
                            <p className="font-medium text-green-700 mb-1">✓ Must Include:</p>
                            <ul className="ml-4 space-y-1">
                              {funderGuidance.section_requirements.must_include.map((item, idx) => (
                                <li key={idx} className="text-slate-700">• {item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {funderGuidance.section_requirements.avoid?.length > 0 && (
                          <div>
                            <p className="font-medium text-red-700 mb-1">✗ Avoid:</p>
                            <ul className="ml-4 space-y-1">
                              {funderGuidance.section_requirements.avoid.map((item, idx) => (
                                <li key={idx} className="text-slate-700">• {item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {funderGuidance.section_requirements.tone_guidance && (
                          <div>
                            <p className="font-medium text-blue-700">Tone: </p>
                            <p className="text-slate-700">{funderGuidance.section_requirements.tone_guidance}</p>
                          </div>
                        )}
                        {funderGuidance.section_requirements.structure_tips && (
                          <div>
                            <p className="font-medium text-blue-700">Structure Tips: </p>
                            <p className="text-slate-700">{funderGuidance.section_requirements.structure_tips}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Strategic Recommendations */}
                  {funderGuidance.strategic_recommendations?.length > 0 && (
                    <div className="p-4 bg-gradient-to-br from-purple-50 to-pink-50 rounded-lg border-2 border-purple-200">
                      <div className="flex items-center gap-2 mb-3">
                        <Zap className="w-4 h-4 text-purple-600" />
                        <h4 className="font-semibold text-purple-900">MBA-Level Strategic Recommendations</h4>
                      </div>
                      <div className="space-y-3">
                        {funderGuidance.strategic_recommendations.map((rec, idx) => (
                          <div key={idx} className="p-3 bg-white rounded-lg border border-purple-100">
                            <p className="font-medium text-purple-900 text-sm">{rec.recommendation}</p>
                            {rec.rationale && (
                              <p className="text-xs text-slate-600 mt-1 italic">Why: {rec.rationale}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Differentiators */}
                  {funderGuidance.differentiators?.length > 0 && (
                    <div className="p-4 bg-emerald-50 rounded-lg border border-emerald-200">
                      <div className="flex items-center gap-2 mb-3">
                        <Sparkles className="w-4 h-4 text-emerald-600" />
                        <h4 className="font-semibold text-emerald-900">What Makes Applications Stand Out</h4>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {funderGuidance.differentiators.map((diff, idx) => (
                          <Badge key={idx} className="bg-emerald-100 text-emerald-800 border-emerald-300">
                            {diff}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Common Mistakes */}
                  {funderGuidance.common_mistakes?.length > 0 && (
                    <div className="p-4 bg-red-50 rounded-lg border border-red-200">
                      <div className="flex items-center gap-2 mb-3">
                        <AlertTriangle className="w-4 h-4 text-red-600" />
                        <h4 className="font-semibold text-red-900">Common Mistakes to Avoid</h4>
                      </div>
                      <ul className="space-y-1">
                        {funderGuidance.common_mistakes.map((mistake, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-sm text-red-800">
                            <span className="text-red-500">✗</span>
                            <span>{mistake}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Sample Strong Phrases */}
                  {funderGuidance.sample_strong_phrases?.length > 0 && (
                    <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                      <div className="flex items-center gap-2 mb-3">
                        <FileText className="w-4 h-4 text-blue-600" />
                        <h4 className="font-semibold text-blue-900">Sample Strong Phrases to Use</h4>
                      </div>
                      <div className="space-y-2">
                        {funderGuidance.sample_strong_phrases.map((phrase, idx) => (
                          <p key={idx} className="text-sm italic text-blue-800 p-2 bg-white rounded border border-blue-100">
                            "{phrase}"
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  <Alert className="bg-green-50 border-green-200">
                    <ArrowRight className="h-4 w-4 text-green-600" />
                    <AlertDescription className="text-green-900">
                      Now go to the <strong>Generate</strong> tab to create a draft that incorporates this guidance.
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </div>
          </TabsContent>

          {/* GENERATE TAB */}
          <TabsContent value="generate" className="space-y-4">
            <Alert className="bg-blue-50 border-blue-200">
              <Sparkles className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-900">
                AI will create a complete draft response based on your organization profile, 
                past grants, and this opportunity's requirements.
              </AlertDescription>
            </Alert>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">
                  {sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </Label>
                {wordLimit && (
                  <Badge variant="outline">{wordLimit} word limit</Badge>
                )}
              </div>

              <Button
                onClick={handleGenerate}
                disabled={isProcessing}
                className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
                size="lg"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Generating Draft...
                  </>
                ) : (
                  <>
                    <Wand2 className="w-5 h-5 mr-2" />
                    Generate Complete Draft
                  </>
                )}
              </Button>

              {outputText && (
                <div className="space-y-3 mt-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-semibold text-green-700">Generated Draft:</Label>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="bg-white">
                        {outputText.split(/\s+/).length} words
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCopy(outputText, setCopiedGenerate)}
                      >
                        {copiedGenerate ? (
                          <>
                            <CheckCircle2 className="w-4 h-4 mr-2 text-green-600" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4 mr-2" />
                            Copy
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    value={outputText}
                    readOnly
                    className="min-h-[200px] bg-white border-2 border-green-200"
                  />
                  <p className="text-xs text-slate-600">
                    💡 Review and edit this draft as needed, then paste into your application
                  </p>
                </div>
              )}
            </div>
          </TabsContent>

          {/* REFINE TAB */}
          <TabsContent value="refine" className="space-y-4">
            <Alert className="bg-amber-50 border-amber-200">
              <RefreshCw className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-900">
                Paste your existing text below and AI will improve its clarity, tone, and impact.
              </AlertDescription>
            </Alert>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-sm">Focus On</Label>
                  <Select value={focus} onValueChange={setFocus}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="clarity">Clarity & Readability</SelectItem>
                      <SelectItem value="conciseness">Conciseness</SelectItem>
                      <SelectItem value="impact">Impact & Persuasiveness</SelectItem>
                      <SelectItem value="professionalism">Professionalism</SelectItem>
                      <SelectItem value="grammar">Grammar & Style</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-sm">Tone</Label>
                  <Select value={tone} onValueChange={setTone}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="compassionate">Compassionate</SelectItem>
                      <SelectItem value="academic">Academic/Scholarly</SelectItem>
                      <SelectItem value="persuasive">Persuasive</SelectItem>
                      <SelectItem value="technical">Technical/Data-Driven</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="text-sm font-semibold mb-2 block">Your Text to Refine:</Label>
                <Textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Paste your grant text here to improve it..."
                  className="min-h-[150px]"
                />
                <p className="text-xs text-slate-500 mt-1">
                  {inputText.split(/\s+/).filter(w => w).length} words
                </p>
              </div>

              <Button
                onClick={handleRefine}
                disabled={isProcessing || !inputText.trim()}
                className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700"
                size="lg"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Refining Text...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-5 h-5 mr-2" />
                    Refine & Improve
                  </>
                )}
              </Button>

              {outputText && activeTab === 'refine' && (
                <div className="space-y-3 mt-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-semibold text-green-700">Refined Version:</Label>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="bg-white">
                        {outputText.split(/\s+/).length} words
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCopy(outputText, setCopiedRefine)}
                      >
                        {copiedRefine ? (
                          <>
                            <CheckCircle2 className="w-4 h-4 mr-2 text-green-600" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4 mr-2" />
                            Copy
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    value={outputText}
                    readOnly
                    className="min-h-[200px] bg-white border-2 border-green-200"
                  />
                  
                  <div className="flex items-start gap-2 p-3 bg-green-50 rounded-lg border border-green-200">
                    <Lightbulb className="w-5 h-5 text-green-600 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-green-900">Before/After Comparison:</p>
                      <div className="grid grid-cols-2 gap-4 mt-2 text-xs">
                        <div>
                          <span className="text-slate-600">Original: </span>
                          <span className="font-semibold">{inputText.split(/\s+/).length} words</span>
                        </div>
                        <div>
                          <span className="text-slate-600">Refined: </span>
                          <span className="font-semibold">{outputText.split(/\s+/).length} words</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </TabsContent>

          {/* KEYWORDS TAB */}
          <TabsContent value="keywords" className="space-y-4">
            <Alert className="bg-emerald-50 border-emerald-200">
              <Tags className="h-4 w-4 text-emerald-600" />
              <AlertDescription className="text-emerald-900">
                AI will analyze the grant requirements and suggest optimal keywords and tags 
                to strengthen your application's visibility and alignment.
              </AlertDescription>
            </Alert>

            <div className="space-y-3">
              <Label className="text-sm font-semibold">
                Optional: Add Application Text for Better Suggestions
              </Label>
              <Textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Paste your draft application text here (optional - AI will analyze grant and org data regardless)"
                className="min-h-[100px]"
              />

              <Button
                onClick={handleSuggestKeywords}
                disabled={isProcessing}
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700"
                size="lg"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Tags className="w-5 h-5 mr-2" />
                    Suggest Keywords & Tags
                  </>
                )}
              </Button>

              {keywordSuggestions && (
                <div className="space-y-4 mt-4">
                  {/* Primary Keywords */}
                  <div className="p-4 bg-white rounded-lg border-2 border-emerald-200">
                    <div className="flex items-center gap-2 mb-3">
                      <Target className="w-4 h-4 text-emerald-600" />
                      <h4 className="font-semibold text-emerald-900">Primary Keywords</h4>
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700">
                        High Priority
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {keywordSuggestions.keywords.primary.map((keyword, idx) => (
                        <Badge
                          key={idx}
                          variant={selectedKeywords.includes(keyword) ? 'default' : 'outline'}
                          className="cursor-pointer hover:bg-emerald-100 transition-colors"
                          onClick={() => toggleKeyword(keyword)}
                        >
                          {keyword}
                          {selectedKeywords.includes(keyword) && (
                            <CheckCircle2 className="w-3 h-3 ml-1" />
                          )}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Secondary Keywords */}
                  <div className="p-4 bg-white rounded-lg border border-slate-200">
                    <div className="flex items-center gap-2 mb-3">
                      <FileText className="w-4 h-4 text-blue-600" />
                      <h4 className="font-semibold text-slate-900">Secondary Keywords</h4>
                      <Badge variant="outline">Supporting</Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {keywordSuggestions.keywords.secondary.map((keyword, idx) => (
                        <Badge
                          key={idx}
                          variant={selectedKeywords.includes(keyword) ? 'default' : 'outline'}
                          className="cursor-pointer hover:bg-blue-100 transition-colors"
                          onClick={() => toggleKeyword(keyword)}
                        >
                          {keyword}
                          {selectedKeywords.includes(keyword) && (
                            <CheckCircle2 className="w-3 h-3 ml-1" />
                          )}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Strategic Tags */}
                  <div className="p-4 bg-white rounded-lg border border-purple-200">
                    <div className="flex items-center gap-2 mb-3">
                      <Tags className="w-4 h-4 text-purple-600" />
                      <h4 className="font-semibold text-purple-900">Strategic Tags</h4>
                      <Badge variant="outline" className="bg-purple-50 text-purple-700">
                        Categories
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {keywordSuggestions.tags.map((tag, idx) => (
                        <Badge
                          key={idx}
                          variant={selectedKeywords.includes(tag) ? 'default' : 'outline'}
                          className="cursor-pointer hover:bg-purple-100 transition-colors bg-purple-50 text-purple-700"
                          onClick={() => toggleKeyword(tag)}
                        >
                          {tag}
                          {selectedKeywords.includes(tag) && (
                            <CheckCircle2 className="w-3 h-3 ml-1" />
                          )}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Missing Opportunities */}
                  {keywordSuggestions.missing_opportunities?.length > 0 && (
                    <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
                      <div className="flex items-center gap-2 mb-3">
                        <Lightbulb className="w-4 h-4 text-amber-600" />
                        <h4 className="font-semibold text-amber-900">Missing from Your Application</h4>
                      </div>
                      <div className="space-y-2">
                        {keywordSuggestions.missing_opportunities.map((opp, idx) => (
                          <div key={idx} className="p-2 bg-white rounded border border-amber-100">
                            <div className="flex items-start gap-2">
                              <ArrowRight className="w-4 h-4 text-amber-600 mt-0.5" />
                              <div className="flex-1">
                                <p className="font-semibold text-sm text-amber-900">"{opp.keyword}"</p>
                                <p className="text-xs text-slate-600 mt-1">{opp.reason}</p>
                                {opp.suggested_usage && (
                                  <p className="text-xs text-emerald-700 mt-1 italic">
                                    💡 {opp.suggested_usage}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex gap-2">
                    <Button
                      onClick={handleApplyKeywords}
                      disabled={selectedKeywords.length === 0}
                      className="flex-1"
                      variant="default"
                    >
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Copy {selectedKeywords.length} Selected
                    </Button>
                    <Button
                      onClick={() => setSelectedKeywords(keywordSuggestions.keywords.all_unique)}
                      variant="outline"
                    >
                      Select All
                    </Button>
                  </div>

                  {selectedKeywords.length > 0 && (
                    <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                      <p className="text-xs text-slate-600 mb-2">Selected Keywords:</p>
                      <p className="text-sm font-mono text-slate-900">
                        {selectedKeywords.join(', ')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {/* Quick Tips */}
        <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex items-start gap-2">
            <Zap className="w-4 h-4 text-blue-600 mt-0.5" />
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-blue-900 mb-2">AI Writing Tips:</h4>
              <ul className="text-xs text-blue-800 space-y-1">
                <li>• <strong>Guidance:</strong> Research funder priorities, past awards, and requirements first</li>
                <li>• <strong>Generate:</strong> Creates MBA-level draft using funder research + your profile</li>
                <li>• <strong>Refine:</strong> Improves existing text for better clarity and impact</li>
                <li>• <strong>Keywords:</strong> Optimizes terminology to match funder priorities</li>
                <li>• Always review AI output - you know your work best!</li>
              </ul>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}