import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { createLogger } from '@/utils/logger';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, FileStack, Sparkles, Upload, CheckCircle, AlertTriangle, Info, Link as LinkIcon, ClipboardList, ExternalLink } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useToast } from "@/components/ui/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { parseGrantsGovDigest } from '../../shared/grantsGovDigestParser.js';

const grantSchemaForExtraction = {
  type: "object",
  properties: {
    title: { type: "string" },
    funder: { type: "string" },
    opportunity_number: { type: "string" },
    deadline: { type: "string", format: "date", description: "The application deadline. Standardize to YYYY-MM-DD format." },
    amount_min: { type: "number" },
    amount_max: { type: "number" },
    application_url: { type: "string", description: "The direct URL where applicants submit their application or access the application portal. Must be a full URL starting with http:// or https://." },
    eligibility_summary: { type: "string", description: "A concise summary of who is eligible to apply." },
    applicant_types: { type: "array", items: { type: "string" }, description: "List of eligible applicant types, e.g. ['individual', 'nonprofit', 'small_business', 'veteran', 'student']." },
    program_description: { type: "string", description: "A detailed summary of the grant's purpose and goals." },
    selection_criteria: { type: "string", description: "A summary of how applications will be judged or scored." },
    funder_email: { type: "string", description: "Primary contact email for submissions" },
    funder_phone: { type: "string", description: "Funder contact phone number" },
    funder_fax: { type: "string", description: "Fax number for submissions" },
    funder_address: { type: "string", description: "Physical mailing address for submissions" },
  },
  required: ["title", "funder", "program_description"]
};

function unwrapApiPayload(response) {
  if (response?.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
    return response.data;
  }
  return response;
}

function isRouteNotFoundError(err) {
  return err?.status === 404 || /not found/i.test(String(err?.message || ''));
}

function isValidHttpUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return Boolean(parsed.hostname) && /\./.test(parsed.hostname);
  } catch {
    return false;
  }
}

function buildGrantPayload(extractedData, { organizationId, inputMode, url }) {
  const rawAppUrl = extractedData.application_url || '';
  const validatedAppUrl =
    rawAppUrl.startsWith('http://') || rawAppUrl.startsWith('https://')
      ? rawAppUrl
      : '';

  return {
    ...extractedData,
    application_url: validatedAppUrl,
    organization_id: organizationId,
    status: 'discovered',
    opportunity_type: 'grant',
    ai_status: 'queued',
    url: inputMode === 'url' ? url : (extractedData.url || validatedAppUrl || ''),
    source: extractedData.source || 'grants.gov',
    record_origin: extractedData.record_origin || 'url_import',
    match_decision: null,
    match_explanation: null,
    matched_needs: [],
    eligibility_status: validatedAppUrl ? 'pending' : 'INELIGIBLE',
    ineligibility_reasons: validatedAppUrl ? [] : ['missing_application_url'],
    fingerprints: null,
    matcher_version: null,
    evaluated_at: null,
    match_confidence: null,
  };
}

