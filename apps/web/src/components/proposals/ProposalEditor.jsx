import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Sparkles, Plus, FileText, Send, CheckCircle, AlertTriangle } from 'lucide-react';
import CoachFeedback from './CoachFeedback';
import SubmissionAssistant from './SubmissionAssistant';
import { useDebounce } from '../hooks/useDebounce';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import ScoringResultCard from '../scoring/ScoringResultCard';
import {
  buildCoachFeedbackPrompt,
  buildScoringPrompt,
  buildImprovementPrompt,
  COACH_FEEDBACK_SCHEMA,
  SCORING_SCHEMA,
  IMPROVEMENT_SCHEMA,
  DEFAULT_WORD_COUNT_THRESHOLD,
} from './proposalHelpers';

export default function ProposalEditor({ grant, organization, wordCountThreshold = DEFAULT_WORD_COUNT_THRESHOLD }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activeSectionId, setActiveSectionId] = useState(null);
  const [newSectionName, setNewSectionName] = useState('');
  const [isCoachLoading, setIsCoachLoading] = useState(false);
  const [showSubmitDialog, setShowSubmitDialog] = useState(false);
  const [isFinalReviewing, setIsFinalReviewing] = useState(false);
  const [finalReviewFeedback, setFinalReviewFeedback] = useState(null);
  const [showSubmissionAssistant, setShowSubmissionAssistant] = useState(false);
  const [improvingItemId, setImprovingItemId] = useState(null);
  const [improvedItems, setImprovedItems] = useState([]);
  
  const { data: sections = [], isLoading: isLoadingSections } = useQuery({
    queryKey: ['proposalSections', grant.id],
    queryFn: () => base44.entities.ProposalSection.filter({ grant_id: grant.id }, 'section_order'),
    enabled: !!grant.id,
  });

  const activeSection = sections.find(s => s.id === activeSectionId);
  const [draftContent, setDraftContent] = useState('');
  const debouncedDraftContent = useDebounce(draftContent, 1000);

  const existingSectionNames = useMemo(() => {
    return new Set(sections.map(s => s.section_name.toLowerCase().trim()));
  }, [sections]);

  const coachPrompt = useMemo(() => {
    if (!activeSection || !grant || !organization) return '';
    return buildCoachFeedbackPrompt(grant, organization, activeSection, draftContent);
  }, [grant, organization, activeSection, draftContent]);

  const allContent = useMemo(() => {
    return sections.map(s => `## ${s.section_name}\n${s.draft_content}`).join('\n\n');
  }, [sections]);

  const scoringPrompt = useMemo(() => {
    if (!grant) return '';
    return buildScoringPrompt(grant, allContent);
  }, [grant, allContent]);

  useEffect(() => {
    if (!activeSectionId && sections.length > 0) {
      setActiveSectionId(sections[0].id);
    }
  }, [sections, activeSectionId]);

  useEffect(() => {
    setDraftContent(activeSection?.draft_content || '');
    setFinalReviewFeedback(null);
  }, [activeSection]);

  const updateSectionContentMutation = useMutation({
    mutationFn: ({ id, content }) => base44.entities.ProposalSection.update(id, { draft_content: content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proposalSections', grant.id] });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to save content",
        description: error.message || "Could not save your changes."
      });
    }
  });

  const updateSectionFeedbackMutation = useMutation({
    mutationFn: ({ id, feedback }) => base44.entities.ProposalSection.update(id, { ai_feedback: feedback }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proposalSections', grant.id] });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to save feedback",
        description: error.message || "Could not save AI feedback."
      });
    }
  });

  useEffect(() => {
    if (activeSection && debouncedDraftContent !== activeSection.draft_content) {
      updateSectionContentMutation.mutate({ id: activeSection.id, content: debouncedDraftContent });
    }
  }, [debouncedDraftContent, activeSection]);

  const createSectionMutation = useMutation({
    mutationFn: (sectionData) => base44.entities.ProposalSection.create(sectionData),
    onSuccess: (newSection) => {
      queryClient.invalidateQueries({ queryKey: ['proposalSections', grant.id] });
      setNewSectionName('');
      setActiveSectionId(newSection.id);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to create section",
        description: error.message || "Could not create a new section."
      });
    }
  });

  const handleAddSection = (e) => {
    e.preventDefault();
    const trimmed = newSectionName.trim();
    if (!trimmed) return;

    if (existingSectionNames.has(trimmed.toLowerCase())) {
      toast({
        variant: "destructive",
        title: "Duplicate section name",
        description: "A section with this name already exists."
      });
      return;
    }

    createSectionMutation.mutate({
      grant_id: grant.id,
      section_name: trimmed,
      section_order: sections.length + 1,
    });
  };

  const getAIFeedback = async () => {
    if (!activeSection) return;

    setIsCoachLoading(true);
    
    try {
      const feedback = await base44.integrations.Core.InvokeLLM({
        prompt: coachPrompt,
        response_json_schema: COACH_FEEDBACK_SCHEMA,
      });
      updateSectionFeedbackMutation.mutate({ id: activeSection.id, feedback });
      toast({
        title: "Feedback generated",
        description: "AI coach has reviewed your section."
      });
    } catch (error) {
      console.error("Failed to get AI feedback", error);
      toast({
        variant: "destructive",
        title: "Failed to get feedback",
        description: error.message || "Could not retrieve AI feedback."
      });
    } finally {
      setIsCoachLoading(false);
    }
  };

  const hasPlaceholders = useMemo(() => {
    return sections.some(section =>
      section.draft_content && section.draft_content.includes('[ACTION REQUIRED]')
    );
  }, [sections]);

  const handleFinalReview = async () => {
    setIsFinalReviewing(true);
    setFinalReviewFeedback(null);

    await new Promise(resolve => setTimeout(resolve, 1000));

    if (hasPlaceholders) {
      setFinalReviewFeedback({
        passed: false,
        feedback: "There are still sections with '[ACTION REQUIRED]' placeholders. Please complete them before submission."
      });
      setIsFinalReviewing(false);
      return;
    }

    const wordCount = allContent.split(/\s+/).filter(Boolean).length;

    if (sections.length === 0) {
      setFinalReviewFeedback({
        passed: false,
        feedback: "No sections found. Please add content to your proposal."
      });
      setIsFinalReviewing(false);
      return;
    }

    if (wordCount < wordCountThreshold) {
      setFinalReviewFeedback({
        passed: false,
        feedback: `The overall proposal content seems very short (${wordCount} words). Consider elaborating further to provide a comprehensive response.`
      });
      setIsFinalReviewing(false);
      return;
    }

    try {
      const scoreResult = await base44.integrations.Core.InvokeLLM({
        prompt: scoringPrompt,
        response_json_schema: SCORING_SCHEMA,
      });

      setFinalReviewFeedback({
        passed: true,
        feedback: "Your proposal has been scored and appears ready for submission!",
        scoreResult: scoreResult,
      });
      toast({
        title: "Scoring complete",
        description: "Your proposal has been reviewed and scored."
      });
    } catch (error) {
      console.error("Scoring failed", error);
      setFinalReviewFeedback({
        passed: false,
        feedback: `An error occurred during the scoring process: ${error.message}`
      });
      toast({
        variant: "destructive",
        title: "Scoring failed",
        description: error.message || "Could not complete scoring."
      });
    } finally {
      setIsFinalReviewing(false);
    }
  };

  const handleProceedToSubmission = () => {
    setShowSubmitDialog(false);
    setShowSubmissionAssistant(true);
  };

  const handleImproveSection = async (feedbackItem, itemId) => {
    if (!activeSection) return;
    setImprovingItemId(itemId);
    
    const prompt = buildImprovementPrompt(draftContent, feedbackItem);

    try {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: IMPROVEMENT_SCHEMA,
      });
      
      if (response && typeof response.improved_text === 'string' && response.improved_text.trim() !== '') {
        setDraftContent(response.improved_text);
        setImprovedItems(prev => [...prev, itemId]);
        toast({
          title: "Section improved",
          description: "AI has rewritten the section with your feedback."
        });
      } else {
        console.error("AI did not return valid 'improved_text'. Preserving original content.", response);
        toast({
          variant: "destructive",
          title: "Improvement failed",
          description: "AI did not return valid content."
        });
      }
    } catch (error) {
      console.error("Failed to improve section with AI", error);
      toast({
        variant: "destructive",
        title: "Improvement failed",
        description: error.message || "Could not improve section with AI."
      });
    } finally {
      setImprovingItemId(null);
    }
  };

  if (isLoadingSections) {
    return <div className="flex justify-center items-center p-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  return (
    <>
      <div className="flex flex-col md:flex-row gap-6 bg-slate-50 p-4 rounded-lg border">
        <aside className="w-full md:w-1/4 lg:w-1/5">
          <div className="sticky top-6">
            <h3 className="text-lg font-semibold mb-3">Sections</h3>
            <ul className="space-y-1 mb-4">
              {sections.map(section => (
                <li key={section.id}>
                  <button
                    onClick={() => setActiveSectionId(section.id)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      activeSectionId === section.id
                        ? 'bg-blue-600 text-white font-semibold'
                        : 'hover:bg-slate-200'
                    }`}
                  >
                    {section.section_name}
                  </button>
                </li>
              ))}
            </ul>
            <form onSubmit={handleAddSection} className="flex gap-2 mb-6">
              <Input
                value={newSectionName}
                onChange={(e) => setNewSectionName(e.target.value)}
                placeholder="New section name..."
                disabled={createSectionMutation.isPending}
              />
              <Button type="submit" size="icon" disabled={createSectionMutation.isPending || !newSectionName.trim()}>
                {createSectionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              </Button>
            </form>

            <div className="space-y-3">
               <Button 
                onClick={handleFinalReview} 
                disabled={isFinalReviewing || hasPlaceholders || sections.length === 0}
                className="w-full bg-emerald-600 hover:bg-emerald-700"
                title={hasPlaceholders ? "Please fill in all '[ACTION REQUIRED]' fields before running the final review." : ""}
              >
                {isFinalReviewing ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin"/>Reviewing...</>
                ) : (
                  <><CheckCircle className="w-4 h-4 mr-2"/>Run Final AI Review</>
                )}
              </Button>
              {hasPlaceholders && sections.length > 0 && (
                <p className="text-xs text-amber-700 text-center">Fill in all placeholders to enable final review.</p>
              )}
            </div>
          </div>
        </aside>

        <main className="flex-1 bg-white p-6 rounded-lg shadow-md">
          {activeSection ? (
            <>
              <div className="flex justify-between items-center mb-4">
                  <h2 className="text-2xl font-bold text-slate-900">{activeSection.section_name}</h2>
                  <Button onClick={getAIFeedback} disabled={isCoachLoading} variant="outline">
                      {isCoachLoading ? (
                          <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Getting Feedback...
                          </>
                      ) : (
                          <>
                              <Sparkles className="w-4 h-4 mr-2" />
                              Get AI Coach Feedback
                          </>
                      )}
                  </Button>
              </div>
              {finalReviewFeedback && (
                <Alert className={`mb-4 ${finalReviewFeedback.passed ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                  <AlertTitle className="flex items-center gap-2">
                    {finalReviewFeedback.passed ? <CheckCircle className="w-5 h-5 text-emerald-600" /> : <AlertTriangle className="w-5 h-5 text-rose-600" />}
                    Final Review {finalReviewFeedback.passed ? 'Passed' : 'Failed'}
                  </AlertTitle>
                  <AlertDescription className="text-sm mt-2">
                    {finalReviewFeedback.feedback}
                  </AlertDescription>
                  {finalReviewFeedback.scoreResult && (
                      <div className="mt-4">
                          <ScoringResultCard result={finalReviewFeedback.scoreResult} />
                      </div>
                  )}
                  {finalReviewFeedback.passed && (
                     <div className="mt-6 text-center">
                        <Button onClick={() => setShowSubmitDialog(true)} size="lg">
                          <Send className="w-4 h-4 mr-2"/>
                          Proceed to Submission
                        </Button>
                    </div>
                  )}
                </Alert>
              )}
              <ReactQuill
                theme="snow"
                value={draftContent}
                onChange={setDraftContent}
                className="h-96 mb-12"
              />
              <CoachFeedback 
                feedback={activeSection.ai_feedback} 
                onImprove={handleImproveSection}
                isImproving={improvingItemId}
                improvedItems={improvedItems}
              />
            </>
          ) : (
            <div className="text-center py-12 text-slate-500">
              <FileText className="w-16 h-16 mx-auto mb-4 text-slate-300" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Application Sections</h3>
              <p>Add a section on the left, or use the "Apply with AI" feature to begin drafting your application.</p>
            </div>
          )}
        </main>

         <AlertDialog open={showSubmitDialog} onOpenChange={setShowSubmitDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Ready to Prepare Submission?</AlertDialogTitle>
              <AlertDialogDescription>
                This will launch the AI Submission Assistant, which will analyze the submission requirements and prepare a tailored package for you to send. The application status will not be updated until you confirm submission.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Continue Editing</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleProceedToSubmission}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Launch Submission Assistant
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {showSubmissionAssistant && (
        <SubmissionAssistant
          grant={grant}
          organization={organization}
          sections={sections}
          open={showSubmissionAssistant}
          onClose={() => setShowSubmissionAssistant(false)}
        />
      )}
    </>
  );
}