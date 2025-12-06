import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  ChevronLeft, ChevronRight, Loader2, Lock, CheckCircle2, 
  XCircle, AlertTriangle, Copy, ExternalLink, SkipForward
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

const OWNER_EMAIL = 'buckeye7066@gmail.com';

// All functions to review
const ALL_FUNCTIONS = [
  'analyzeGrant', 'analyze2grant', 'analyzeProposal', 'analyzeProjectOutcomes', 'analyzeTaxSituation',
  'aiGrantMatcher', 'comprehensiveMatch', 'matchGrantsForOrganization', 'matchProfileToGrants', 'matchFunderToProfile',
  'searchOpportunities', 'searchForItem', 'searchForSource', 'getSearchJob',
  'discoverLocalSources', 'discoverStudentSources', 'discoverECFSources', 'discoverECFServices', 'autoDiscoverSources', 'runAutomatedDiscovery',
  'crawlGrantsGov', 'crawlBenefitsGov', 'crawlECFChoices', 'crawlWebsite', 'crawlSourceDirectory',
  'crawlDSIRE', 'crawlIrs990', 'crawlLeeUniversity', 'crawlUniversityScholarships', 'crawlCLSFM',
  'scheduledCrawl', 'queueCrawl', 'runPartnerFeed',
  'processSingleGrant', 'processCrawledItem', 'processOpportunity', 'processFoundation',
  'processDocumentForFacts', 'processScannedApplication', 'processApplicationEmail',
  'backgroundWorker', 'autoMonitor', 'runBatchAutomation', 'runSmartAutomation',
  'runBackgroundAutoAdvance', 'enqueueGrant', 'getBackgroundJobStatus', 'runVerification', 'runGrantBackfill',
  'sendEmailResend', 'sendInvoice', 'sendDeadlineAlerts', 'sendReportReminders',
  'notifyAdminNewMessage', 'notifyAdminNewUser',
  'generateProposalSection', 'generateGrantProposal', 'generateApplicationResponse',
  'generateProgressReport', 'generateReport', 'generateOutreachMessage', 'autoGenerateBulkOutreach', 'generateTaxReturn',
  'refineGrantText', 'refineProposalText',
  'getAIRecommendations', 'getSuggestedEnhancements', 'suggestGrantKeywords', 'suggestProposalKeywords', 'suggestDocumentsForGrant',
  'checkApplicationAvailability', 'checkApplicationCompliance', 'checkGrantAlerts',
  'checkPendingApplications', 'validatePipelineAdvancement', 'verifyProfileIsolation',
  'parseNOFO', 'parseFunderWebsite',
  'getUserList', 'deleteUser', 'deleteOrganizationWithCascade', 'deleteSourceWithCascade',
  'submitGrant', 'submitPublicApplication', 'prepareGrantSubmission', 'autoFillApplicationForm',
  'enrichProfileForSearch',
  'requestTaxDocuments', 'exportForTaxSoftware',
  'autoCreateLead', 'getLeads', 'getLead', 'createLead', 'updateLead', 'deleteLead', 'getActivities', 'getLeadActivities',
  'publicApplicationForm',
  'simulatePipelineRunDebug',
  'findAllFunctions', 'findAllFunctionsHybrid', 'testAllFunctions', 'testSharedModules',
  'autoGenerateFunctionTestPayloads', 'autoGenerateFunctionTestPayloadsHard', 'writeAllTestPayloadsNow', 'createPayloadsForAllFunctions'
];

