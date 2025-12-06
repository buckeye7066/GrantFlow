import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Check, ChevronLeft, ChevronRight } from "lucide-react";

// All function file paths - 20 per block
const ALL_FUNCTIONS = [
  'analyzeGrant', 'analyze2grant', 'aiGrantMatcher', 'autoCreateLead', 'autoDiscoverSources',
  'autoFillApplicationForm', 'autoGenerateBulkOutreach', 'autoGenerateFunctionTestPayloads',
  'autoGenerateFunctionTestPayloadsHard', 'autoMonitor', 'backgroundWorker', 'buildDependencyGraph',
  'checkApplicationAvailability', 'checkApplicationCompliance', 'checkGrantAlerts', 'checkPendingApplications',
  'comprehensiveMatch', 'crawlBenefitsGov', 'crawlCLSFM', 'crawlDSIRE',
  'crawlECFChoices', 'crawlGrantsGov', 'crawlIrs990', 'crawlLeeUniversity',
  'crawlSourceDirectory', 'crawlUniversityScholarships', 'crawlWebsite', 'createLead',
  'createPayloadsForAllFunctions', 'deleteLead', 'deleteOrganizationWithCascade', 'deleteSourceWithCascade',
  'deleteUser', 'discoverECFServices', 'discoverECFSources', 'discoverLocalSources',
  'discoverStudentSources', 'enrichProfileForSearch', 'enqueueGrant', 'exportForTaxSoftware',
  'findAllFunctions', 'findAllFunctionsHybrid', 'generateApplicationResponse', 'generateGrantProposal',
  'generateOutreachMessage', 'generateProgressReport', 'generateReport', 'generateTaxReturn',
  'getActivities', 'getAIRecommendations', 'getAllFunctionCodes', 'getBackgroundJobStatus',
  'getFunctionCode', 'getFunctionDetails', 'getFunctionInfluenceMap', 'getLead',
  'getLeadActivities', 'getLeads', 'getMultipleFunctionCodes', 'getSearchJob',
  'getSuggestedEnhancements', 'getUserList', 'matchFunderToProfile', 'matchGrantsForOrganization',
  'matchProfileToGrants', 'notifyAdminNewMessage', 'notifyAdminNewUser', 'parseFunderWebsite',
  'parseNOFO', 'processApplicationEmail', 'processCrawledItem', 'processDocumentForFacts',
  'processFoundation', 'processOpportunity', 'processScannedApplication', 'processSingleGrant',
  'publicApplicationForm', 'pullFromGithub', 'pushAllFunctionsToGithub', 'pushToGithub',
  'queueCrawl', 'refineGrantText', 'refineProposalText', 'requestTaxDocuments',
  'runAutomatedDiscovery', 'runBackgroundAutoAdvance', 'runBatchAutomation', 'runGrantBackfill',
  'runPartnerFeed', 'runSmartAutomation', 'runVerification', 'scheduledCrawl',
  'searchForItem', 'searchForSource', 'searchOpportunities', 'sendDeadlineAlerts',
  'sendEmailResend', 'sendInvoice', 'sendReportReminders', 'simulatePipelineRunDebug',
  'submitGrant', 'submitPublicApplication', 'suggestDocumentsForGrant', 'suggestGrantKeywords',
  'suggestProposalKeywords', 'testAllFunctions', 'testFileSystemAPI', 'testSharedModules',
  'updateLead', 'validatePipelineAdvancement', 'verifyProfileIsolation', 'writeAllTestPayloadsNow',
  'analyzeProjectOutcomes', 'analyzeProposal', 'analyzeTaxSituation', 'generateProposalSection',
  'prepareGrantSubmission'
];

const SHARED_MODULES = [
  '_shared/adminGuard', '_shared/atomicLock', '_shared/authGuard', '_shared/buildNormalizedProfile',
  '_shared/cosineSimilarity', '_shared/crawlerFramework', '_shared/crawlerStability', '_shared/discoveredFields',
  '_shared/env', '_shared/matchDiagnostics', '_shared/parseProfileNarratives', '_shared/phiAuditLogger',
  '_shared/pipelineIsolation', '_shared/processingQueue', '_shared/profileIsolation', '_shared/profileMatchingEngine',
  '_shared/profileSignature', '_shared/redactSensitiveProfileFields', '_shared/rlsSafeSDK', '_shared/safety',
  '_shared/safeHandler', '_shared/saveFundingSource', '_shared/security', '_shared/strictProfileValidator',
  '_shared/withDiagnostics', '_utils/resolveEntityId'
];

const BLOCK_SIZE = 20;

export default function ExportFunctions() {
  const [currentBlock, setCurrentBlock] = useState(0);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [showShared, setShowShared] = useState(false);

  const allItems = showShared ? SHARED_MODULES : ALL_FUNCTIONS;
  const totalBlocks = Math.ceil(allItems.length / BLOCK_SIZE);
  const startIndex = currentBlock * BLOCK_SIZE;
  const endIndex = Math.min(startIndex + BLOCK_SIZE, allItems.length);
  const currentItems = allItems.slice(startIndex, endIndex);

  const copyToClipboard = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const copyBlockList = () => {
    const list = currentItems.map((f, i) => `${startIndex + i + 1}. ${f}`).join('\n');
    navigator.clipboard.writeText(list);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Export Functions to GitHub</h1>
        <p className="text-slate-600 mb-4">
          Copy each function from Base44 Dashboard → Code → Functions, then paste into GitHub.
        </p>
        
        <div className="flex gap-2 mb-4">
          <Button
            variant={!showShared ? "default" : "outline"}
            onClick={() => { setShowShared(false); setCurrentBlock(0); }}
          >
            Main Functions ({ALL_FUNCTIONS.length})
          </Button>
          <Button
            variant={showShared ? "default" : "outline"}
            onClick={() => { setShowShared(true); setCurrentBlock(0); }}
          >
            Shared Modules ({SHARED_MODULES.length})
          </Button>
        </div>
      </div>

      <Card className="mb-4">
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-lg">
            Block {currentBlock + 1} of {totalBlocks} ({startIndex + 1}-{endIndex} of {allItems.length})
          </CardTitle>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentBlock(Math.max(0, currentBlock - 1))}
              disabled={currentBlock === 0}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentBlock(Math.min(totalBlocks - 1, currentBlock + 1))}
              disabled={currentBlock >= totalBlocks - 1}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={copyBlockList}>
              Copy List
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {currentItems.map((funcName, idx) => {
              const globalIndex = startIndex + idx;
              const isCopied = copiedIndex === globalIndex;
              const fullPath = showShared ? `functions/${funcName}.js` : `functions/${funcName}.js`;
              
              return (
                <div
                  key={funcName}
                  className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-slate-400 font-mono text-sm w-8">{globalIndex + 1}.</span>
                    <code className="text-sm font-medium">{funcName}</code>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyToClipboard(fullPath, globalIndex)}
                      className="h-8"
                    >
                      {isCopied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                      <span className="ml-1 text-xs">{isCopied ? 'Copied!' : 'Path'}</span>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="py-4">
          <h3 className="font-semibold text-blue-900 mb-2">Instructions:</h3>
          <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
            <li>Go to Base44 Dashboard → Code → Functions</li>
            <li>Click on each function name from the list above</li>
            <li>Copy the entire code (Ctrl+A, Ctrl+C)</li>
            <li>Go to GitHub: github.com/buckeye7066/GrantFlow</li>
            <li>Navigate to functions/ folder, create/edit the file</li>
            <li>Paste the code and commit</li>
            <li>Repeat for all {allItems.length} items in this category</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}