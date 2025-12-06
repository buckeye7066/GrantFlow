import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { BrainCircuit, Sparkles, Loader2, AlertTriangle, RefreshCw, CheckCircle2, ArrowRight } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from "@/components/ui/use-toast";
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

const AnalyzeButton = ({ onClick, disabled, loading, variant = "default", size = "default", children }) => {
    return (
        <Button
            type="button"
            onClick={onClick}
            disabled={disabled}
            variant={variant}
            size={size}
        >
            {loading ? (
                <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {children || 'Analyzing...'}
                </>
            ) : (
                children
            )}
        </Button>
    );
};

const ReadyView = ({ 
    aiSummary, 
    checklistItems, 
    showNextSteps, 
    onStartApplication, 
    onRefresh, 
    loading 
}) => {
    const openChecklistItems = useMemo(
        () => checklistItems.filter(item => item.status !== 'done'),
        [checklistItems]
    );
    const hasOutstandingItems = openChecklistItems.length > 0;

    return (
        <div className="relative z-10 space-y-4">
            <ReactMarkdown className="prose prose-sm max-w-none">{aiSummary}</ReactMarkdown>
            
            {hasOutstandingItems ? (
                <Alert className="bg-amber-50 border-amber-200">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertDescription>
                        <p className="font-semibold text-amber-900 mb-1">Action Required</p>
                        <p className="text-amber-800 text-sm">
                            Complete {openChecklistItems.length} checklist item{openChecklistItems.length > 1 ? 's' : ''} before starting the application.
                        </p>
                    </AlertDescription>
                </Alert>
            ) : showNextSteps && checklistItems.length > 0 ? (
                <Alert className="bg-emerald-50 border-emerald-200">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    <AlertDescription>
                        <p className="font-semibold text-emerald-900 mb-2">Ready to Apply!</p>
                        <p className="text-emerald-800 text-sm mb-3">
                            All checklist items are complete. You can now start building your application with AI assistance.
                        </p>
                        <Button 
                            onClick={onStartApplication}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                            size="sm"
                        >
                            <Sparkles className="w-4 h-4 mr-2" />
                            Start Application with AI
                            <ArrowRight className="w-4 h-4 ml-2" />
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}
            
            <div className="text-right">
                <AnalyzeButton onClick={onRefresh} disabled={loading} loading={loading} variant="outline" size="sm">
                    <RefreshCw className={`w-3 h-3 mr-2 ${loading ? 'animate-spin' : ''}`} />
                    Refresh Analysis
                </AnalyzeButton>
            </div>
        </div>
    );
};

const ErrorView = ({ aiError, onRetry, loading }) => {
    return (
        <div className="relative z-10">
            <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                    <p className="font-semibold mb-2">Analysis Failed</p>
                    <p className="text-xs mb-4">{aiError}</p>
                    <AnalyzeButton onClick={onRetry} disabled={loading} loading={loading} variant="destructive" size="sm">
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Try Again
                    </AnalyzeButton>
                </AlertDescription>
            </Alert>
        </div>
    );
};

const LoadingView = ({ onRetry, loading }) => {
    return (
        <div className="text-center p-8">
            <Loader2 className="w-12 h-12 mx-auto text-slate-400 mb-4 animate-spin" />
            <h3 className="text-lg font-semibold text-slate-800">Analyzing...</h3>
            <p className="text-slate-600 mb-4">The AI is reviewing the grant details. This may take a moment.</p>
            <AnalyzeButton onClick={onRetry} disabled={loading} loading={loading} variant="outline" size="sm">
                <RefreshCw className="w-4 h-4 mr-2" />
                Retry if Stuck
            </AnalyzeButton>
        </div>
    );
};

const IdleView = ({ hasSufficientData, onAnalyze, loading }) => {
    return (
        <div className="text-center p-8">
            <BrainCircuit className="w-12 h-12 mx-auto text-slate-400 mb-4" />
            <h3 className="text-lg font-semibold text-slate-800 mb-2">AI Coach is ready</h3>
            {!hasSufficientData ? (
                <div className="text-left bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-md text-sm mb-4">
                    <AlertTriangle className="h-4 w-4 inline-block mr-2" />
                    More information needed. Please add a Program Description or Eligibility Summary to enable analysis.
                </div>
            ) : (
                <p className="text-slate-600 mb-6">Click below to analyze this grant's requirements and generate strategic insights.</p>
            )}
            <AnalyzeButton onClick={onAnalyze} disabled={!hasSufficientData || loading} loading={loading} className="bg-blue-600 hover:bg-blue-700">
                <Sparkles className="w-5 h-5 mr-2" />
                Analyze Now
            </AnalyzeButton>
        </div>
    );
};

const ProposalCoachPanel = ({ grant, onAnalyze, isAnalyzing, onStartApplication }) => {
    const { toast } = useToast();
    const [localLoading, setLocalLoading] = useState(false);
    const [showNextSteps, setShowNextSteps] = useState(false);
    
    const { data: checklistItems = [] } = useQuery({
        queryKey: ['checklistItems', grant?.id],
        queryFn: () => base44.entities.ChecklistItem.filter({ grant_id: grant.id }),
        enabled: !!grant?.id && grant.ai_status === 'ready'
    });

    const hasSufficientData = useMemo(
        () => !!(grant?.program_description || grant?.eligibility_summary),
        [grant?.program_description, grant?.eligibility_summary]
    );

    const loading = isAnalyzing || localLoading;
    
    useEffect(() => {
        if (grant?.ai_status === 'ready' && checklistItems.length > 0) {
            const openItems = checklistItems.filter(item => item.status !== 'done');
            setShowNextSteps(openItems.length === 0);
        }
    }, [grant?.ai_status, checklistItems]);

    useEffect(() => {
        if (!grant) return;
        
        if (['running', 'queued'].includes(grant.ai_status)) {
            const updatedAt = grant.ai_updated_at ? new Date(grant.ai_updated_at).getTime() : Date.now();
            const elapsed = Date.now() - updatedAt;
            const timeoutDuration = Math.max(120000 - elapsed, 0);
            
            if (timeoutDuration === 0) {
                console.warn('[AI Coach] Already past timeout, resetting immediately');
                handleTimeout();
                return;
            }

            const timeout = setTimeout(() => {
                handleTimeout();
            }, timeoutDuration);
            
            return () => clearTimeout(timeout);
        }

        async function handleTimeout() {
            console.warn('[AI Coach] Analysis timeout - resetting status for grant:', grant.id);
            
            toast({
                variant: "destructive",
                title: "Analysis Timeout",
                description: "The analysis took too long and has been reset. Please try again."
            });
            
            try {
                await base44.entities.Grant.update(grant.id, {
                    ai_status: 'error',
                    ai_error: 'Analysis timeout - please try again'
                });
                
                toast({
                    title: "Status Reset",
                    description: "You can now retry the analysis."
                });
            } catch (err) {
                console.error('[AI Coach] Failed to reset status:', err);
                toast({
                    variant: "destructive",
                    title: "Reset Failed",
                    description: "Could not reset analysis status. Please refresh the page."
                });
            }
        }
    }, [grant?.id, grant?.ai_status, grant?.ai_updated_at, toast]);
    
    if (!grant) {
        console.error('[AI Coach] No grant provided');
        return null;
    }

    const handleAnalyzeClick = async (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        if (loading) {
            console.warn('[AI Coach] Already analyzing, ignoring click');
            return;
        }
        
        console.log('[AI Coach] Analyze clicked for grant:', grant.id);
        
        if (!hasSufficientData) {
            toast({
                variant: "destructive",
                title: "Cannot Analyze",
                description: "Please add Program Description or Eligibility Summary first."
            });
            return;
        }
        
        if (!onAnalyze) {
            console.warn('[AI Coach] onAnalyze function not provided, skipping analysis');
            return;
        }
        
        setLocalLoading(true);
        console.log('[AI Coach] Calling onAnalyze...');
        
        try {
            await onAnalyze();
            console.log('[AI Coach] onAnalyze completed successfully');
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
        const { ai_status, ai_summary, ai_error } = grant;

        if (ai_status === 'ready' && ai_summary) {
            return (
                <ReadyView
                    aiSummary={ai_summary}
                    checklistItems={checklistItems}
                    showNextSteps={showNextSteps}
                    onStartApplication={handleStartApplication}
                    onRefresh={handleAnalyzeClick}
                    loading={loading}
                />
            );
        }

        if (ai_status === 'error' && ai_error) {
            return (
                <ErrorView
                    aiError={ai_error}
                    onRetry={handleAnalyzeClick}
                    loading={loading}
                />
            );
        }
        
        if (loading || ai_status === 'running' || ai_status === 'queued') {
            return (
                <LoadingView
                    onRetry={handleAnalyzeClick}
                    loading={loading}
                />
            );
        }

        return (
            <IdleView
                hasSufficientData={hasSufficientData}
                onAnalyze={handleAnalyzeClick}
                loading={loading}
            />
        );
    };

    const getStatusText = () => {
        if (grant.ai_status === 'ready' && grant.ai_updated_at) {
            return `Last analyzed: ${new Date(grant.ai_updated_at).toLocaleString()}`;
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