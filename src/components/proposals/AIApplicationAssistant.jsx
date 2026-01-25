
import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Loader2, Sparkles, ChevronLeft, ChevronRight, CheckCircle2, Send, Brain, FileText } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import ReactMarkdown from 'react-markdown';
import { createLogger } from '@/utils/logger';

const DEFAULT_SECTIONS = [
  { name: 'Executive Summary', order: 1, requirements: 'Brief overview of the project and its impact' },
  { name: 'Need Statement', order: 2, requirements: 'Demonstrate the problem and why it matters' },
  { name: 'Project Design', order: 3, requirements: 'Describe what you will do and how' },
  { name: 'Evaluation Plan', order: 4, requirements: 'How you will measure success' },
  { name: 'Budget Narrative', order: 5, requirements: 'Justify the budget line items' },
];

export default function AIApplicationAssistant({ open, onClose, grant, organization }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const log = React.useMemo(() => createLogger('AIApplicationAssistant'), []);
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState('');
  const [userPrompt, setUserPrompt] = useState('');

  // Fetch or create proposal sections
  const { data: sections = [], isLoading } = useQuery({
    queryKey: ['proposalSections', grant.id],
    queryFn: async () => {
      const existing = await base44.entities.ProposalSection.filter({ grant_id: grant.id }, 'section_order');
      if (existing.length === 0) {
        // Create default sections
        const created = await base44.entities.ProposalSection.bulkCreate(
          DEFAULT_SECTIONS.map(s => ({
            grant_id: grant.id,
            section_name: s.name,
            section_order: s.order,
            requirements: s.requirements,
            draft_content: '',
            status: 'not_started'
          }))
        );
        return created.sort((a, b) => a.section_order - b.section_order);
      }
      return existing;
    },
    enabled: open && !!grant && !!organization,
  });

  const updateSectionMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.ProposalSection.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proposalSections', grant.id] });
    },
  });

  const updateGrantMutation = useMutation({
    mutationFn: (data) => base44.entities.Grant.update(grant.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grant', grant.id] });
      queryClient.invalidateQueries({ queryKey: ['grants'] });
    },
  });

  const currentSection = sections[currentSectionIndex];
  const progress = sections.length > 0 ? (sections.filter(s => s.status === 'approved').length / sections.length) * 100 : 0;

  const handleGenerateDraft = async () => {
    log.debug('generate clicked', {
      section: currentSection?.section_name,
      organization: organization?.name,
      grant: grant?.title,
    });
    
    if (!currentSection) {
      console.error('[AIAssistant] No current section');
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'No section selected',
      });
      return;
    }

    if (!organization) {
      console.error('[AIAssistant] No organization data');
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Organization data not available',
      });
      return;
    }

    setIsGenerating(true);
    setAiSuggestion('');
    
    log.debug('starting generation');

    try {
      // Determine if this is an individual or organization
      const isIndividual = ['high_school_student', 'college_student', 'graduate_student', 'individual_need', 'medical_assistance', 'family', 'other'].includes(organization.applicant_type);
      
      const voiceGuidance = isIndividual 
        ? 'Write in FIRST PERSON SINGULAR (I, my, me, mine). This is an individual applicant writing about themselves.'
        : 'Write in FIRST PERSON PLURAL (we, our, us, ours). This is an organization.';

      // Build context from organization profile
      const profileContext = Object.entries(organization)
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

      log.debug('profile context length', { length: profileContext.length });

      const grantContext = `
Grant Title: ${grant.title}
Funder: ${grant.funder}
Award Amount: ${grant.award_ceiling ? `$${grant.award_ceiling.toLocaleString()}` : grant.award_floor ? `$${grant.award_floor.toLocaleString()}` : 'Not specified'}
Program Description: ${grant.program_description || 'N/A'}
Eligibility: ${grant.eligibility_summary || 'N/A'}
Selection Criteria: ${grant.selection_criteria || 'N/A'}
      `.trim();

      log.debug('grant context length', { length: grantContext.length });

      const existingContent = currentSection.draft_content || '';
      const userGuidance = userPrompt.trim();

      const prompt = `You are an expert grant writer. Write a clear, professional "${currentSection.section_name}" section that directly addresses the funder's priorities while demonstrating genuine capability.

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

      log.debug('calling AI');

      const response = await base44.integrations.Core.InvokeLLM({ 
        prompt,
        add_context_from_internet: false 
      });
      
      log.debug('AI response received', { length: response?.length ?? null });
      
      if (!response || response.trim() === '') {
        throw new Error('AI returned an empty or invalid response.');
      }

      setAiSuggestion(response);
      setUserPrompt('');
      
      toast({
        title: 'Draft Generated',
        description: 'Review the content below and edit as needed.',
      });
      
      log.debug('generation complete');
    } catch (error) {
      console.error('[AIAssistant] Generation failed:', error);
      console.error('[AIAssistant] Error details:', {
        message: error.message,
        stack: error.stack,
        response: error.response?.data
      });
      
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message || 'Could not generate draft. Please try again.',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAcceptDraft = async () => {
    if (!aiSuggestion || !currentSection) return;
    await updateSectionMutation.mutateAsync({
      id: currentSection.id,
      data: {
        draft_content: aiSuggestion,
        status: 'drafting',
      },
    });
    setAiSuggestion('');
    toast({ title: 'Draft Saved', description: 'Section content has been saved.' });
  };

  const handleApproveSection = async () => {
    if (!currentSection) return;
    await updateSectionMutation.mutateAsync({
      id: currentSection.id,
      data: { status: 'approved' },
    });
    toast({ title: 'Section Approved', description: `"${currentSection.section_name}" is complete!` });
    if (currentSectionIndex < sections.length - 1) {
      setCurrentSectionIndex(currentSectionIndex + 1);
    }
  };

  const handleEditContent = (newContent) => {
    if (!currentSection) return;
    updateSectionMutation.mutate({
      id: currentSection.id,
      data: { draft_content: newContent },
    });
  };

  // NEW: Handler to switch to portal assistant
  const handleSwitchToPortal = () => {
    onClose();
    toast({
      title: "Switching to Portal Assistant",
      description: "Opening the portal-based application helper..."
    });
    // Trigger parent to open portal assistant
    window.dispatchEvent(new CustomEvent('openPortalAssistant', { detail: { grant, organization } }));
  };

  const handleFinalizeApplication = async () => {
    log.debug('finalizing application');
    
    try {
      // Update grant status to application_prep (ready for submission)
      await updateGrantMutation.mutateAsync({
        status: 'application_prep'
      });

      toast({
        title: "Application Finalized! 🎉",
        description: "Your proposal is complete and ready for final review before submission.",
      });

      // Close the assistant after a brief delay
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
      console.error('[AIAssistant] Failed to finalize:', error);
      toast({
        variant: "destructive",
        title: "Finalization Failed",
        description: error.message || "Could not finalize application."
      });
    }
  };

  if (isLoading) {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-6xl h-[90vh]">
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Check if this appears to be a portal-based application
  const isPortalBased = grant.opportunity_type === 'scholarship' ||
                        grant.url?.includes('portal') ||
                        grant.url?.includes('apply') ||
                        grant.funder?.toLowerCase().includes('university') ||
                        grant.funder?.toLowerCase().includes('college');

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl h-[90vh] flex flex-col p-0">
        <DialogHeader className="p-6 border-b flex-shrink-0">
          <DialogTitle className="flex items-center gap-3 text-2xl">
            <Brain className="w-7 h-7 text-purple-600" />
            AI Application Assistant
            <span className="text-base font-normal text-slate-500">for {grant.title}</span>
          </DialogTitle>
          <div className="mt-4">
            <div className="flex justify-between text-sm text-slate-600 mb-2">
              <span>Progress</span>
              <span>{Math.round(progress)}% Complete</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>

          {/* NEW: Portal option banner */}
          {isPortalBased && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <h4 className="font-semibold text-blue-900 mb-1">Apply Through Portal?</h4>
                  <p className="text-sm text-blue-800">
                    This appears to be a portal-based application. You can switch to the Portal Assistant to help you fill out the online form instead of building a full proposal.
                  </p>
                </div>
                <Button
                  onClick={handleSwitchToPortal}
                  variant="outline"
                  className="bg-white border-blue-300 text-blue-700 hover:bg-blue-100"
                >
                  Switch to Portal Mode
                </Button>
              </div>
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-hidden grid grid-cols-3 gap-4 p-6">
          {/* Left: Section Navigator - FIXED */}
          <Card className="col-span-1 flex flex-col overflow-hidden">
            <CardHeader className="pb-3 flex-shrink-0">
              <CardTitle className="text-base">Proposal Sections</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0">
              <ScrollArea className="h-full">
                <div className="p-4 space-y-2">
                  {sections.map((section, index) => (
                    <button
                      key={section.id}
                      onClick={() => setCurrentSectionIndex(index)}
                      className={`w-full text-left p-3 rounded-lg border transition-all ${
                        index === currentSectionIndex
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-slate-200 hover:border-blue-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">{section.section_name}</span>
                        {section.status === 'approved' && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
                      </div>
                      <p className="text-xs text-slate-500 mt-1">{section.requirements}</p>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Middle: Content Editor - FIXED SCROLLING */}
          <Card className="col-span-2 flex flex-col overflow-hidden">
            <CardHeader className="pb-3 border-b flex-shrink-0">
              <CardTitle className="flex items-center justify-between">
                <span>{currentSection?.section_name}</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentSectionIndex(Math.max(0, currentSectionIndex - 1))}
                    disabled={currentSectionIndex === 0}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentSectionIndex(Math.min(sections.length - 1, currentSectionIndex + 1))}
                    disabled={currentSectionIndex === sections.length - 1}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </CardTitle>
            </CardHeader>
            
            {/* FIXED: Make entire content area scrollable */}
            <ScrollArea className="flex-1">
              <CardContent className="p-4 space-y-4">
                {currentSection?.draft_content ? (
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-semibold text-slate-700">Current Draft</label>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleGenerateDraft}
                          disabled={isGenerating}
                          className="text-purple-600 border-purple-600 hover:bg-purple-50"
                        >
                          {isGenerating ? (
                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</>
                          ) : (
                            <><Sparkles className="w-4 h-4 mr-2" />Regenerate with AI</>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleApproveSection}
                          className="text-emerald-600 border-emerald-600 hover:bg-emerald-50"
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2" />
                          Approve Section
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      value={currentSection.draft_content}
                      onChange={(e) => handleEditContent(e.target.value)}
                      className="min-h-[300px] font-mono text-sm"
                      placeholder="No content yet. Generate a draft below."
                    />
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-center p-8 border-2 border-dashed rounded-lg min-h-[300px]">
                    <FileText className="w-12 h-12 mx-auto text-slate-300 mb-3" />
                    <p className="text-slate-600 font-medium mb-2">No content yet</p>
                    <p className="text-sm text-slate-500 mb-4">Use AI to generate a draft for this section</p>
                    <Button
                      onClick={handleGenerateDraft}
                      disabled={isGenerating}
                      className="bg-purple-600 hover:bg-purple-700"
                    >
                      {isGenerating ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</>
                      ) : (
                        <><Sparkles className="w-4 h-4 mr-2" />Generate with AI</>
                      )}
                    </Button>
                  </div>
                )}

                {/* AI Suggestion Section - Now always visible when present */}
                {aiSuggestion && (
                  <div className="border-t pt-4 space-y-3 bg-gradient-to-br from-purple-50 to-blue-50 p-4 rounded-lg">
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-purple-600" />
                        AI Suggestion
                      </label>
                      <Button size="sm" onClick={handleAcceptDraft} className="bg-purple-600 hover:bg-purple-700">
                        <Send className="w-4 h-4 mr-2" />
                        Accept & Save
                      </Button>
                    </div>
                    <div className="border rounded-lg p-4 bg-white max-h-96 overflow-y-auto">
                      <div className="prose prose-sm max-w-none whitespace-pre-wrap">
                        {aiSuggestion}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </ScrollArea>
          </Card>
        </div>

        <div className="border-t p-4 flex justify-end gap-3 flex-shrink-0">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {progress === 100 && (
            <Button 
              onClick={handleFinalizeApplication}
              disabled={updateGrantMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {updateGrantMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Finalizing...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Finalize Application
                </>
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