export default function NOFOParser() {
  const log = useMemo(() => createLogger('NOFOParser'), []);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [inputMode, setInputMode] = useState('file'); // 'file' | 'url' | 'digest'
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [digestText, setDigestText] = useState('');
  const [parsedDigest, setParsedDigest] = useState([]);
  const [digestImportSummary, setDigestImportSummary] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const [isSavingGrant, setIsSavingGrant] = useState(false);
  const [rowActionId, setRowActionId] = useState(null);

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list('-created_date'),
  });

  const validOrganizations = useMemo(
    () => (Array.isArray(organizations) ? organizations.filter((org) => org && org.id) : []),
    [organizations],
  );

  const handleInputModeChange = (value) => {
    if (value) {
      setInputMode(value);
    }
  };

  const handleFileChange = (e) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      const fileName = selectedFile.name.toLowerCase();

      if (!fileName.endsWith('.pdf')) {
        setError('Only PDF files are supported at this time. Please convert your Word document to PDF first.');
        setFile(null);
        return;
      }

      setFile(selectedFile);
      setError(null);
    }
  };

  const saveGrantToPipeline = async (grantPayload) => {
    try {
      const pipelineResult = unwrapApiPayload(
        await client.functions.invoke('saveToProfilePipeline', {
          opportunity: grantPayload,
          organizationId: selectedOrgId,
          source: 'nofo_parser',
        }),
      );

      if (!pipelineResult?.success) {
        const reason =
          pipelineResult?.rejection_reason ||
          pipelineResult?.ineligibility_reasons?.[0] ||
          pipelineResult?.message ||
          'Pipeline rejected this opportunity. Check eligibility criteria.';
        throw new Error(reason);
      }

      return pipelineResult.grant;
    } catch (err) {
      if (!isRouteNotFoundError(err)) throw err;

      log.warn('saveToProfilePipeline route unavailable; falling back to /api/grants/from-opportunity', {
        title: grantPayload.title,
      });

      const fallbackResponse = unwrapApiPayload(
        await client.post('/api/grants/from-opportunity', {
          organization_id: selectedOrgId,
          opportunity_data: {
            title: grantPayload.title,
            sponsor: grantPayload.funder || grantPayload.sponsor,
            application_url: grantPayload.application_url,
            url: grantPayload.url || grantPayload.application_url,
            descriptionMd: grantPayload.program_description,
            source: grantPayload.source || 'grants.gov',
          },
        }),
      );

      // Normalize so callers always get a grant object with an `id`,
      // consistent with the primary pipeline path.
      return fallbackResponse?.grant ?? fallbackResponse;
    }
  };

  const saveAndAnalyzeGrant = async (grantPayload) => {
    const newGrant = await saveGrantToPipeline(grantPayload);

    if (!newGrant?.id) {
      throw new Error('Grant was saved but no valid grant id was returned.');
    }

    const analysisResult = unwrapApiPayload(
      await client.functions.invoke('analyzeGrant', {
        grantId: newGrant.id,
        title: newGrant.title,
        programDescription: newGrant.program_description,
        eligibilitySummary: newGrant.eligibility_summary,
        selectionCriteria: newGrant.selection_criteria,
        awardCeiling: newGrant.amount_max,
        deadline: newGrant.deadline,
      }),
    );

    if (!analysisResult?.success) {
      log.warn('analyzeGrant did not return success — patching record with analysis_failed status', {
        grantId: newGrant.id,
        response: analysisResult,
      });
      await client.entities.Grant.update(newGrant.id, {
        ai_status: 'analysis_failed',
        match_explanation: 'AI analysis could not complete at time of submission. Queued for retry.',
        evaluated_at: new Date().toISOString(),
      }).catch((patchErr) => {
        log.error('Failed to patch grant ai_status after analysis failure', { grantId: newGrant.id, patchErr });
        return null;
      });
      toast({
        variant: 'destructive',
        title: 'Analysis Queued',
        description: `Grant "${newGrant.title}" saved but AI analysis could not start. It will retry automatically.`,
      });
    } else {
      toast({
        title: 'Saved and Analyzing',
        description: `Grant "${newGrant.title}" created and sent for AI analysis.`,
      });
    }

    queryClient.invalidateQueries({ queryKey: ['grants'] });
    return newGrant;
  };

  const handleProcess = async () => {
    if (inputMode === 'file' && !file) {
      setError("Please select a file to process.");
      setStatus('error');
      return;
    }

    if (inputMode === 'url' && !url) {
      setError("Please enter a URL to process.");
      setStatus('error');
      return;
    }

    setError(null);
    setStatus('uploading');
    setExtractedData(null);

    try {
      let fileUrl;

      if (inputMode === 'file') {
        log.debug('Uploading file', file?.name);
        const { file_url } = await client.integrations.Core.UploadFile({ file });
        fileUrl = file_url;
        log.debug('File uploaded', fileUrl);
      } else {
        const trimmedUrl = url.trim();
        if (!isValidHttpUrl(trimmedUrl)) {
          throw new Error('Please enter a valid, fully-qualified URL starting with http:// or https:// (including a valid domain)');
        }
        log.debug('Using URL', trimmedUrl);
        fileUrl = trimmedUrl;
      }

      setStatus('processing');

      log.debug('Invoking parseNOFO');
      const response = await client.functions.invoke('parseNOFO', {
        file_url: fileUrl,
        json_schema: grantSchemaForExtraction,
        is_url: inputMode === 'url'
      });

      log.debug('parseNOFO response received', { success: response?.success });

      const parsed = unwrapApiPayload(response);

      if (!parsed || (!parsed.success && !parsed.output)) {
        const errorMsg =
          parsed?.message || parsed?.details || 'Could not extract data from document';
        throw new Error(errorMsg);
      }

      if (parsed.success && parsed.output) {
        setExtractedData(parsed.output);
        setStatus('success');
        toast({
          title: "Document Processed! ✨",
          description: "Review the extracted information below."
        });
      } else {
        const errorMsg = parsed.message || parsed.details || "Could not extract data from document";
        throw new Error(errorMsg);
      }

    } catch (err) {
      console.error('[NOFOParser] Processing failed:', err);

      let errorMsg = 'An unexpected error occurred while processing the document.';

      if (err.response?.data) {
        if (typeof err.response.data === 'string') {
          errorMsg = err.response.data;
        } else if (err.response.data.message) {
          errorMsg = err.response.data.message;
        } else if (err.response.data.warning) {
          // The backend surfaces a provider-unavailable 503 in `warning`; show it
          // so the user sees "AI provider unavailable" instead of a vague error.
          errorMsg = err.response.data.warning;
        } else if (err.response.data.details) {
          errorMsg = err.response.data.details;
        }
      } else if (err.message) {
        errorMsg = err.message;
      }

      setError(errorMsg);
      setStatus('error');
      toast({
        variant: 'destructive',
        title: 'Processing Failed',
        description: errorMsg
      });
    }
  };

  const handleParseDigest = () => {
    const trimmedDigest = digestText.trim();
    if (!trimmedDigest) {
      setError('Paste Grants.gov listing text before parsing.');
      setStatus('error');
      return;
    }

    setError(null);
    setStatus('processing');
    setParsedDigest([]);
    setDigestImportSummary(null);
    setExtractedData(null);

    const parsed = parseGrantsGovDigest(trimmedDigest);
    if (!parsed.opportunities.length) {
      const errorMsg = parsed.parse_errors[0] || 'No Grants.gov listings found in pasted text';
      setError(errorMsg);
      setStatus('error');
      toast({ variant: 'destructive', title: 'Parse Failed', description: errorMsg });
      return;
    }

    setParsedDigest(parsed.opportunities);
    setStatus('success');

    toast({
      title: 'Listings Parsed',
      description: `Found ${parsed.opportunities.length} Grants.gov opportunit${parsed.opportunities.length === 1 ? 'y' : 'ies'}.`,
    });

    if (parsed.parse_errors.length) {
      log.warn('Grants.gov digest parse warnings', parsed.parse_errors);
    }
  };

  const handleImportAllDigest = async () => {
    const trimmedDigest = digestText.trim();
    const opportunities = parsedDigest.length
      ? parsedDigest
      : (trimmedDigest ? parseGrantsGovDigest(trimmedDigest).opportunities : []);

    if (!opportunities.length) {
      toast({ variant: 'destructive', title: 'Nothing to import', description: 'Parse listing text first.' });
      return;
    }
    if (!selectedOrgId) {
      toast({
        variant: 'destructive',
        title: 'Select a profile to import',
        description: 'Choose a profile before importing opportunities into the pipeline.',
      });
      return;
    }

    setIsSavingGrant(true);
    setError(null);

    const results = [];
    let savedCount = 0;

    try {
      for (const opp of opportunities) {
        const grantPayload = buildGrantPayload(opp, {
          organizationId: selectedOrgId,
          inputMode: 'digest',
          url: opp.application_url,
        });

        try {
          await saveGrantToPipeline(grantPayload);
          savedCount += 1;
          results.push({ opportunity_id: opp.opportunity_id, title: opp.title, saved: true });
        } catch (err) {
          results.push({
            opportunity_id: opp.opportunity_id,
            title: opp.title,
            saved: false,
            reason: err.message || 'Save failed',
          });
        }
      }

      const summary = {
        total_parsed: opportunities.length,
        saved_count: savedCount,
        results,
        failures: results.filter((r) => !r.saved),
      };
      setDigestImportSummary(summary);
      queryClient.invalidateQueries({ queryKey: ['grants'] });

      const failureCount = summary.failures.length;
      toast({
        variant: failureCount ? 'destructive' : undefined,
        title: 'Import Complete',
        description: failureCount
          ? `Saved ${savedCount} of ${opportunities.length}. ${failureCount} failed — see summary for details.`
          : `Saved ${savedCount} of ${opportunities.length} opportunities to the pipeline.`,
      });
    } catch (err) {
      const errorMsg = err.message || 'Failed to import listings';
      setError(errorMsg);
      toast({ variant: 'destructive', title: 'Import Failed', description: errorMsg });
    } finally {
      setIsSavingGrant(false);
    }
  };

  const handleQuickAddDigestRow = async (opp) => {
    if (!selectedOrgId) {
      toast({
        variant: 'destructive',
        title: 'Select a profile to save',
        description: 'Choose a profile before adding an opportunity to the pipeline.',
      });
      return;
    }

    setRowActionId(opp.opportunity_id);
    setError(null);

    try {
      const grantPayload = buildGrantPayload(opp, {
        organizationId: selectedOrgId,
        inputMode: 'digest',
        url: opp.application_url,
      });
      const newGrant = await saveAndAnalyzeGrant(grantPayload);
      navigate(createPageUrl('GrantDetail', { id: newGrant.id }));
    } catch (err) {
      const errorMsg = err.message || 'Failed to save opportunity';
      setError(errorMsg);
      toast({ variant: 'destructive', title: 'Save Failed', description: errorMsg });
    } finally {
      setRowActionId(null);
    }
  };

  const handleFullParseDigestRow = async (opp) => {
    if (!opp.application_url) {
      toast({
        variant: 'destructive',
        title: 'No URL available',
        description: 'This listing does not have a Grants.gov detail URL to parse.',
      });
      return;
    }

    setInputMode('url');
    setUrl(opp.application_url);
    setExtractedData(null);
    setError(null);
    setStatus('idle');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast({
      title: 'Ready for full AI parse',
      description: 'Click "Process Document" to extract full details from this Grants.gov page.',
    });
  };

  const handleSaveToPipeline = async () => {
    if (!extractedData) return;
    if (!selectedOrgId) {
      toast({
        variant: 'destructive',
        title: 'Select a profile to save',
        description: 'You can process a document without a profile, but saving into the pipeline requires selecting one.',
      });
      return;
    }
    setIsSavingGrant(true);
    setError(null);

    const grantPayload = buildGrantPayload(extractedData, {
      organizationId: selectedOrgId,
      inputMode,
      url,
    });

    if (!grantPayload.application_url) {
      log.warn('NOFOParser: no valid application_url extracted — grant will be marked ineligible (missing_application_url)', {
        title: extractedData.title,
        raw: extractedData.application_url,
      });
    }

    try {
      const newGrant = await saveAndAnalyzeGrant(grantPayload);
      navigate(createPageUrl("GrantDetail", { id: newGrant.id }));
    } catch (err) {
      const errorMessage = `Failed to save grant or start analysis: ${err.message}`;
      setError(errorMessage);
      setStatus('error');
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsSavingGrant(false);
    }
  };

  const isProcessing = status === 'uploading' || status === 'processing';
  const canProcess =
    ((inputMode === 'file' && file) || (inputMode === 'url' && url.trim()) || (inputMode === 'digest' && digestText.trim())) &&
    !isProcessing;

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <FileStack className="w-12 h-12 mx-auto text-blue-600 mb-4" />
          <h1 className="text-3xl font-bold text-slate-900">NOFO Parser</h1>
          <p className="text-slate-600 mt-2">
            Upload a grant PDF, enter a URL, or paste Grants.gov listings from any source to extract and import opportunities.
          </p>
        </div>

        <Card className="shadow-xl border-0">
          <CardHeader>
            <CardTitle>1. Setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <Label className="text-base font-semibold mb-2 block">Link to Profile (optional)</Label>
              <Select value={selectedOrgId} onValueChange={setSelectedOrgId} disabled={isProcessing || isSavingGrant}>
                <SelectTrigger className="text-base h-12 mt-2">
                  <SelectValue placeholder="Optional: select a profile to save into its pipeline..." />
                </SelectTrigger>
                <SelectContent>
                  {isLoadingOrgs ? (
                    <div className="flex items-center justify-center p-4"><Loader2 className="w-5 h-5 animate-spin" /></div>
                  ) : (
                    validOrganizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-base font-semibold mb-3 block">Choose Input Method</Label>
              <Tabs value={inputMode} onValueChange={handleInputModeChange} className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="file" disabled={isProcessing}>
                    <Upload className="w-4 h-4 mr-2" />
                    Upload PDF
                  </TabsTrigger>
                  <TabsTrigger value="url" disabled={isProcessing}>
                    <LinkIcon className="w-4 h-4 mr-2" />
                    Enter URL
                  </TabsTrigger>
                  <TabsTrigger value="digest" disabled={isProcessing}>
                    <ClipboardList className="w-4 h-4 mr-2" />
                    Paste Listings
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="file" className="mt-4">
                  <Alert className="mb-4 border-blue-200 bg-blue-50">
                    <Info className="h-4 w-4 text-blue-600" />
                    <AlertTitle className="text-blue-900">PDF Files Only</AlertTitle>
                    <AlertDescription className="text-blue-800">
                      Currently, only PDF documents are supported. If you have a Word document (.docx), please convert it to PDF first.
                    </AlertDescription>
                  </Alert>

                  <div className="border-2 border-dashed rounded-xl p-8 text-center hover:border-blue-300 transition-colors">
                    <input
                      type="file"
                      id="file-upload"
                      className="hidden"
                      accept=".pdf,application/pdf"
                      onChange={handleFileChange}
                      disabled={isProcessing}
                    />
                    <label
                      htmlFor="file-upload"
                      className="cursor-pointer flex flex-col items-center"
                    >
                      {file ? (
                        <>
                          <CheckCircle className="w-8 h-8 text-emerald-500 mb-2" />
                          <p className="text-slate-800 font-medium">{file.name}</p>
                          <p className="text-xs text-slate-400 mt-1">Click to change file</p>
                        </>
                      ) : (
                        <>
                          <Upload className="w-8 h-8 text-slate-400 mb-2"/>
                          <p className="text-slate-500">Click to select a PDF file</p>
                          <p className="text-xs text-slate-400 mt-1">Only PDF format supported</p>
                        </>
                      )}
                    </label>
                  </div>
                </TabsContent>

                <TabsContent value="url" className="mt-4">
                  <Alert className="mb-4 border-green-200 bg-green-50">
                    <Info className="h-4 w-4 text-green-600" />
                    <AlertTitle className="text-green-900">URL Processing</AlertTitle>
                    <AlertDescription className="text-green-800">
                      Enter the direct URL to a grant opportunity webpage. The AI will fetch and extract information from the page.
                    </AlertDescription>
                  </Alert>

                  <div className="space-y-2">
                    <Label htmlFor="url-input">Grant Opportunity URL</Label>
                    <Input
                      id="url-input"
                      type="url"
                      placeholder="https://example.com/grant-opportunity"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      disabled={isProcessing}
                      className="text-base h-12"
                    />
                    <p className="text-xs text-slate-500">
                      Enter a complete URL including http:// or https://
                    </p>
                  </div>
                </TabsContent>

                <TabsContent value="digest" className="mt-4">
                  <Alert className="mb-4 border-amber-200 bg-amber-50">
                    <Info className="h-4 w-4 text-amber-600" />
                    <AlertTitle className="text-amber-900">Grants.gov Listings</AlertTitle>
                    <AlertDescription className="text-amber-800">
                      Paste grant listings from any source — email, document, spreadsheet, or website. Each entry needs a Grants.gov detail URL (<code className="text-xs">search-results-detail/&#123;id&#125;</code>). Multi-line and slash-separated formats both work.
                    </AlertDescription>
                  </Alert>

                  <div className="space-y-2">
                    <Label htmlFor="digest-input">Listing Text</Label>
                    <Textarea
                      id="digest-input"
                      placeholder="Paste Grants.gov listings here (multi-line or slash-separated)..."
                      value={digestText}
                      onChange={(e) => setDigestText(e.target.value)}
                      disabled={isProcessing}
                      className="min-h-[240px] text-sm"
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </div>

            <div className="flex justify-end gap-3">
              {inputMode === 'digest' && parsedDigest.length > 0 && (
                <Button
                  onClick={handleImportAllDigest}
                  disabled={isSavingGrant || !selectedOrgId}
                  variant="outline"
                  size="lg"
                >
                  {isSavingGrant ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <CheckCircle className="mr-2 h-5 w-5" />}
                  Import All to Pipeline
                </Button>
              )}
              <Button
                onClick={inputMode === 'digest' ? handleParseDigest : handleProcess}
                disabled={!canProcess}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                size="lg"
              >
                {isProcessing ?
                 <Loader2 className="w-5 h-5 mr-2 animate-spin" /> :
                 <Sparkles className="mr-2 h-5 w-5" />}
                {isProcessing
                  ? 'Processing...'
                  : inputMode === 'digest'
                    ? 'Parse Listings'
                    : 'Process Document'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {(status !== 'idle' || parsedDigest.length > 0) && (
            <Card className="mt-8 shadow-xl border-0">
                <CardHeader>
                    <CardTitle className="flex items-center">
                        {status === 'uploading' && <><Loader2 className="w-6 h-6 mr-2 animate-spin" /> {inputMode === 'file' ? 'Uploading file...' : 'Fetching URL...'}</>}
                        {status === 'processing' && <><Loader2 className="w-6 h-6 mr-2 animate-spin" /> {inputMode === 'digest' ? 'Parsing listings...' : 'AI is reading the document...'}</>}
                        {status === 'success' && inputMode !== 'digest' && <><CheckCircle className="w-6 h-6 mr-2 text-emerald-500" /> Extraction Complete!</>}
                        {status === 'success' && inputMode === 'digest' && <><CheckCircle className="w-6 h-6 mr-2 text-emerald-500" /> Listings Parsed ({parsedDigest.length})</>}
                        {status === 'error' && <><AlertTriangle className="w-6 h-6 mr-2 text-red-500" /> Processing Failed</>}
                    </CardTitle>
                </CardHeader>
                {error && (
                    <CardContent>
                        <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertTitle>Error</AlertTitle>
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    </CardContent>
                )}

                {inputMode === 'digest' && parsedDigest.length > 0 && (
                  <CardContent className="space-y-4">
                    {digestImportSummary && (
                      <Alert className={digestImportSummary.failures?.length ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}>
                        <CheckCircle className={`h-4 w-4 ${digestImportSummary.failures?.length ? 'text-amber-600' : 'text-emerald-600'}`} />
                        <AlertTitle className={digestImportSummary.failures?.length ? 'text-amber-900' : 'text-emerald-900'}>Import Summary</AlertTitle>
                        <AlertDescription className={digestImportSummary.failures?.length ? 'text-amber-800' : 'text-emerald-800'}>
                          Saved {digestImportSummary.saved_count} of {digestImportSummary.total_parsed} opportunities to the pipeline.
                          {digestImportSummary.failures?.length > 0 && (
                            <div className="mt-2">
                              <p className="font-semibold">Failed ({digestImportSummary.failures.length}):</p>
                              <ul className="list-disc pl-5 mt-1 space-y-1">
                                {digestImportSummary.failures.map((failure, idx) => (
                                  <li key={`${failure.opportunity_id || 'unknown'}-${idx}`} className="text-sm">
                                    <span className="font-medium">{failure.title || failure.opportunity_id || 'Untitled'}</span>
                                    {failure.reason ? ` — ${failure.reason}` : ''}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="overflow-x-auto border rounded-lg">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-50 text-left">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Agency</th>
                            <th className="px-3 py-2 font-semibold">Title</th>
                            <th className="px-3 py-2 font-semibold">Notice</th>
                            <th className="px-3 py-2 font-semibold">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parsedDigest.map((opp, index) => (
                            <tr key={`${opp.opportunity_id || 'opp'}-${index}`} className="border-t align-top">
                              <td className="px-3 py-3 whitespace-nowrap">
                                <div className="font-medium">{opp.agency_acronym || '—'}</div>
                                <div className="text-xs text-slate-500 max-w-[180px]">{opp.funder}</div>
                              </td>
                              <td className="px-3 py-3">
                                <div className="font-medium text-slate-800">{opp.title}</div>
                                {opp.application_url && (
                                  <a
                                    href={opp.application_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center text-xs text-blue-600 hover:underline mt-1"
                                  >
                                    View on Grants.gov <ExternalLink className="w-3 h-3 ml-1" />
                                  </a>
                                )}
                              </td>
                              <td className="px-3 py-3 whitespace-nowrap capitalize">
                                {opp.notice_type ? `${opp.notice_type} ${opp.notice_number}` : 'Listing'}
                              </td>
                              <td className="px-3 py-3 whitespace-nowrap">
                                <div className="flex flex-col gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleQuickAddDigestRow(opp)}
                                    disabled={rowActionId === opp.opportunity_id || isSavingGrant}
                                  >
                                    {rowActionId === opp.opportunity_id ? (
                                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                                    ) : null}
                                    Quick Add
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleFullParseDigestRow(opp)}
                                  >
                                    Full AI Parse
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                )}

                {extractedData && status === 'success' && inputMode !== 'digest' && (
                    <CardContent className="space-y-4">
                        <h3 className="text-lg font-semibold text-slate-800 border-b pb-2">Extracted Information</h3>
                        <div className="space-y-3">
                            <p><strong>Title:</strong> {extractedData.title || 'N/A'}</p>
                            <p><strong>Funder:</strong> {extractedData.funder || 'N/A'}</p>
                            {(() => {
  const dl = extractedData.deadline;
  // Parse date-only strings as end-of-day local time to avoid timezone-induced false positives.
  let isPast = false;
  if (dl) {
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(dl).trim());
    const parsed = isDateOnly ? new Date(`${String(dl).trim()}T23:59:59`) : new Date(dl);
    isPast = !isNaN(parsed.getTime()) && parsed < new Date();
  }
  return (
    <p>
      <strong>Deadline:</strong>{' '}
      {dl || 'N/A'}
      {isPast && (
        <span className="ml-2 text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded">
          Deadline has passed - this opportunity may be rejected by the pipeline
        </span>
      )}
    </p>
  );
})()}
                            <p><strong>Opportunity #:</strong> {extractedData.opportunity_number || 'N/A'}</p>
                            <p><strong>Award Range:</strong> ${extractedData.amount_min?.toLocaleString() || 'N/A'} - ${extractedData.amount_max?.toLocaleString() || 'N/A'}</p>
                            {extractedData.funder_email && <p><strong>Email:</strong> {extractedData.funder_email}</p>}
                            {extractedData.funder_phone && <p><strong>Phone:</strong> {extractedData.funder_phone}</p>}
                            {extractedData.funder_fax && <p><strong>Fax:</strong> {extractedData.funder_fax}</p>}
                            {extractedData.funder_address && <p><strong>Address:</strong> {extractedData.funder_address}</p>}
                            <div className="space-y-1">
                                <p className="font-semibold">Description:</p>
                                <p className="text-sm text-slate-600 bg-slate-50 p-3 rounded-md">{extractedData.program_description || 'N/A'}</p>
                            </div>
                             <div className="space-y-1">
                                <p className="font-semibold">Eligibility:</p>
                                <p className="text-sm text-slate-600 bg-slate-50 p-3 rounded-md">{extractedData.eligibility_summary || 'N/A'}</p>
                            </div>
                        </div>
                        <div className="flex justify-end pt-4 border-t">
                            <Button
                                onClick={handleSaveToPipeline}
                                disabled={isSavingGrant}
                                className="bg-emerald-600 hover:bg-emerald-700"
                            >
                                {isSavingGrant ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-2" />}
                                Save to Pipeline
                            </Button>
                        </div>
                    </CardContent>
                )}
            </Card>
        )}
      </div>
    </div>
  );
}