export default function FunctionCodeReview() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reviewStatus, setReviewStatus] = useState({}); // { functionId: 'ok' | 'issue' | 'skipped' }
  const [functionCode, setFunctionCode] = useState(null);
  const [isLoadingCode, setIsLoadingCode] = useState(false);
  const { toast } = useToast();

  const { data: user, isLoading: loadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me()
  });

  const isAdmin = user?.email === OWNER_EMAIL || user?.role === 'admin';
  const currentFunction = ALL_FUNCTIONS[currentIndex];
  const totalFunctions = ALL_FUNCTIONS.length;

  // Load function code when index changes
  const loadFunctionCode = async (functionId) => {
    setIsLoadingCode(true);
    setFunctionCode(null);
    
    try {
      // Call a backend function to get the code
      const response = await base44.functions.invoke('getFunctionCode', { functionId });
      const data = response?.data;
      
      if (data?.ok) {
        setFunctionCode(data.data);
      } else {
        setFunctionCode({ 
          error: data?.error || 'Failed to load code',
          functionId 
        });
      }
    } catch (err) {
      setFunctionCode({ 
        error: err?.message || 'Failed to load code',
        functionId 
      });
    } finally {
      setIsLoadingCode(false);
    }
  };

  // Load code on mount and when index changes
  React.useEffect(() => {
    if (isAdmin && currentFunction) {
      loadFunctionCode(currentFunction);
    }
  }, [currentIndex, isAdmin]);

  const markAsOk = () => {
    setReviewStatus(prev => ({ ...prev, [currentFunction]: 'ok' }));
    goNext();
  };

  const markAsIssue = () => {
    setReviewStatus(prev => ({ ...prev, [currentFunction]: 'issue' }));
    toast({ title: `Marked ${currentFunction} as having issues` });
  };

  const skipFunction = () => {
    setReviewStatus(prev => ({ ...prev, [currentFunction]: 'skipped' }));
    goNext();
  };

  const goNext = () => {
    if (currentIndex < totalFunctions - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const goPrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const copyCode = () => {
    if (functionCode?.sourceCode) {
      navigator.clipboard.writeText(functionCode.sourceCode);
      toast({ title: 'Code copied to clipboard' });
    }
  };

  // Loading
  if (loadingUser) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Not admin
  if (!isAdmin) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Card>
          <CardContent className="p-12 text-center">
            <Lock className="w-16 h-16 mx-auto text-slate-300 mb-4" />
            <h3 className="text-xl font-semibold">Admin Access Required</h3>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Count statuses
  const okCount = Object.values(reviewStatus).filter(s => s === 'ok').length;
  const issueCount = Object.values(reviewStatus).filter(s => s === 'issue').length;
  const skippedCount = Object.values(reviewStatus).filter(s => s === 'skipped').length;

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-slate-800 border-b border-slate-700 p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Function Code Review</h1>
            <p className="text-slate-400 text-sm">
              Function {currentIndex + 1} of {totalFunctions}
            </p>
          </div>
          
          <div className="flex items-center gap-6">
            {/* Status counts */}
            <div className="flex gap-4 text-sm">
              <span className="text-green-400">✓ {okCount} OK</span>
              <span className="text-red-400">✗ {issueCount} Issues</span>
              <span className="text-slate-400">⊘ {skippedCount} Skipped</span>
            </div>
            
            {/* Navigation */}
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={goPrev}
                disabled={currentIndex === 0}
                className="bg-slate-700 border-slate-600"
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="text-sm px-3">{currentIndex + 1} / {totalFunctions}</span>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={goNext}
                disabled={currentIndex === totalFunctions - 1}
                className="bg-slate-700 border-slate-600"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Function Info Bar */}
      <div className="bg-slate-800 border-b border-slate-700 p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="font-mono text-2xl font-bold text-blue-400">{currentFunction}</div>
            <Badge className="bg-slate-700">{`functions/${currentFunction}.js`}</Badge>
            {reviewStatus[currentFunction] === 'ok' && (
              <Badge className="bg-green-600">Reviewed OK</Badge>
            )}
            {reviewStatus[currentFunction] === 'issue' && (
              <Badge className="bg-red-600">Has Issues</Badge>
            )}
            {reviewStatus[currentFunction] === 'skipped' && (
              <Badge className="bg-slate-600">Skipped</Badge>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={copyCode} className="bg-slate-700 border-slate-600">
              <Copy className="w-4 h-4 mr-1" /> Copy
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={skipFunction}
              className="bg-slate-700 border-slate-600"
            >
              <SkipForward className="w-4 h-4 mr-1" /> Skip
            </Button>
            <Button 
              variant="destructive" 
              size="sm" 
              onClick={markAsIssue}
            >
              <XCircle className="w-4 h-4 mr-1" /> Mark Issue
            </Button>
            <Button 
              size="sm" 
              onClick={markAsOk}
              className="bg-green-600 hover:bg-green-700"
            >
              <CheckCircle2 className="w-4 h-4 mr-1" /> OK, Next
            </Button>
          </div>
        </div>
      </div>

      {/* Code Display */}
      <div className="max-w-7xl mx-auto p-4">
        {isLoadingCode ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
            <span className="ml-3 text-slate-400">Loading {currentFunction}...</span>
          </div>
        ) : functionCode?.error ? (
          <Card className="bg-red-900/20 border-red-800">
            <CardContent className="p-6">
              <div className="flex items-center gap-3 text-red-400">
                <AlertTriangle className="w-6 h-6" />
                <span>Error loading code: {functionCode.error}</span>
              </div>
              <p className="text-slate-400 mt-4 text-sm">
                The getFunctionCode backend function may not exist yet. You can view this function's code directly in the Base44 dashboard:
                <br />
                Dashboard → Code → Functions → {currentFunction}
              </p>
            </CardContent>
          </Card>
        ) : functionCode?.sourceCode ? (
          <div className="space-y-4">
            {/* Main Source Code */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader className="border-b border-slate-700 py-3">
                <CardTitle className="text-sm text-slate-300">
                  {functionCode.filePath} ({functionCode.lineCount} lines)
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <pre className="p-4 overflow-auto max-h-[600px] text-sm">
                  <code className="text-green-400 font-mono whitespace-pre">
                    {functionCode.sourceCode}
                  </code>
                </pre>
              </CardContent>
            </Card>

            {/* Imported Shared Modules */}
            {functionCode.imports && functionCode.imports.length > 0 && (
              <Card className="bg-slate-800 border-slate-700">
                <CardHeader className="border-b border-slate-700 py-3">
                  <CardTitle className="text-sm text-slate-300">
                    Imported Shared Modules ({functionCode.imports.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="flex flex-wrap gap-2">
                    {functionCode.imports.map((imp, idx) => (
                      <Badge key={idx} className="bg-slate-700 font-mono text-xs">
                        {imp}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Shared Module Source Codes */}
            {functionCode.sharedModules && Object.keys(functionCode.sharedModules).length > 0 && (
              <>
                <h3 className="text-lg font-semibold text-slate-300 mt-6">Shared Module Code:</h3>
                {Object.entries(functionCode.sharedModules).map(([moduleName, moduleCode]) => (
                  <Card key={moduleName} className="bg-slate-800 border-slate-700">
                    <CardHeader className="border-b border-slate-700 py-3">
                      <CardTitle className="text-sm text-yellow-400 font-mono">
                        _shared/{moduleName}.js
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <pre className="p-4 overflow-auto max-h-[400px] text-sm">
                        <code className="text-yellow-300 font-mono whitespace-pre">
                          {moduleCode}
                        </code>
                      </pre>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </div>
        ) : (
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="p-12 text-center text-slate-400">
              No code loaded. Click a function to view its code.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Progress Bar at Bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-slate-800 border-t border-slate-700 p-3">
        <div className="max-w-7xl mx-auto">
          <div className="flex gap-1">
            {ALL_FUNCTIONS.map((fn, idx) => (
              <button
                key={fn}
                onClick={() => setCurrentIndex(idx)}
                className={`h-2 flex-1 rounded-sm transition-colors ${
                  idx === currentIndex 
                    ? 'bg-blue-500' 
                    : reviewStatus[fn] === 'ok'
                    ? 'bg-green-500'
                    : reviewStatus[fn] === 'issue'
                    ? 'bg-red-500'
                    : reviewStatus[fn] === 'skipped'
                    ? 'bg-slate-600'
                    : 'bg-slate-700 hover:bg-slate-600'
                }`}
                title={fn}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}