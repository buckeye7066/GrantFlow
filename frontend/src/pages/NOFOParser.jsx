import React, { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sparkles, FileStack, Loader2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

// Components
import ProfileSelector from '@/components/nofo/ProfileSelector';
import InputModeTabs from '@/components/nofo/InputModeTabs';
import ExtractionResultCard from '@/components/nofo/ExtractionResultCard';

// Hooks
import { useNOFOParse } from '@/components/hooks/useNOFOParse';
import { useSaveParsedGrant } from '@/components/hooks/useSaveParsedGrant';

export default function NOFOParser() {
  const [searchParams] = useSearchParams();
  const preselectedOrgId = searchParams.get('organization_id');

  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [inputMode, setInputMode] = useState('file'); // 'file' or 'url'
  const [documentType, setDocumentType] = useState('grant'); // 'grant' or 'debt'

  // Track if we've applied the URL org selection
  const appliedUrlOrg = useRef(false);

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // Fetch organizations with RLS filtering
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Organization.list('-created_date')
        : base44.entities.Organization.filter({ created_by: user?.email }, '-created_date'),
    enabled: !!user?.email,
  });

  // Validate and apply preselectedOrgId from URL only once
  useEffect(() => {
    if (appliedUrlOrg.current || !organizations.length || !preselectedOrgId) return;

    const match = organizations.find(o => o.id === preselectedOrgId);
    if (match) {
      setSelectedOrgId(preselectedOrgId);
    }
    appliedUrlOrg.current = true;
  }, [organizations, preselectedOrgId]);

  // Validate that selectedOrgId is always in the user's organizations
  const validatedOrgId = organizations.some(o => o.id === selectedOrgId) ? selectedOrgId : '';

  // Handle organization change - only allow valid organizations
  const handleOrgChange = (newOrgId) => {
    if (organizations.some(o => o.id === newOrgId)) {
      setSelectedOrgId(newOrgId);
    }
  };

  // NOFO parsing hook
  const {
    file,
    url,
    status,
    error,
    extractedData,
    isProcessing,
    canProcess,
    handleFileChange,
    handleUrlChange,
    processDocument,
  } = useNOFOParse(validatedOrgId, inputMode, documentType);

  // Save parsed grant hook - only allow saving to validated organizations
  const { saveGrant, isSaving } = useSaveParsedGrant(
    extractedData,
    validatedOrgId,
    inputMode === 'url' ? url : ''
  );

  // Loading state
  if (isLoadingUser) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <header className="text-center mb-8">
          <FileStack className="w-12 h-12 mx-auto text-blue-600 mb-4" />
          <h1 className="text-3xl font-bold text-slate-900">NOFO Parser</h1>
          <p className="text-slate-600 mt-2">
            Upload grant PDFs or URLs for instant AI data extraction
          </p>
        </header>

        {/* Setup Card */}
        <Card className="shadow-xl border-0 mb-6">
          <CardHeader>
            <CardTitle>1. Setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <ProfileSelector
              selectedOrgId={validatedOrgId}
              onOrgChange={handleOrgChange}
              organizations={organizations}
              isLoading={isLoadingOrgs}
              disabled={isProcessing}
            />

            <InputModeTabs
              inputMode={inputMode}
              onModeChange={setInputMode}
              file={file}
              onFileChange={handleFileChange}
              url={url}
              onUrlChange={handleUrlChange}
              disabled={isProcessing}
              error={error}
              documentType={documentType}
              onDocumentTypeChange={setDocumentType}
            />

            <div className="flex justify-end">
              <Button
                onClick={processDocument}
                disabled={!canProcess}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                size="lg"
                title={!validatedOrgId ? 'Select a profile first' : 'Process document with AI'}
              >
                <Sparkles className="mr-2 h-5 w-5" />
                {isProcessing ? 'Processing...' : 'Process Document'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Results Card */}
        <ExtractionResultCard
          status={status}
          error={error}
          extractedData={extractedData}
          onSave={documentType === 'grant' ? saveGrant : null}
          isSaving={isSaving}
          documentType={documentType}
        />
      </div>
    </div>
  );
}