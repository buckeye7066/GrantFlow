import React, { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { 
  Sparkles, 
  Loader2, 
  Download, 
  Copy, 
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  FileText,
  DollarSign,
  TrendingUp,
  Target
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import DocumentManager from '../documents/DocumentManager';

/**
 * Enhanced AI Grant Writer
 * Generates complete grant proposals with funder-specific customization
 */
export default function AIProposalWriter({ grant, organization, onContentGenerated }) {
  const [activeTab, setActiveTab] = useState('full-draft');
  const [generatingSection, setGeneratingSection] = useState(null);
  const [generatedContent, setGeneratedContent] = useState({
    full_draft: '',
    problem_statement: '',
    goals_objectives: '',
    methods_activities: '',
    evaluation_plan: '',
    sustainability_plan: '',
    budget_justification: ''
  });
  const [funderTone, setFunderTone] = useState('professional');
  const [writingStyle, setWritingStyle] = useState('outcome-focused');
  const [lengthPreference, setLengthPreference] = useState('detailed');
  const [includeDataPoints, setIncludeDataPoints] = useState(true);
  const [generationProgress, setGenerationProgress] = useState(0);

  const { toast } = useToast();

  // Fetch organization's budget items for justifications
  const { data: budgetItems = [] } = useQuery({
    queryKey: ['budgets', grant?.id],
    queryFn: () => base44.entities.Budget.filter({ grant_id: grant.id }),
    enabled: !!grant?.id
  });

  // Fetch existing AI artifacts for context
  const { data: existingArtifacts = [] } = useQuery({
    queryKey: ['aiArtifacts', grant?.id],
    queryFn: () => base44.entities.AiArtifact.filter({ grant_id: grant.id }),
    enabled: !!grant?.id
  });

  // Analyze funder's past awards for tone matching
  const analyzeFunderTone = async (funderName) => {
    try {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `Analyze the typical writing style and tone preferences for grant proposals to ${funderName}.
        
        Based on their published guidelines and typical grant-making patterns, describe:
        1. Preferred tone (formal/conversational/technical)
        2. Key language patterns
        3. Common emphasis areas (data-driven/story-driven/outcome-focused)
        4. Typical proposal structure preferences
        
        Return in this JSON format:
        {
          "tone": "professional" | "academic" | "conversational" | "technical",
          "key_phrases": ["phrase1", "phrase2"],
          "emphasis": "data-driven" | "story-driven" | "outcome-focused",
          "length_preference": "concise" | "detailed"
        }`,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          properties: {
            tone: { type: "string" },
            key_phrases: { type: "array", items: { type: "string" } },
            emphasis: { type: "string" },
            length_preference: { type: "string" }
          }
        }
      });

      return response;
    } catch (error) {
      console.error('[AIProposalWriter] Funder tone analysis failed:', error);
      return {
        tone: 'professional',
        key_phrases: [],
        emphasis: 'outcome-focused',
        length_preference: 'detailed'
      };
    }
  };

  // Generate complete proposal draft
  const generateFullDraft = async () => {
    setGeneratingSection('full-draft');
    setGenerationProgress(0);

    try {
      // Step 1: Analyze funder tone (20%)
      setGenerationProgress(20);
      const toneAnalysis = await analyzeFunderTone(grant.funder);
      setFunderTone(toneAnalysis.tone);

      // Step 2: Gather all context (40%)
      setGenerationProgress(40);
      const context = {
        grant: {
          title: grant.title,
          funder: grant.funder,
          deadline: grant.deadline,
          award_range: `$${grant.award_floor || 0} - $${grant.award_ceiling || 0}`,
          description: grant.program_description,
          eligibility: grant.eligibility_summary,
          selection_criteria: grant.selection_criteria
        },
        organization: {
          name: organization.name,
          mission: organization.mission,
          annual_budget: organization.annual_budget,
          staff_count: organization.staff_count,
          focus_areas: organization.focus_areas,
          target_population: organization.target_population,
          past_experience: organization.past_experience
        },
        funder_preferences: toneAnalysis
      };

      // Step 3: Generate comprehensive proposal (100%)
      setGenerationProgress(60);
      
      const prompt = `You are an expert grant writer creating a complete, compelling grant proposal.

GRANT INFORMATION:
${JSON.stringify(context.grant, null, 2)}

ORGANIZATION INFORMATION:
${JSON.stringify(context.organization, null, 2)}

WRITING PREFERENCES (User Selected):
- Tone: ${funderTone}
- Style/Emphasis: ${writingStyle}
- Length: ${lengthPreference}

FUNDER ANALYSIS:
${toneAnalysis.key_phrases.length > 0 ? `- Key phrases to incorporate: ${toneAnalysis.key_phrases.join(', ')}` : ''}

Generate a COMPLETE grant proposal including:

1. EXECUTIVE SUMMARY (2-3 paragraphs)
   - Concise overview of project and impact
   
2. STATEMENT OF NEED / PROBLEM STATEMENT (3-4 paragraphs)
   - Clear articulation of the problem
   - Data and statistics demonstrating need
   - Why this problem matters now
   
3. PROJECT GOALS & OBJECTIVES (4-6 SMART goals)
   - Specific, measurable, achievable goals
   - Aligned with funder priorities
   
4. METHODS & ACTIVITIES (4-5 paragraphs)
   - Detailed description of approach
   - Timeline and phases
   - Roles and responsibilities
   
5. EVALUATION PLAN (2-3 paragraphs)
   - How success will be measured
   - Specific metrics and indicators
   - Reporting methodology
   
6. ORGANIZATIONAL CAPACITY (2 paragraphs)
   - Relevant experience and qualifications
   - Resources and infrastructure
   
7. SUSTAINABILITY PLAN (2 paragraphs)
   - How project continues after funding ends
   - Long-term funding strategies

WRITING INSTRUCTIONS:
- Use ${funderTone} tone throughout
- ${writingStyle === 'data-driven' ? 'Include specific statistics, percentages, and data points to support every claim.' : 
   writingStyle === 'story-driven' ? 'Include compelling narratives, real examples, and human stories that illustrate the need and impact.' : 
   writingStyle === 'outcome-focused' ? 'Focus heavily on measurable outcomes, expected results, and tangible impact metrics.' :
   writingStyle === 'need-focused' ? 'Emphasize the urgent need, the gap being addressed, and why intervention is critical now.' :
   'Highlight innovative approaches, unique solutions, and what makes this project different.'}
- Length: ${lengthPreference === 'concise' ? 'Be brief and to the point - prioritize clarity over detail.' :
   lengthPreference === 'moderate' ? 'Balance detail with readability - include key points without overwhelming.' :
   lengthPreference === 'detailed' ? 'Provide thorough explanations with supporting details and examples.' :
   'Be comprehensive - leave no important detail unaddressed.'}

CRITICAL QUALITY STANDARDS:
- Write at MBA-level analytical sophistication - strategic, evidence-based, stakeholder-aware
- Use first-person voice throughout ("We will...", "Our organization...")
- Mirror the FUNDER'S EXACT LANGUAGE and terminology from their guidelines
- Ground every claim in authoritative data: cite sources, research, assessments
- Quantify everything possible: numbers, percentages, timeframes, populations served
- Show theory of change: how activities create logical pathway to outcomes
- Address "so what?" for every claim - why does this matter to the funder?
- Demonstrate intimate knowledge of the affected population and their lived experience
- Use the applicant's keywords and focus areas as strategic themes throughout

Make it compelling and tailored to ${context.grant.funder}'s priorities.`;

      const fullDraft = await base44.integrations.Core.InvokeLLM({
        prompt,
        add_context_from_internet: includeDataPoints
      });

      setGenerationProgress(90);

      // Step 4: Save as artifact
      await base44.entities.AiArtifact.create({
        grant_id: grant.id,
        kind: 'proposal_section',
        content: fullDraft,
        sources: ['grant_data', 'organization_profile', 'funder_analysis'],
        confidence: 0.85
      });

      setGeneratedContent(prev => ({ ...prev, full_draft: fullDraft }));
      setGenerationProgress(100);

      toast({
        title: '✅ Proposal Generated',
        description: `Complete ${toneAnalysis.tone} proposal tailored to ${grant.funder}`,
      });

      if (onContentGenerated) {
        onContentGenerated({ section: 'full_draft', content: fullDraft });
      }

    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message || 'Failed to generate proposal',
      });
    } finally {
      setGeneratingSection(null);
      setGenerationProgress(0);
    }
  };

  // Generate budget justifications
  const generateBudgetJustifications = async () => {
    setGeneratingSection('budget-justification');
    
    try {
      if (budgetItems.length === 0) {
        toast({
          variant: 'destructive',
          title: 'No Budget Items',
          description: 'Please add budget items before generating justifications',
        });
        return;
      }

      // Group budget by category
      const budgetByCategory = budgetItems.reduce((acc, item) => {
        if (!acc[item.category]) {
          acc[item.category] = [];
        }
        acc[item.category].push(item);
        return acc;
      }, {});

      const budgetSummary = Object.entries(budgetByCategory).map(([category, items]) => ({
        category,
        items: items.map(i => ({
          description: i.line_item,
          amount: i.total,
          quantity: i.quantity,
          unit_cost: i.unit_cost
        })),
        total: items.reduce((sum, i) => sum + (i.total || 0), 0)
      }));

      const prompt = `You are an expert grant budget writer. Create compelling, detailed budget justifications.

PROJECT: ${grant.title}
ORGANIZATION: ${organization.name}
FUNDER: ${grant.funder}

BUDGET BREAKDOWN:
${JSON.stringify(budgetSummary, null, 2)}

For each budget category, write a clear, persuasive justification that:
1. Explains WHY each expense is necessary for project success
2. Shows HOW costs were calculated (methodology)
3. Demonstrates REASONABLENESS (market rates, quotes)
4. Connects expenses to specific project activities and outcomes
5. Addresses potential funder concerns proactively

Format as:

[CATEGORY NAME]
[2-3 paragraph justification with specific details and rationale]

Total: $[amount]

Make justifications compelling and demonstrate fiscal responsibility while showing all costs are essential.`;

      const justifications = await base44.integrations.Core.InvokeLLM({
        prompt,
        add_context_from_internet: false
      });

      // Save as artifact
      await base44.entities.AiArtifact.create({
        grant_id: grant.id,
        kind: 'proposal_section',
        content: justifications,
        sources: ['budget_data', 'project_description'],
        confidence: 0.90
      });

      setGeneratedContent(prev => ({ ...prev, budget_justification: justifications }));

      toast({
        title: '✅ Budget Justifications Generated',
        description: 'Detailed rationale for all budget categories',
      });

    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message,
      });
    } finally {
      setGeneratingSection(null);
    }
  };

  // Generate sustainability plan
  const generateSustainabilityPlan = async () => {
    setGeneratingSection('sustainability');
    
    try {
      const prompt = `Create a comprehensive sustainability plan for this grant project.

PROJECT: ${grant.title}
ORGANIZATION: ${organization.name}
AWARD AMOUNT: $${grant.award_ceiling || 'TBD'}
PROJECT FOCUS: ${organization.focus_areas?.join(', ') || 'Community impact'}

Create a detailed sustainability plan that addresses:

1. DIVERSIFIED FUNDING STRATEGY (2 paragraphs)
   - Multiple revenue streams (grants, earned income, donations)
   - Specific potential funders and amounts
   - Timeline for securing additional funding

2. ORGANIZATIONAL CAPACITY BUILDING (1 paragraph)
   - Infrastructure and systems that outlast the grant
   - Staff development and knowledge transfer
   - Community partnerships and buy-in

3. PROGRAM INTEGRATION (1 paragraph)
   - How project becomes part of core operations
   - Efficiency gains and cost reductions over time
   - Scalability and replication potential

4. COMMUNITY OWNERSHIP (1 paragraph)
   - How community stakeholders take ownership
   - Volunteer and in-kind support mobilization
   - Local champion development

5. MEASURABLE OUTCOMES (1 paragraph)
   - How demonstrated impact attracts future funding
   - Data systems for ongoing evaluation
   - Success stories and case studies

Make it realistic, specific, and compelling. Show funders their investment will have lasting impact beyond the grant period.`;

      const sustainabilityPlan = await base44.integrations.Core.InvokeLLM({
        prompt,
        add_context_from_internet: false
      });

      // Save as artifact
      await base44.entities.AiArtifact.create({
        grant_id: grant.id,
        kind: 'proposal_section',
        content: sustainabilityPlan,
        sources: ['organization_profile', 'grant_data'],
        confidence: 0.85
      });

      setGeneratedContent(prev => ({ ...prev, sustainability_plan: sustainabilityPlan }));

      toast({
        title: '✅ Sustainability Plan Generated',
        description: 'Comprehensive long-term strategy created',
      });

    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message,
      });
    } finally {
      setGeneratingSection(null);
    }
  };

  // Generate individual section
  const generateSection = async (sectionType) => {
    setGeneratingSection(sectionType);
    
    try {
      let prompt = '';
      
      switch (sectionType) {
        case 'problem_statement':
          prompt = `Write a compelling Statement of Need / Problem Statement for this grant proposal.

PROJECT: ${grant.title}
FUNDER: ${grant.funder}
ORGANIZATION: ${organization.name}
TARGET POPULATION: ${organization.target_population || 'Community members'}

Write 3-4 paragraphs that:
1. Clearly identify and define the problem
2. Include relevant statistics and data
3. Explain local context and why this matters
4. Create urgency without being alarmist
5. Connect to funder's priorities

WRITING INSTRUCTIONS:
- Use ${funderTone} tone
- Style: ${writingStyle === 'data-driven' ? 'Lead with statistics and data' : writingStyle === 'story-driven' ? 'Include compelling narratives' : 'Focus on outcomes and impact'}
- Length: ${lengthPreference}

QUALITY STANDARD: Write at MBA-level analytical sophistication. Use first-person voice. Ground claims in evidence. Mirror funder's language. Be specific, factual, and compelling.`;
          break;

        case 'goals_objectives':
          prompt = `Create 4-6 SMART goals/objectives for this project.

PROJECT: ${grant.title}
PROBLEM CONTEXT: ${grant.program_description || 'See grant description'}

Each goal should be:
- Specific (what exactly will be accomplished)
- Measurable (how you'll track progress)
- Achievable (realistic given resources)
- Relevant (connected to the problem)
- Time-bound (specific timeframe)

Format as numbered list with clear, action-oriented language.`;
          break;

        case 'methods_activities':
          prompt = `Describe the project methods, activities, and approach.

PROJECT: ${grant.title}
GOALS: [Reference the project goals]
ORGANIZATION: ${organization.name}

Write 4-5 paragraphs covering:
1. Overall approach and strategy
2. Specific activities and interventions
3. Timeline and phases
4. Roles and responsibilities
5. How activities lead to stated goals

WRITING INSTRUCTIONS:
- Use ${funderTone} tone
- Style: ${writingStyle}
- Length: ${lengthPreference}

QUALITY STANDARD: Write at MBA-level analytical sophistication. Use first-person voice. Ground claims in evidence. Mirror funder's language. Be concrete and actionable.`;
          break;

        case 'evaluation_plan':
          prompt = `Create a comprehensive evaluation plan.

PROJECT: ${grant.title}
GOALS: [Reference project goals]

Write 2-3 paragraphs covering:
1. Evaluation methodology (formative and summative)
2. Specific metrics and data collection methods
3. How data will be analyzed and reported
4. Timeline for evaluation activities
5. How findings will inform continuous improvement

Be specific about metrics and demonstrate rigor.`;
          break;
      }

      const content = await base44.integrations.Core.InvokeLLM({
        prompt,
        add_context_from_internet: includeDataPoints
      });

      setGeneratedContent(prev => ({ ...prev, [sectionType]: content }));

      toast({
        title: '✅ Section Generated',
        description: `${sectionType.replace('_', ' ')} created`,
      });

    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message,
      });
    } finally {
      setGeneratingSection(null);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast({
      title: '📋 Copied',
      description: 'Content copied to clipboard',
    });
  };

  const downloadAsDoc = (content, filename) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-600" />
            AI Grant Writer
          </h2>
          <p className="text-slate-600 mt-1">
            Generate complete, funder-tailored grant proposals with AI assistance
          </p>
        </div>
      </div>

      {/* Funder Analysis Card */}
      <Card className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="w-5 h-5 text-purple-600" />
            AI Generation Settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <Label className="text-sm font-medium">Writing Tone</Label>
              <Select value={funderTone} onValueChange={setFunderTone}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="academic">Academic/Technical</SelectItem>
                  <SelectItem value="conversational">Conversational</SelectItem>
                  <SelectItem value="formal">Formal/Government</SelectItem>
                  <SelectItem value="compassionate">Compassionate/Human</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500 mt-1">
                Match funder's communication style
              </p>
            </div>
            
            <div>
              <Label className="text-sm font-medium">Writing Style</Label>
              <Select value={writingStyle} onValueChange={setWritingStyle}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="data-driven">Data-Driven</SelectItem>
                  <SelectItem value="story-driven">Story-Driven</SelectItem>
                  <SelectItem value="outcome-focused">Outcome-Focused</SelectItem>
                  <SelectItem value="need-focused">Need-Focused</SelectItem>
                  <SelectItem value="innovation-focused">Innovation-Focused</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500 mt-1">
                Emphasis and approach
              </p>
            </div>
            
            <div>
              <Label className="text-sm font-medium">Length Preference</Label>
              <Select value={lengthPreference} onValueChange={setLengthPreference}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="concise">Concise (shorter)</SelectItem>
                  <SelectItem value="moderate">Moderate</SelectItem>
                  <SelectItem value="detailed">Detailed (thorough)</SelectItem>
                  <SelectItem value="comprehensive">Comprehensive (max)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500 mt-1">
                How much detail to include
              </p>
            </div>
            
            <div>
              <Label className="text-sm font-medium">Research Options</Label>
              <div className="flex items-center gap-2 mt-3">
                <input
                  type="checkbox"
                  checked={includeDataPoints}
                  onChange={(e) => setIncludeDataPoints(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm text-slate-700">
                  Include real statistics
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Search web for data points
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* NEW: Quick Document Access */}
      <DocumentManager
        organizationId={organization.id}
        grantId={grant.id}
        mode="compact"
      />

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="full-draft" className="gap-2">
            <FileText className="w-4 h-4" />
            Full Draft
          </TabsTrigger>
          <TabsTrigger value="sections" className="gap-2">
            <Target className="w-4 h-4" />
            Sections
          </TabsTrigger>
          <TabsTrigger value="budget" className="gap-2">
            <DollarSign className="w-4 h-4" />
            Budget
          </TabsTrigger>
          <TabsTrigger value="sustainability" className="gap-2">
            <TrendingUp className="w-4 h-4" />
            Sustainability
          </TabsTrigger>
          <TabsTrigger value="documents" className="gap-2">
            <FileText className="w-4 h-4" />
            Documents
          </TabsTrigger>
        </TabsList>

        {/* Full Draft Tab */}
        <TabsContent value="full-draft">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Complete Proposal Draft</CardTitle>
                <Button
                  onClick={generateFullDraft}
                  disabled={generatingSection === 'full-draft'}
                  className="bg-gradient-to-r from-purple-600 to-blue-600"
                >
                  {generatingSection === 'full-draft' ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Generate Full Proposal
                    </>
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {generatingSection === 'full-draft' && (
                <div className="space-y-2">
                  <Progress value={generationProgress} className="h-2" />
                  <p className="text-sm text-slate-600 text-center">
                    {generationProgress < 40 ? 'Analyzing funder preferences...' :
                     generationProgress < 60 ? 'Gathering context and data...' :
                     generationProgress < 90 ? 'Generating proposal...' :
                     'Finalizing and saving...'}
                  </p>
                </div>
              )}

              {generatedContent.full_draft ? (
                <>
                  <Alert className="bg-green-50 border-green-200">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertDescription className="text-green-900">
                      <strong>Proposal Generated!</strong> Review, edit, and customize as needed.
                    </AlertDescription>
                  </Alert>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(generatedContent.full_draft)}
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      Copy
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadAsDoc(generatedContent.full_draft, `proposal-${grant.title}`)}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={generateFullDraft}
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Regenerate
                    </Button>
                  </div>

                  <Textarea
                    value={generatedContent.full_draft}
                    onChange={(e) => setGeneratedContent(prev => ({ ...prev, full_draft: e.target.value }))}
                    rows={25}
                    className="font-mono text-sm"
                  />
                </>
              ) : (
                <div className="text-center py-12 border-2 border-dashed border-slate-300 rounded-lg">
                  <Sparkles className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                  <p className="text-slate-600 mb-4">
                    Click "Generate Full Proposal" to create a complete, tailored grant proposal
                  </p>
                  <p className="text-sm text-slate-500">
                    Includes all sections from executive summary to sustainability plan
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Individual Sections Tab */}
        <TabsContent value="sections">
          <div className="grid gap-4">
            {[
              { key: 'problem_statement', label: 'Problem Statement', icon: AlertCircle },
              { key: 'goals_objectives', label: 'Goals & Objectives', icon: Target },
              { key: 'methods_activities', label: 'Methods & Activities', icon: FileText },
              { key: 'evaluation_plan', label: 'Evaluation Plan', icon: CheckCircle2 }
            ].map((section) => (
              <Card key={section.key}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <section.icon className="w-5 h-5" />
                      {section.label}
                    </CardTitle>
                    <Button
                      onClick={() => generateSection(section.key)}
                      disabled={generatingSection === section.key}
                      size="sm"
                    >
                      {generatingSection === section.key ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4 mr-2" />
                          Generate
                        </>
                      )}
                    </Button>
                  </div>
                </CardHeader>
                {generatedContent[section.key] && (
                  <CardContent>
                    <div className="flex gap-2 mb-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(generatedContent[section.key])}
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        Copy
                      </Button>
                    </div>
                    <Textarea
                      value={generatedContent[section.key]}
                      onChange={(e) => setGeneratedContent(prev => ({ 
                        ...prev, 
                        [section.key]: e.target.value 
                      }))}
                      rows={8}
                      className="text-sm"
                    />
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Budget Justifications Tab */}
        <TabsContent value="budget">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Budget Justifications</CardTitle>
                  <p className="text-sm text-slate-600 mt-1">
                    Detailed rationale for all budget line items
                  </p>
                </div>
                <Button
                  onClick={generateBudgetJustifications}
                  disabled={generatingSection === 'budget-justification'}
                  className="bg-gradient-to-r from-green-600 to-emerald-600"
                >
                  {generatingSection === 'budget-justification' ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <DollarSign className="w-4 h-4 mr-2" />
                      Generate Justifications
                    </>
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {budgetItems.length === 0 && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    No budget items found. Add budget items in the Budget tab first.
                  </AlertDescription>
                </Alert>
              )}

              {generatedContent.budget_justification ? (
                <>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(generatedContent.budget_justification)}
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      Copy
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadAsDoc(generatedContent.budget_justification, 'budget-justification')}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                  </div>

                  <Textarea
                    value={generatedContent.budget_justification}
                    onChange={(e) => setGeneratedContent(prev => ({ 
                      ...prev, 
                      budget_justification: e.target.value 
                    }))}
                    rows={20}
                    className="text-sm"
                  />
                </>
              ) : budgetItems.length > 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-slate-300 rounded-lg">
                  <DollarSign className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                  <p className="text-slate-600 mb-2">
                    Generate detailed justifications for your {budgetItems.length} budget items
                  </p>
                  <p className="text-sm text-slate-500">
                    AI will create compelling rationale for each expense category
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Sustainability Tab */}
        <TabsContent value="sustainability">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Sustainability Plan</CardTitle>
                  <p className="text-sm text-slate-600 mt-1">
                    Long-term strategy beyond grant funding
                  </p>
                </div>
                <Button
                  onClick={generateSustainabilityPlan}
                  disabled={generatingSection === 'sustainability'}
                  className="bg-gradient-to-r from-blue-600 to-cyan-600"
                >
                  {generatingSection === 'sustainability' ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <TrendingUp className="w-4 h-4 mr-2" />
                      Generate Plan
                    </>
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {generatedContent.sustainability_plan ? (
                <>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(generatedContent.sustainability_plan)}
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      Copy
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadAsDoc(generatedContent.sustainability_plan, 'sustainability-plan')}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                  </div>

                  <Textarea
                    value={generatedContent.sustainability_plan}
                    onChange={(e) => setGeneratedContent(prev => ({ 
                      ...prev, 
                      sustainability_plan: e.target.value 
                    }))}
                    rows={20}
                    className="text-sm"
                  />
                </>
              ) : (
                <div className="text-center py-12 border-2 border-dashed border-slate-300 rounded-lg">
                  <TrendingUp className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                  <p className="text-slate-600 mb-2">
                    Create a comprehensive sustainability plan
                  </p>
                  <p className="text-sm text-slate-500">
                    Shows funders how your project will continue beyond their investment
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* NEW: Documents Tab */}
        <TabsContent value="documents">
          <DocumentManager
            organizationId={organization.id}
            grantId={grant.id}
            mode="suggestions"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}