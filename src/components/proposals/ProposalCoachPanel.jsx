import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { BrainCircuit, Sparkles, Loader2, AlertTriangle, RefreshCw, CheckCircle2, ArrowRight } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from "@/components/ui/use-toast";
import { createLogger } from '@/utils/logger';
import { Textarea } from '@/components/ui/textarea'

const ProposalCoachPanel = ({ grant, onAnalyze, isAnalyzing, onStartApplication, onSaveDetails, onDraftDetails }) => {
    const { toast } = useToast();
    const log = React.useMemo(() => createLogger('ProposalCoachPanel'), []);
    const [localLoading, setLocalLoading] = useState(false);
    const [showNextSteps, setShowNextSteps] = useState(false);
    const [editOpen, setEditOpen] = useState(false)
    const [draftLoading, setDraftLoading] = useState(false)
    const [programDescription, setProgramDescription] = useState('')
    const [eligibilitySummary, setEligibilitySummary] = useState('')
    const [selectionCriteria, setSelectionCriteria] = useState('')

    useEffect(() => {
        // Submission readiness lives in the Apply Engine (backend).
        setShowNextSteps(grant?.ai_status === 'ready');
    }, [grant?.ai_status]);

    useEffect(() => {
      // Keep local editor state in sync with the grant.
      setProgramDescription(String(grant?.program_description || ''))
      setEligibilitySummary(String(grant?.eligibility_summary || ''))
      setSelectionCriteria(String(grant?.selection_criteria || ''))
    }, [grant?.id, grant?.program_description, grant?.eligibility_summary, grant?.selection_criteria])
    
    if (!grant) {
        console.error('[AI Coach] No grant provided');
        return null;
    }

    log.debug('render', { grantId: grant.id, aiStatus: grant.ai_status });

    const { program_description, eligibility_summary, ai_status, ai_summary, ai_error } = grant;
    const hasSufficientData = !!(program_description || eligibility_summary);
    const loading = isAnalyzing || localLoading;
    
    const handleAnalyzeClick = async (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        if (loading) {
            console.warn('[AI Coach] Already analyzing, ignoring click');
            return;
        }
        
        log.debug('analyze clicked', { grantId: grant.id });
        
        if (!hasSufficientData) {
            toast({
                variant: "destructive",
                title: "Cannot Analyze",
                description: "Please add Program Description or Eligibility Summary first."
            });
            return;
        }
        
        if (!onAnalyze) {
            console.error('[AI Coach] onAnalyze function not provided!');
            toast({
                variant: "destructive",
                title: "Configuration Error",
                description: "Analysis function not available."
            });
            return;
        }
        
        setLocalLoading(true);
        log.debug('calling onAnalyze');
        
        try {
            await onAnalyze();
            log.debug('onAnalyze completed');
        } catch (error) {
            console.error('[AI Coach] onAnalyze failed:', error);
            toast({
                variant: "destructive",
                title: "Analysis Failed",
                description: error.message || "An unexpected error occurred."
            });
        } finally {
            setLocalLoading(false);
        }
    };
    
    const handleStartApplication = () => {
        if (onStartApplication) {
            onStartApplication();
        } else {
            toast({
                variant: "destructive",
                title: "Error",
                description: "Application assistant not available."
            });
        }
    };
    
    const renderContent = () => {
        if (ai_status === 'ready') {
            if (!ai_summary) {
                return (
                    <div className="relative z-10">
                        <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertDescription>
                                <p className="font-semibold mb-2">Analysis Incomplete</p>
                                <p className="text-xs mb-4">The analysis completed but returned no summary. Please re-analyze.</p>
                                <Button
                                    type="button"
                                    onClick={handleAnalyzeClick}
                                    disabled={loading}
                                    variant="destructive"
                                    size="sm"
                                >
                                    {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                                    Re-Analyze
                                </Button>
                            </AlertDescription>
                        </Alert>
                    </div>
                );
            }
            return (
                <div className="relative z-10 space-y-4">
                    <ReactMarkdown className="prose prose-sm max-w-none">{ai_summary}</ReactMarkdown>
                    {showNextSteps ? (
                      <Alert className="bg-emerald-50 border-emerald-200">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        <AlertDescription>
                          <p className="font-semibold text-emerald-900 mb-2">Ready to Apply</p>
                          <p className="text-emerald-800 text-sm mb-3">
                            Start drafting sections using the Apply Engine (sections + checklist + exports live in the backend).
                          </p>
                          <Button onClick={handleStartApplication} className="bg-emerald-600 hover:bg-emerald-700 text-white" size="sm">
                            <Sparkles className="w-4 h-4 mr-2" />
                            Start Application
                            <ArrowRight className="w-4 h-4 ml-2" />
                          </Button>
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    
                    <div className="text-right">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleAnalyzeClick}
                            disabled={loading}
                            size="sm"
                        >
                            <RefreshCw className={`w-3 h-3 mr-2 ${loading ? 'animate-spin' : ''}`} />
                            Refresh Analysis
                        </Button>
                    </div>
                </div>
            );
        }

        if (ai_status === 'error' && ai_error) {
            return (
                <div className="relative z-10">
                    <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>
                            <p className="font-semibold mb-2">Analysis Failed</p>
                            <p className="text-xs mb-4">{ai_error}</p>
                            <Button
                                type="button"
                                onClick={handleAnalyzeClick}
                                disabled={loading}
                                variant="destructive"
                                size="sm"
                            >
                                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                                Try Again
                            </Button>
                        </AlertDescription>
                    </Alert>
                </div>
            );
        }
        
        if (loading || ai_status === 'running' || ai_status === 'queued') {
            return (
                <div className="text-center p-8">
                    <Loader2 className="w-12 h-12 mx-auto text-slate-400 mb-4 animate-spin" />
                    <h3 className="text-lg font-semibold text-slate-800">Analyzing...</h3>
                    <p className="text-slate-600 mb-4">The AI is reviewing the grant details. This may take a moment.</p>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleAnalyzeClick}
                        disabled={loading}
                        size="sm"
                        title={loading ? 'Analysis is in progress — wait for it to finish or time out before retrying.' : undefined}
                    >
                        <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                        {loading ? 'In progress…' : 'Retry if Stuck'}
                    </Button>
                </div>
            );
        }

        return (
            <div className="text-center p-8">
                <BrainCircuit className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                <h3 className="text-lg font-semibold text-slate-800 mb-2">AI Coach is ready</h3>
                {!hasSufficientData ? (
                    <>
                      <div className="text-left bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded-md text-sm mb-4">
                          <AlertTriangle className="h-4 w-4 inline-block mr-2" />
                          More information needed. Add a Program Description or Eligibility Summary to enable analysis.
                      </div>

                      <div className="flex flex-wrap justify-center gap-2 mb-4">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setEditOpen((v) => !v)}
                          disabled={loading}
                          size="sm"
                        >
                          {editOpen ? 'Hide editor' : 'Add info'}
                        </Button>
                        <Button
                          type="button"
                          onClick={async () => {
                            if (!onDraftDetails) {
                              toast({ variant: 'destructive', title: 'Not available', description: 'AI drafting is not available here.' })
                              return
                            }
                            if (draftLoading) return
                            setDraftLoading(true)
                            try {
                              await onDraftDetails({
                              grantId: grant?.id,
                              program_description: programDescription,
                              eligibility_summary: eligibilitySummary,
                              selection_criteria: selectionCriteria,
                            })
                              toast({ title: 'Draft added', description: 'Program Description / Eligibility Summary updated.' })
                            } catch (e) {
                              toast({ variant: 'destructive', title: 'AI draft failed', description: e?.message || 'Try again.' })
                            } finally {
                              setDraftLoading(false)
                            }
                          }}
                          disabled={loading || draftLoading}
                          className="bg-purple-600 hover:bg-purple-700 text-white"
                          size="sm"
                        >
                          {draftLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                          Draft with AI
                        </Button>
                      </div>

                      {editOpen ? (
                        <div className="mx-auto max-w-2xl text-left space-y-3">
                          <div className="space-y-1">
                            <div className="text-xs font-semibold text-slate-800">Program Description</div>
                            <Textarea
                              value={programDescription}
                              onChange={(e) => setProgramDescription(e.target.value)}
                              placeholder="Paste or type the program description here..."
                              className="min-h-[120px]"
                            />
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs font-semibold text-slate-800">Eligibility Summary</div>
                            <Textarea
                              value={eligibilitySummary}
                              onChange={(e) => setEligibilitySummary(e.target.value)}
                              placeholder="Paste or type eligibility details here (bullets preferred)..."
                              className="min-h-[120px]"
                            />
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs font-semibold text-slate-800">Selection Criteria (optional)</div>
                            <Textarea
                              value={selectionCriteria}
                              onChange={(e) => setSelectionCriteria(e.target.value)}
                              placeholder="Optional: key scoring/selection criteria..."
                              className="min-h-[90px]"
                            />
                          </div>

                          <div className="flex items-center justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => {
                                setEditOpen(false)
                                setProgramDescription(String(grant?.program_description || ''))
                                setEligibilitySummary(String(grant?.eligibility_summary || ''))
                                setSelectionCriteria(String(grant?.selection_criteria || ''))
                              }}
                              disabled={loading}
                              size="sm"
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              onClick={async () => {
                                if (!onSaveDetails) {
                                  toast({ variant: 'destructive', title: 'Not available', description: 'Saving is not available here.' })
                                  return
                                }
                                setLocalLoading(true)
                                try {
                                  await onSaveDetails({
                                    program_description: programDescription,
                                    eligibility_summary: eligibilitySummary,
                                    selection_criteria: selectionCriteria,
                                  })
                                  toast({ title: 'Saved', description: 'Grant info updated. Click "Analyze Now" to generate AI insights.' })
                                  setEditOpen(false)
                                } catch (e) {
                                  toast({ variant: 'destructive', title: 'Save failed', description: e?.message || 'Try again.' })
                                } finally {
                                  setLocalLoading(false)
                                }
                              }}
                              disabled={loading}
                              className="bg-blue-600 hover:bg-blue-700"
                              size="sm"
                            >
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </>
                ) : (
                    <p className="text-slate-600 mb-6">Click below to analyze this grant's requirements and generate strategic insights.</p>
                )}
                <Button
                    type="button"
                    onClick={handleAnalyzeClick}
                    disabled={!hasSufficientData || loading}
                    className="bg-blue-600 hover:bg-blue-700"
                >
                    {loading ? (
                        <>
                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                            Analyzing...
                        </>
                    ) : (
                        <>
                            <Sparkles className="w-5 h-5 mr-2" />
                            Analyze Now
                        </>
                    )}
                </Button>
            </div>
        );
    };

    const getStatusText = () => {
        if (ai_status === 'ready' && grant.ai_updated_at) {
            const analyzedAt = new Date(grant.ai_updated_at);
            if (!isNaN(analyzedAt.getTime())) {
                return `Last analyzed: ${analyzedAt.toLocaleString()}`;
            }
            return 'Analysis ready';
        }
        if (loading) return 'Analyzing...';
        return 'Ready to analyze';
    };

    return (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="flex justify-between items-center px-6 py-4 border-b border-slate-200 bg-slate-50">
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <BrainCircuit className="w-5 h-5 text-purple-600" />
                    AI Proposal Coach
                </h3>
                <span className="text-sm text-slate-600 font-medium">
                    {getStatusText()}
                </span>
            </div>
            <div className="p-6 min-h-[300px]">
                {renderContent()}
            </div>
        </div>
    );
};

export default ProposalCoachPanel;