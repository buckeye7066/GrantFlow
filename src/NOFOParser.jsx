
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Loader2, FileStack, Sparkles, Upload, CheckCircle, AlertTriangle, Info, Link as LinkIcon } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useToast } from "@/components/ui/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const grantSchemaForExtraction = {
  type: "object",
  properties: {
    title: { type: "string" },
    funder: { type: "string" },
    opportunity_number: { type: "string" },
    deadline: { type: "string", format: "date", description: "The application deadline. Standardize to YYYY-MM-DD format." },
    award_floor: { type: "number" },
    award_ceiling: { type: "number" },
    eligibility_summary: { type: "string", description: "A concise summary of who is eligible to apply." },
    program_description: { type: "string", description: "A detailed summary of the grant's purpose and goals." },
    selection_criteria: { type: "string", description: "A summary of how applications will be judged or scored." },
    funder_email: { type: "string", description: "Primary contact email for submissions" },
    funder_phone: { type: "string", description: "Funder contact phone number" },
    funder_fax: { type: "string", description: "Fax number for submissions" },
    funder_address: { type: "string", description: "Physical mailing address for submissions" },
  },
  required: ["title", "funder", "program_description"]
};

export default function NOFOParser() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [inputMode, setInputMode] = useState('file'); // 'file' or 'url'
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const [isSavingGrant, setIsSavingGrant] = useState(false);

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('-created_date'),
  });

  const handleFileChange = (e) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      const fileName = selectedFile.name.toLowerCase();
      
      // Only accept PDF files
      if (!fileName.endsWith('.pdf')) {
        setError('Only PDF files are supported at this time. Please convert your Word document to PDF first.');
        setFile(null);
        return;
      }
      
      setFile(selectedFile);
      setError(null);
    }
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

    // Clear any previous errors
    setError(null);
    setStatus('uploading');
    setExtractedData(null);

    try {
      let fileUrl;
      
      if (inputMode === 'file') {
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        fileUrl = file_url;
      } else {
        // URL mode - validate URL format
        const trimmedUrl = url.trim();
        if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
          throw new Error('Please enter a valid URL starting with http:// or https://');
        }
        fileUrl = trimmedUrl;
      }

      setStatus('processing');

      // Use custom parseNOFO function
      const response = await base44.functions.invoke('parseNOFO', {
        file_url: fileUrl,
        json_schema: grantSchemaForExtraction,
        is_url: inputMode === 'url'
      });

      if (response.data.success && response.data.output) {
        setExtractedData(response.data.output);
        setStatus('success');
        toast({
          title: "Document Processed! ✨",
          description: "Review the extracted information below."
        });
      } else {
        const errorMsg = response.data.message || response.data.details || "Could not extract data from document";
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

    const grantPayload = {
        ...extractedData,
        organization_id: selectedOrgId,
        status: 'discovered',
        opportunity_type: 'grant',
        ai_status: 'queued',
        url: inputMode === 'url' ? url : (extractedData.url || ''),
    };

    try {
        const newGrant = await base44.entities.Grant.create(grantPayload);

        const analysisPayload = {
            grantId: newGrant.id,
            title: newGrant.title,
            programDescription: newGrant.program_description,
            eligibilitySummary: newGrant.eligibility_summary,
            selectionCriteria: newGrant.selection_criteria,
            awardCeiling: newGrant.award_ceiling,
            deadline: newGrant.deadline,
        };

        await base44.functions.invoke('analyzeGrant', analysisPayload);

        queryClient.invalidateQueries({ queryKey: ['grants'] });
        toast({
            title: "Saved and Analyzing",
            description: `Grant "${newGrant.title}" created and sent for AI analysis.`,
        });

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

  // Determine if button should be enabled
  const isProcessing = status === 'uploading' || status === 'processing';
  const canProcess =
    ((inputMode === 'file' && file) || (inputMode === 'url' && url.trim())) && !isProcessing;

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <FileStack className="w-12 h-12 mx-auto text-blue-600 mb-4" />
          <h1 className="text-3xl font-bold text-slate-900">NOFO Parser</h1>
          <p className="text-slate-600 mt-2">Upload a grant opportunity PDF or provide a URL, and let AI extract the key information instantly.</p>
        </div>

        <Card className="shadow-xl border-0">
          <CardHeader>
            <CardTitle>1. Setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <Label className="text-base font-semibold mb-2 block">Link to Profile (optional)</Label>
              <Select value={selectedOrgId} onValueChange={setSelectedOrgId} disabled={isProcessing}>
                <SelectTrigger className="text-base h-12 mt-2">
                  <SelectValue placeholder="Optional: select a profile to save into its pipeline..." />
                </SelectTrigger>
                <SelectContent>
                  {isLoadingOrgs ? (
                    <div className="flex items-center justify-center p-4"><Loader2 className="w-5 h-5 animate-spin" /></div>
                  ) : (
                    organizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <Label className="text-base font-semibold mb-3 block">Choose Input Method</Label>
              <Tabs value={inputMode} onValueChange={setInputMode} className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="file" disabled={isProcessing}>
                    <Upload className="w-4 h-4 mr-2" />
                    Upload PDF
                  </TabsTrigger>
                  <TabsTrigger value="url" disabled={isProcessing}>
                    <LinkIcon className="w-4 h-4 mr-2" />
                    Enter URL
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
              </Tabs>
            </div>
            
            <div className="flex justify-end">
              <Button
                onClick={handleProcess}
                disabled={!canProcess}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                size="lg"
              >
                {isProcessing ?
                 <Loader2 className="w-5 h-5 mr-2 animate-spin" /> :
                 <Sparkles className="mr-2 h-5 w-5" />}
                {isProcessing ? 'Processing...' : 'Process Document'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {(status !== 'idle') && (
            <Card className="mt-8 shadow-xl border-0">
                <CardHeader>
                    <CardTitle className="flex items-center">
                        {status === 'uploading' && <><Loader2 className="w-6 h-6 mr-2 animate-spin" /> {inputMode === 'file' ? 'Uploading file...' : 'Fetching URL...'}</>}
                        {status === 'processing' && <><Loader2 className="w-6 h-6 mr-2 animate-spin" /> AI is reading the document...</>}
                        {status === 'success' && <><CheckCircle className="w-6 h-6 mr-2 text-emerald-500" /> Extraction Complete!</>}
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
                {extractedData && status === 'success' && (
                    <CardContent className="space-y-4">
                        <h3 className="text-lg font-semibold text-slate-800 border-b pb-2">Extracted Information</h3>
                        <div className="space-y-3">
                            <p><strong>Title:</strong> {extractedData.title || 'N/A'}</p>
                            <p><strong>Funder:</strong> {extractedData.funder || 'N/A'}</p>
                            <p><strong>Deadline:</strong> {extractedData.deadline || 'N/A'}</p>
                            <p><strong>Opportunity #:</strong> {extractedData.opportunity_number || 'N/A'}</p>
                            <p><strong>Award Range:</strong> ${extractedData.award_floor?.toLocaleString() || 'N/A'} - ${extractedData.award_ceiling?.toLocaleString() || 'N/A'}</p>
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
