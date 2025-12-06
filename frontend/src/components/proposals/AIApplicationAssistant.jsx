import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Loader2, Sparkles, ChevronLeft, ChevronRight, CheckCircle2, Send, Brain, FileText, AlertTriangle } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import ReactMarkdown from 'react-markdown';
import {
  buildGrantSectionPrompt,
  getWordCount,
  getWordCountStatus,
  getWordCountMessage,
  getWordCountColorClass,
} from './aiApplicationHelpers';

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
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState('');
  const [userPrompt, setUserPrompt] = useState('');

  const { data: sections = [], isLoading } = useQuery({
    queryKey: ['proposalSections', grant.id],
    queryFn: async () => {
      const existing = await base44.entities.ProposalSection.filter({ grant_id: grant.id }, 'section_order');
      if (existing.length === 0) {
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

  const draftWordCount = useMemo(() => getWordCount(currentSection?.draft_content), [currentSection?.draft_content]);
  const suggestionWordCount = useMemo(() => getWordCount(aiSuggestion), [aiSuggestion]);

  const handleGenerateDraft = async () => {
    if (!currentSection) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'No section selected',
      });
      return;
    }

    if (!organization) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Organization data not available',
      });
      return;
    }

    setIsGenerating(true);
    setAiSuggestion('');

    try {
      const prompt = buildGrantSectionPrompt(organization, grant, currentSection, userPrompt);
      const response = await base44.integrations.Core.InvokeLLM({ 
        prompt,
        add_context_from_internet: false 
      });
      
      if (!response || response.trim() === '') {
        throw new Error('AI returned an empty or invalid response.');
      }

      setAiSuggestion(response);
      setUserPrompt('');
      
      toast({
        title: 'Draft Generated',
        description: 'Review the content below and edit as needed.',
      });
    } catch (error) {
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
    
    const savedData = {
      draft_content: aiSuggestion,
      status: 'drafting',
    };
    
    if (userPrompt.trim()) {
      savedData.ai_feedback = {
        user_prompt: userPrompt.trim(),
        generated_at: new Date().toISOString(),
      };
    }
    
    await updateSectionMutation.mutateAsync({
      id: currentSection.id,
      data: savedData,
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

  const handleSwitchToPortal = () => {
    onClose();
    toast({
      title: "Switching to Portal Assistant",
      description: "Opening the portal-based application helper..."
    });
    window.dispatchEvent(new CustomEvent('openPortalAssistant', { detail: { grant, organization } }));
  };

  const handleFinalizeApplication = async () => {
    try {
      await updateGrantMutation.mutateAsync({
        status: 'application_prep'
      });

      toast({
        title: "Application Finalized! 🎉",
        description: "Your proposal is complete and ready for final review before submission.",
      });

      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
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
            
            <ScrollArea className="flex-1">
              <CardContent className="p-4 space-y-4">
                {currentSection?.draft_content ? (
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <label className="text-sm font-semibold text-slate-700">Current Draft</label>
                        <Badge className={getWordCountColorClass(draftWordCount)}>
                          {getWordCountMessage(draftWordCount)}
                        </Badge>
                      </div>
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

                {aiSuggestion && (
                  <div className="border-t pt-4 space-y-3 bg-gradient-to-br from-purple-50 to-blue-50 p-4 rounded-lg">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <label className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-purple-600" />
                          AI Suggestion
                        </label>
                        <Badge className={getWordCountColorClass(suggestionWordCount)}>
                          {getWordCountMessage(suggestionWordCount)}
                        </Badge>
                      </div>
                      <Button size="sm" onClick={handleAcceptDraft} className="bg-purple-600 hover:bg-purple-700">
                        <Send className="w-4 h-4 mr-2" />
                        Accept & Save
                      </Button>
                    </div>
                    <div className="border rounded-lg p-4 bg-white max-h-96 overflow-y-auto">
                      <ReactMarkdown className="prose prose-sm max-w-none">
                        {aiSuggestion}
                      </ReactMarkdown>
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