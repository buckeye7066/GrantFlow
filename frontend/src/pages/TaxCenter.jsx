import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Upload,
  Loader2,
  DollarSign,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Download,
  Trash2,
  Calculator,
  TrendingUp,
  Brain,
  Shield,
  Building2,
  AlertCircle,
  Sparkles,
  Send,
  Eye,
  RefreshCw,
  Link as LinkIcon,
  Mail,
  CheckSquare,
  Printer
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import MailingInstructions from '@/components/tax/MailingInstructions';
import { useRLSOrganizations, useRLSFilter } from '@/components/hooks/useAuthRLS';

/**
 * Tax Center - Document Upload and AI Tax Optimization
 *
 * IMPORTANT LEGAL DISCLAIMER:
 * This tool is for informational and organizational purposes only.
 * It is NOT a substitute for professional tax advice.
 * Always consult a licensed tax professional or CPA before filing.
 */
export default function TaxCenter() {
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [uploadingDoc, setUploadingDoc] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [generatingReturn, setGeneratingReturn] = useState(false);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [connectionForm, setConnectionForm] = useState({
    institution_name: '',
    institution_email: '',
    connection_type: 'employer_w2'
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // RLS-safe organizations
  const { 
    data: organizations = [], 
    isLoadingUser 
  } = useRLSOrganizations();

  // Auto-select first org
  React.useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      setSelectedOrgId(organizations[0].id);
    }
  }, [organizations, selectedOrgId]);

  const selectedOrg = organizations.find(o => o.id === selectedOrgId);

  // RLS-safe tax documents
  const { data: taxDocuments = [] } = useRLSFilter(
    'TaxDocument',
    { organization_id: selectedOrgId, tax_year: selectedYear },
    { enabled: !!selectedOrgId }
  );

  // RLS-safe tax profiles
  const { data: taxProfiles = [] } = useRLSFilter(
    'TaxProfile',
    { organization_id: selectedOrgId, tax_year: selectedYear },
    { enabled: !!selectedOrgId }
  );

  const taxProfile = taxProfiles[0];

  // RLS-safe tax returns
  const { data: taxReturns = [] } = useRLSFilter(
    'TaxReturn',
    { organization_id: selectedOrgId, tax_year: selectedYear },
    { enabled: !!selectedOrgId }
  );

  const taxReturn = taxReturns[0];

  // RLS-safe document connections
  const { data: connections = [] } = useRLSFilter(
    'TaxDocumentConnection',
    { organization_id: selectedOrgId },
    { enabled: !!selectedOrgId }
  );

  // Upload mutation
  const uploadDocumentMutation = useMutation({
    mutationFn: async ({ file, documentType }) => {
      // Upload file
      const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file });

      // Extract data from document
      const extractionResult = await base44.integrations.Core.ExtractDataFromUploadedFile({
        file_url: file_uri,
        json_schema: {
          type: "object",
          properties: {
            issuer_name: { type: "string" },
            issuer_ein: { type: "string" },
            total_amount: { type: "number" },
            tax_year: { type: "number" },
            additional_data: { type: "object" }
          }
        }
      });

      // Handle nested extraction result structure
      const fields = extractionResult.output?.fields || extractionResult.output || {};
      const extractedData = {
        issuer_name: fields.issuer_name?.value ?? fields.issuer_name ?? '',
        issuer_ein: fields.issuer_ein?.value ?? fields.issuer_ein ?? '',
        total_amount: fields.total_amount?.value ?? fields.total_amount ?? 0,
        tax_year: fields.tax_year?.value ?? fields.tax_year ?? selectedYear,
        additional_data: fields.additional_data?.value ?? fields.additional_data ?? {}
      };

      // Create tax document record
      return await base44.entities.TaxDocument.create({
        organization_id: selectedOrgId,
        tax_year: selectedYear,
        document_type: documentType,
        file_uri: file_uri,
        issuer_name: extractedData.issuer_name,
        issuer_ein: extractedData.issuer_ein,
        amount: extractedData.total_amount,
        parsed_data: extractedData.additional_data,
        verification_status: 'processing'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxDocuments'] });
      setUploadingDoc(null);

      toast({
        title: '✅ Document Uploaded',
        description: 'Tax document uploaded and processed successfully',
      });
    },
    onError: (error) => {
      setUploadingDoc(null);
      toast({
        variant: 'destructive',
        title: 'Upload Failed',
        description: error.message,
      });
    }
  });

  // Delete mutation
  const deleteDocumentMutation = useMutation({
    mutationFn: (id) => base44.entities.TaxDocument.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxDocuments'] });
      toast({
        title: '🗑️ Document Deleted',
        description: 'Tax document removed',
      });
    }
  });

  // Analyze mutation
  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const response = await base44.functions.invoke('analyzeTaxSituation', {
        organization_id: selectedOrgId,
        tax_year: selectedYear
      });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['taxProfile'] });

      const loopholeCount = data.analysis_summary?.advanced_loopholes || 0;

      toast({
        title: '✅ Tax Analysis Complete',
        description: `Found ${data.analysis_summary.total_opportunities} opportunities including ${loopholeCount} advanced strategies. Potential savings: $${data.total_potential_savings.toLocaleString()}`,
        duration: 8000,
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Analysis Failed',
        description: error.message,
      });
    }
  });

  // Generate tax return mutation
  const generateReturnMutation = useMutation({
    mutationFn: async () => {
      const response = await base44.functions.invoke('generateTaxReturn', {
        organization_id: selectedOrgId,
        tax_year: selectedYear
      });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['taxReturn'] });

      toast({
        title: '✅ Tax Return Generated',
        description: `Forms ready for review. ${data.warnings.length > 0 ? `${data.warnings.length} warnings found.` : 'No issues detected.'}`,
        duration: 6000,
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message,
      });
    }
  });

  // Request documents mutation
  const requestDocsMutation = useMutation({
    mutationFn: async (data) => {
      const response = await base44.functions.invoke('requestTaxDocuments', {
        organization_id: selectedOrgId,
        institution_name: data.institution_name,
        institution_email: data.institution_email,
        connection_type: data.connection_type,
        tax_year: selectedYear
      });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['taxConnections'] });
      setShowConnectDialog(false);
      setConnectionForm({
        institution_name: '',
        institution_email: '',
        connection_type: 'employer_w2'
      });

      toast({
        title: '✅ Request Sent',
        description: data.message,
        duration: 6000,
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Request Failed',
        description: error.message,
      });
    }
  });

  // Export for tax software mutation
  const exportMutation = useMutation({
    mutationFn: async (format) => {
      const response = await base44.functions.invoke('exportForTaxSoftware', {
        tax_return_id: taxReturn.id,
        export_format: format
      });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data) => {
      window.open(data.download_url, '_blank');

      toast({
        title: '✅ Export Ready',
        description: data.message,
        duration: 5000,
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Export Failed',
        description: error.message,
      });
    }
  });

  const handleFileUpload = async (e, documentType) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadingDoc(documentType);
    uploadDocumentMutation.mutate({ file, documentType });
  };

  const handleAnalyze = () => {
    setIsAnalyzing(true);
    analyzeMutation.mutate();
  };

  React.useEffect(() => {
    if (!analyzeMutation.isPending) {
      setIsAnalyzing(false);
    }
  }, [analyzeMutation.isPending]);

  const handleGenerateReturn = () => {
    if (!taxProfile) {
      toast({
        variant: 'destructive',
        title: 'Run Analysis First',
        description: 'You need to run AI analysis before generating tax forms',
      });
      return;
    }

    setGeneratingReturn(true);
    generateReturnMutation.mutate();
  };

  React.useEffect(() => {
    if (!generateReturnMutation.isPending) {
      setGeneratingReturn(false);
    }
  }, [generateReturnMutation.isPending]);

  const handleDownloadPDF = async () => {
    if (!taxReturn?.generated_pdf_uri) return;

    try {
      const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({
        file_uri: taxReturn.generated_pdf_uri,
        expires_in: 300
      });

      window.open(signed_url, '_blank');
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Download Failed',
        description: error.message,
      });
    }
  };

  const handleRequestDocuments = () => {
    requestDocsMutation.mutate(connectionForm);
  };

  const handleExport = (format) => {
    exportMutation.mutate(format);
  };

  // Separate standard and advanced recommendations
  const standardRecommendations = React.useMemo(() => {
    return (taxProfile?.ai_recommendations || []).filter(rec => rec.type === 'standard');
  }, [taxProfile]);

  const advancedLoopholes = React.useMemo(() => {
    return (taxProfile?.ai_recommendations || []).filter(rec => rec.type === 'advanced_loophole');
  }, [taxProfile]);

  // Group documents by type
  const documentsByType = React.useMemo(() => {
    return taxDocuments.reduce((acc, doc) => {
      if (!acc[doc.document_type]) {
        acc[doc.document_type] = [];
      }
      acc[doc.document_type].push(doc);
      return acc;
    }, {});
  }, [taxDocuments]);

  // Calculate totals
  const totalIncome = React.useMemo(() => {
    return taxDocuments
      .filter(doc => ['w2', '1099_nec', '1099_misc', '1099_int', '1099_div'].includes(doc.document_type))
      .reduce((sum, doc) => sum + (doc.amount || 0), 0);
  }, [taxDocuments]);

  const DOCUMENT_TYPES = [
    { value: 'w2', label: 'W-2 (Wages)', icon: FileText },
    { value: '1099_nec', label: '1099-NEC (Self-Employment)', icon: Building2 },
    { value: '1099_misc', label: '1099-MISC (Other Income)', icon: DollarSign },
    { value: '1099_int', label: '1099-INT (Interest)', icon: TrendingUp },
    { value: '1099_div', label: '1099-DIV (Dividends)', icon: TrendingUp },
    { value: '1099_b', label: '1099-B (Investment Sales)', icon: TrendingUp },
    { value: '1098_t', label: '1098-T (Tuition)', icon: FileText },
    { value: '1098', label: '1098 (Mortgage Interest)', icon: FileText },
    { value: 'receipt_charitable', label: 'Charitable Donation Receipts', icon: FileText },
    { value: 'receipt_medical', label: 'Medical Expense Receipts', icon: FileText },
    { value: 'receipt_business', label: 'Business Expense Receipts', icon: FileText },
  ];

  const CONNECTION_TYPES = [
    { value: 'employer_w2', label: 'Employer (W-2)', icon: Building2 },
    { value: 'bank_1099_int', label: 'Bank (1099-INT Interest)', icon: DollarSign },
    { value: 'brokerage_1099_div', label: 'Brokerage (1099-DIV Dividends)', icon: TrendingUp },
    { value: 'brokerage_1099_b', label: 'Brokerage (1099-B Sales)', icon: TrendingUp },
    { value: 'mortgage_1098', label: 'Mortgage (1098 Interest)', icon: FileText },
    { value: 'student_loan_1098e', label: 'Student Loan (1098-E)', icon: FileText },
    { value: 'university_1098t', label: 'University (1098-T Tuition)', icon: FileText },
  ];

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* LEGAL DISCLAIMER */}
        <Alert className="mb-8 bg-amber-50 border-amber-300">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
          <AlertDescription className="text-amber-900">
            <strong className="block mb-2 text-lg">⚠️ IMPORTANT LEGAL DISCLAIMER</strong>
            <p className="mb-2">
              This tool is for <strong>informational and organizational purposes only</strong>.
              It is NOT a substitute for professional tax advice, tax preparation services, or filing assistance.
            </p>
            <p className="mb-2">
              Tax laws are complex and vary by jurisdiction. This AI analysis may not account for all
              circumstances, recent law changes, or specific situations.
            </p>
            <p className="font-semibold">
              ✅ ALWAYS consult a licensed tax professional, CPA, or Enrolled Agent before making tax decisions or filing returns.
            </p>
          </AlertDescription>
        </Alert>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Calculator className="w-8 h-8 text-green-600" />
            Tax Optimization Center
          </h1>
          <p className="text-slate-600 mt-2">
            Tax document organization and optimization analysis
          </p>
        </div>

        {/* Configuration */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Tax Filing Selection</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label>Profile / Individual</Label>
                <Select value={selectedOrgId || ''} onValueChange={setSelectedOrgId}>
                  <SelectTrigger className="mt-2">
                    <SelectValue placeholder="Select profile..." />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Tax Year</Label>
                <Select value={String(selectedYear)} onValueChange={(val) => setSelectedYear(parseInt(val))}>
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[2024, 2023, 2022, 2021, 2020].map(year => (
                      <SelectItem key={year} value={String(year)}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {selectedOrg && (
              <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <div className="grid md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-slate-600">Type</p>
                    <p className="font-semibold text-slate-900">
                      {selectedOrg.applicant_type?.replace(/_/g, ' ') || 'Individual'}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-600">Location</p>
                    <p className="font-semibold text-slate-900">
                      {selectedOrg.city}, {selectedOrg.state}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-600">Documents Uploaded</p>
                    <p className="font-semibold text-slate-900">
                      {taxDocuments.length} for {selectedYear}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {selectedOrg && (
          <Tabs defaultValue="upload" className="space-y-6">
            <TabsList className="grid w-full grid-cols-6">
              <TabsTrigger value="connect">
                📱 Connect
              </TabsTrigger>
              <TabsTrigger value="upload">Upload Docs</TabsTrigger>
              <TabsTrigger value="analysis">AI Analysis</TabsTrigger>
              <TabsTrigger value="recommendations">Standard</TabsTrigger>
              <TabsTrigger value="loopholes" className="font-bold">
                💡 Loopholes
              </TabsTrigger>
              <TabsTrigger value="filing" className="font-bold text-green-700">
                📬 Print & Mail
              </TabsTrigger>
            </TabsList>

            {/* NEW: CONNECT TAB */}
            <TabsContent value="connect">
              <Card>
                <CardHeader className="bg-gradient-to-r from-blue-50 to-purple-50">
                  <CardTitle className="flex items-center gap-2">
                    <LinkIcon className="w-6 h-6 text-blue-600" />
                    Connect to Employers & Financial Institutions
                  </CardTitle>
                  <CardDescription className="mt-2">
                    Request tax documents directly from your employer, bank, or brokerage
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-6 space-y-6">
                  {/* How It Works */}
                  <Alert className="bg-blue-50 border-blue-300">
                    <Mail className="h-4 w-4 text-blue-600" />
                    <AlertDescription className="text-blue-900">
                      <strong>How Document Requests Work:</strong>
                      <ol className="list-decimal list-inside mt-2 space-y-1 text-sm">
                        <li>You provide employer/institution name and email</li>
                        <li>We send a professional request on your behalf</li>
                        <li>They provide documents electronically (2-5 business days)</li>
                        <li>Documents automatically appear in your account</li>
                      </ol>
                    </AlertDescription>
                  </Alert>

                  {/* Add Connection Button */}
                  <div className="text-center">
                    <Button
                      onClick={() => setShowConnectDialog(true)}
                      size="lg"
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      <LinkIcon className="w-5 h-5 mr-2" />
                      Request Tax Documents
                    </Button>
                  </div>

                  {/* Existing Connections */}
                  {connections.length > 0 && (
                    <div>
                      <h3 className="font-semibold text-slate-900 mb-4">Your Document Connections</h3>
                      <div className="space-y-3">
                        {connections.map(conn => (
                          <Card key={conn.id} className="border-l-4" style={{
                            borderLeftColor:
                              conn.connection_status === 'connected' ? '#10b981' :
                              conn.connection_status === 'pending' ? '#f59e0b' :
                              '#ef4444'
                          }}>
                            <CardContent className="p-4">
                              <div className="flex items-start justify-between">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <h4 className="font-semibold text-slate-900">
                                      {conn.institution_name}
                                    </h4>
                                    <Badge className={
                                      conn.connection_status === 'connected' ? 'bg-green-100 text-green-800' :
                                      conn.connection_status === 'pending' ? 'bg-amber-100 text-amber-800' :
                                      'bg-red-100 text-red-800'
                                    }>
                                      {conn.connection_status}
                                    </Badge>
                                  </div>
                                  <p className="text-sm text-slate-600">
                                    {CONNECTION_TYPES.find(t => t.value === conn.connection_type)?.label || conn.connection_type}
                                  </p>
                                  {conn.email_sent_date && (
                                    <p className="text-xs text-slate-500 mt-1">
                                      Request sent {new Date(conn.email_sent_date).toLocaleDateString()}
                                    </p>
                                  )}
                                </div>
                                <div className="text-right">
                                  {conn.documents_retrieved > 0 && (
                                    <div className="text-sm">
                                      <p className="text-slate-600">Retrieved</p>
                                      <p className="font-bold text-green-600">{conn.documents_retrieved}</p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Benefits */}
                  <Card className="bg-gradient-to-br from-green-50 to-emerald-50 border-green-200">
                    <CardHeader>
                      <CardTitle className="text-base">✨ Benefits of Connected Documents</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2 text-sm text-slate-700">
                        <li className="flex items-start gap-2">
                          <CheckSquare className="w-4 h-4 text-green-600 mt-0.5" />
                          <span><strong>No manual data entry</strong> - Documents arrive automatically</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <CheckSquare className="w-4 h-4 text-green-600 mt-0.5" />
                          <span><strong>Fewer errors</strong> - Data directly from source</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <CheckSquare className="w-4 h-4 text-green-600 mt-0.5" />
                          <span><strong>Faster processing</strong> - Ready for analysis immediately</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <CheckSquare className="w-4 h-4 text-green-600 mt-0.5" />
                          <span><strong>Multi-year access</strong> - Request prior years if needed</span>
                        </li>
                      </ul>
                    </CardContent>
                  </Card>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Upload Tab */}
            <TabsContent value="upload">
              <div className="grid gap-6">
                {/* Summary Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card>
                    <CardContent className="p-4 text-center">
                      <FileText className="w-8 h-8 mx-auto text-blue-600 mb-2" />
                      <p className="text-2xl font-bold text-slate-900">{taxDocuments.length}</p>
                      <p className="text-xs text-slate-600">Documents</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4 text-center">
                      <DollarSign className="w-8 h-8 mx-auto text-green-600 mb-2" />
                      <p className="text-2xl font-bold text-slate-900">
                        ${totalIncome.toLocaleString()}
                      </p>
                      <p className="text-xs text-slate-600">Total Income</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4 text-center">
                      <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-600 mb-2" />
                      <p className="text-2xl font-bold text-slate-900">
                        {taxDocuments.filter(d => d.verification_status === 'verified').length}
                      </p>
                      <p className="text-xs text-slate-600">Verified</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4 text-center">
                      <AlertTriangle className="w-8 h-8 mx-auto text-amber-600 mb-2" />
                      <p className="text-2xl font-bold text-slate-900">
                        {taxDocuments.filter(d => d.verification_status === 'needs_review').length}
                      </p>
                      <p className="text-xs text-slate-600">Needs Review</p>
                    </CardContent>
                  </Card>
                </div>

                {/* Document Upload Cards */}
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {DOCUMENT_TYPES.map((docType) => {
                    const Icon = docType.icon;
                    const docsOfType = documentsByType[docType.value] || [];
                    const isUploading = uploadingDoc === docType.value;

                    return (
                      <Card key={docType.value} className="hover:shadow-lg transition-shadow">
                        <CardHeader>
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Icon className="w-4 h-4" />
                            {docType.label}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {docsOfType.length > 0 && (
                            <div className="space-y-2 mb-3">
                              {docsOfType.map((doc, idx) => (
                                <div key={doc.id} className="flex items-center justify-between p-2 bg-green-50 rounded border border-green-200">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-semibold text-slate-900 truncate">
                                      {doc.issuer_name || `Document ${idx + 1}`}
                                    </p>
                                    {doc.amount > 0 && (
                                      <p className="text-xs text-green-700">
                                        ${doc.amount.toLocaleString()}
                                      </p>
                                    )}
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => deleteDocumentMutation.mutate(doc.id)}
                                    className="h-6 w-6 p-0"
                                  >
                                    <Trash2 className="w-3 h-3 text-red-500" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}

                          <label className="block">
                            <Button
                              variant="outline"
                              className="w-full"
                              disabled={isUploading}
                              onClick={() => document.getElementById(`upload-${docType.value}`).click()}
                            >
                              {isUploading ? (
                                <>
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                  Uploading...
                                </>
                              ) : (
                                <>
                                  <Upload className="w-4 h-4 mr-2" />
                                  Upload {docType.label}
                                </>
                              )}
                            </Button>
                            <input
                              id={`upload-${docType.value}`}
                              type="file"
                              accept=".pdf,.jpg,.jpeg,.png"
                              className="hidden"
                              onChange={(e) => handleFileUpload(e, docType.value)}
                            />
                          </label>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            </TabsContent>

            {/* Analysis Tab */}
            <TabsContent value="analysis">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Brain className="w-6 h-6 text-purple-600" />
                        AI Tax Optimization Analysis
                      </CardTitle>
                      <CardDescription className="mt-2">
                        Comprehensive analysis of federal, state, and local tax optimization opportunities
                      </CardDescription>
                    </div>
                    <Button
                      onClick={handleAnalyze}
                      disabled={isAnalyzing || taxDocuments.length === 0}
                      className="bg-gradient-to-r from-purple-600 to-blue-600"
                      size="lg"
                    >
                      {isAnalyzing ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Analyzing...
                        </>
                      ) : (
                        <>
                          <Calculator className="w-5 h-5 mr-2" />
                          Run Analysis
                        </>
                      )}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {taxDocuments.length === 0 ? (
                    <div className="text-center py-12">
                      <Upload className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">
                        No Documents Uploaded
                      </h3>
                      <p className="text-slate-600">
                        Upload your tax documents to get started with AI analysis
                      </p>
                    </div>
                  ) : !taxProfile ? (
                    <div className="text-center py-12">
                      <Brain className="w-16 h-16 mx-auto text-purple-300 mb-4" />
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">
                        Ready for Analysis
                      </h3>
                      <p className="text-slate-600 mb-4">
                        {taxDocuments.length} documents uploaded. Click "Run Analysis" to discover optimization opportunities.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {/* Tax Position Summary */}
                      <div className="grid md:grid-cols-3 gap-4">
                        <Card className="bg-gradient-to-br from-blue-50 to-blue-100">
                          <CardContent className="p-4">
                            <p className="text-sm text-slate-600 mb-1">Estimated Refund</p>
                            <p className="text-3xl font-bold text-blue-900">
                              ${(taxProfile.estimated_refund || 0).toLocaleString()}
                            </p>
                          </CardContent>
                        </Card>
                        <Card className="bg-gradient-to-br from-purple-50 to-purple-100">
                          <CardContent className="p-4">
                            <p className="text-sm text-slate-600 mb-1">Potential Savings</p>
                            <p className="text-3xl font-bold text-purple-900">
                              ${(taxProfile.ai_recommendations?.reduce((sum, rec) =>
                                sum + (rec.estimated_savings || 0), 0) || 0).toLocaleString()}
                            </p>
                          </CardContent>
                        </Card>
                        <Card className="bg-gradient-to-br from-green-50 to-green-100">
                          <CardContent className="p-4">
                            <p className="text-sm text-slate-600 mb-1">Opportunities</p>
                            <p className="text-3xl font-bold text-green-900">
                              {taxProfile.ai_recommendations?.length || 0}
                            </p>
                          </CardContent>
                        </Card>
                      </div>

                      {/* Tax Breakdown */}
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Tax Liability Breakdown</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3">
                            <div className="flex items-center justify-between py-2 border-b">
                              <span className="text-slate-600">Adjusted Gross Income (AGI)</span>
                              <span className="font-bold text-slate-900">
                                ${(taxProfile.adjusted_gross_income || 0).toLocaleString()}
                              </span>
                            </div>
                            <div className="flex items-center justify-between py-2 border-b">
                              <span className="text-slate-600">Itemized Deductions</span>
                              <span className="font-bold text-green-600">
                                -${(taxProfile.itemized_deductions || 0).toLocaleString()}
                              </span>
                            </div>
                            <div className="flex items-center justify-between py-2 border-b">
                              <span className="text-slate-600">Federal Tax</span>
                              <span className="font-bold text-slate-900">
                                ${(taxProfile.estimated_tax_liability || 0).toLocaleString()}
                              </span>
                            </div>
                            <div className="flex items-center justify-between py-2 border-b">
                              <span className="text-slate-600">State Tax ({selectedOrg.state})</span>
                              <span className="font-bold text-slate-900">
                                ${(taxProfile.state_tax_owed || 0).toLocaleString()}
                              </span>
                            </div>
                            {taxProfile.local_tax_owed > 0 && (
                              <div className="flex items-center justify-between py-2 border-b">
                                <span className="text-slate-600">Local Tax ({selectedOrg.city})</span>
                                <span className="font-bold text-slate-900">
                                  ${(taxProfile.local_tax_owed || 0).toLocaleString()}
                                </span>
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>

                      {/* Credits Applied */}
                      {taxProfile.tax_credits && Object.keys(taxProfile.tax_credits).length > 0 && (
                        <Card>
                          <CardHeader>
                            <CardTitle className="text-base">Tax Credits Applied</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="space-y-2">
                              {Object.entries(taxProfile.tax_credits).map(([credit, amount]) => (
                                <div key={credit} className="flex items-center justify-between py-2">
                                  <span className="text-sm text-slate-700">{credit}</span>
                                  <Badge className="bg-green-100 text-green-800">
                                    ${amount.toLocaleString()}
                                  </Badge>
                                </div>
                              ))}
                            </div>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Standard Recommendations Tab */}
            <TabsContent value="recommendations">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle2 className="w-6 h-6 text-blue-600" />
                    Standard Tax Credits & Deductions
                  </CardTitle>
                  <CardDescription>
                    Common deductions and credits applicable to most taxpayers
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!taxProfile ? (
                    <div className="text-center py-12">
                      <Calculator className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">
                        Run Analysis First
                      </h3>
                      <p className="text-slate-600">
                        Go to the Analysis tab and run AI analysis to get personalized recommendations
                      </p>
                    </div>
                  ) : standardRecommendations.length === 0 ? (
                    <div className="text-center py-12">
                      <CheckCircle2 className="w-16 h-16 mx-auto text-green-300 mb-4" />
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">
                        All Standard Items Covered
                      </h3>
                      <p className="text-slate-600">
                        Check the Advanced Loopholes tab for additional strategies
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Total Savings */}
                      <Alert className="bg-gradient-to-r from-blue-50 to-sky-50 border-blue-300">
                        <TrendingUp className="h-5 w-5 text-blue-600" />
                        <AlertDescription className="text-blue-900">
                          <strong className="text-lg">
                            Standard Savings: ${standardRecommendations
                              .reduce((sum, rec) => sum + (rec.estimated_savings || 0), 0)
                              .toLocaleString()}
                          </strong>
                          <p className="text-sm mt-1">
                            {standardRecommendations.length} standard credits and deductions
                          </p>
                        </AlertDescription>
                      </Alert>

                      {/* Recommendations */}
                      {standardRecommendations.map((rec, idx) => (
                        <Card
                          key={idx}
                          className="border-l-4 border-l-blue-500"
                        >
                          <CardHeader>
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <Badge className="bg-blue-100 text-blue-800">
                                    {(rec.confidence * 100).toFixed(0)}% Confidence
                                  </Badge>
                                  <Badge variant="outline">
                                    {rec.jurisdiction || 'Federal'}
                                  </Badge>
                                </div>
                                <CardTitle className="text-base">
                                  {rec.category}
                                </CardTitle>
                              </div>
                              <div className="text-right">
                                <p className="text-sm text-slate-600">Savings</p>
                                <p className="text-2xl font-bold text-blue-600">
                                  ${(rec.estimated_savings || 0).toLocaleString()}
                                </p>
                              </div>
                            </div>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <p className="text-sm text-slate-700">{rec.recommendation}</p>
                            {rec.irs_reference && (
                              <p className="text-xs text-slate-500 pt-2 border-t">
                                Reference: {rec.irs_reference}
                              </p>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ADVANCED LOOPHOLES TAB */}
            <TabsContent value="loopholes">
              <Card>
                <CardHeader className="bg-gradient-to-r from-purple-50 via-pink-50 to-orange-50 border-b-2 border-purple-200">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-xl">
                        <Brain className="w-7 h-7 text-purple-600" />
                        💡 Advanced Tax Loopholes & Strategies
                      </CardTitle>
                      <CardDescription className="mt-2 text-base">
                        Sophisticated legal strategies used by wealthy individuals, businesses, and professional tax planners
                      </CardDescription>
                    </div>
                  </div>

                  {/* Loophole Disclaimer */}
                  <Alert className="mt-4 bg-green-50 border-green-300">
                    <Shield className="h-5 w-5 text-green-600" />
                    <AlertDescription className="text-green-900">
                      <strong>✅ ALL STRATEGIES BELOW ARE 100% LEGAL</strong>
                      <p className="text-sm mt-1">
                        These are legitimate provisions in the tax code. They are not tax evasion or fraud.
                        However, they require proper documentation and may have specific eligibility requirements.
                        <strong> Always consult a licensed tax professional before implementing.</strong>
                      </p>
                    </AlertDescription>
                  </Alert>
                </CardHeader>

                <CardContent className="pt-6">
                  {!taxProfile ? (
                    <div className="text-center py-12">
                      <Calculator className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">
                        Run Analysis First
                      </h3>
                      <p className="text-slate-600">
                        Upload documents and run AI analysis to discover advanced tax strategies
                      </p>
                    </div>
                  ) : advancedLoopholes.length === 0 ? (
                    <div className="text-center py-12">
                      <AlertCircle className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">
                        No Advanced Strategies Identified
                      </h3>
                      <p className="text-slate-600">
                        Advanced strategies typically apply to business owners, real estate investors,
                        or high-income individuals. Update your profile with additional details to unlock more opportunities.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {/* Total Advanced Savings */}
                      <Alert className="bg-gradient-to-r from-purple-100 via-pink-100 to-orange-100 border-purple-400 border-2">
                        <Sparkles className="h-6 w-6 text-purple-700" />
                        <AlertDescription className="text-purple-900">
                          <strong className="text-2xl block mb-2">
                            💰 Advanced Strategy Savings: ${advancedLoopholes
                              .reduce((sum, rec) => sum + (rec.estimated_savings || 0), 0)
                              .toLocaleString()}
                          </strong>
                          <p className="text-base">
                            Found <strong>{advancedLoopholes.length} advanced legal strategies</strong> that could significantly reduce your tax liability
                          </p>
                        </AlertDescription>
                      </Alert>

                      {/* Sort by savings amount */}
                      {advancedLoopholes
                        .sort((a, b) => (b.estimated_savings || 0) - (a.estimated_savings || 0))
                        .map((loophole, idx) => (
                          <Card
                            key={idx}
                            className="border-2 shadow-lg"
                            style={{
                              borderColor:
                                loophole.estimated_savings >= 5000 ? '#10b981' :
                                  loophole.estimated_savings >= 2000 ? '#8b5cf6' :
                                    '#f59e0b'
                            }}
                          >
                            <CardHeader className="bg-gradient-to-r from-slate-50 to-purple-50">
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-3">
                                    <Badge
                                      className="text-white font-bold text-sm"
                                      style={{
                                        backgroundColor:
                                          loophole.estimated_savings >= 5000 ? '#10b981' :
                                            loophole.estimated_savings >= 2000 ? '#8b5cf6' :
                                              '#f59e0b'
                                      }}
                                    >
                                      {(loophole.confidence * 100).toFixed(0)}% Confidence
                                    </Badge>
                                    <Badge variant="outline" className="font-semibold">
                                      {loophole.jurisdiction || 'Federal'}
                                    </Badge>
                                    <Badge
                                      variant="outline"
                                      className={
                                        loophole.complexity === 'high' ? 'border-red-300 text-red-700' :
                                          loophole.complexity === 'moderate' ? 'border-amber-300 text-amber-700' :
                                            'border-green-300 text-green-700'
                                      }
                                    >
                                      {loophole.complexity || 'moderate'} complexity
                                    </Badge>
                                  </div>
                                  <CardTitle className="text-lg mb-1">
                                    💡 {loophole.category}
                                  </CardTitle>
                                </div>
                                <div className="text-right">
                                  <p className="text-sm text-slate-600 font-medium">Potential Savings</p>
                                  <p className="text-3xl font-bold text-green-600">
                                    ${(loophole.estimated_savings || 0).toLocaleString()}
                                  </p>
                                </div>
                              </div>
                            </CardHeader>
                            <CardContent className="space-y-4 pt-4">
                              <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                                <p className="text-sm font-semibold text-purple-900 mb-2">
                                  🎯 How This Strategy Works:
                                </p>
                                <p className="text-sm text-slate-700 whitespace-pre-line">
                                  {loophole.recommendation}
                                </p>
                              </div>

                              {loophole.eligibility_criteria && (
                                <div>
                                  <p className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                                    Eligibility Requirements:
                                  </p>
                                  <p className="text-sm text-slate-600 pl-6">
                                    {loophole.eligibility_criteria}
                                  </p>
                                </div>
                              )}

                              {loophole.required_documentation && (
                                <div>
                                  <p className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                                    <FileText className="w-4 h-4 text-blue-600" />
                                    Required Documentation:
                                  </p>
                                  <p className="text-sm text-slate-600 pl-6">
                                    {loophole.required_documentation}
                                  </p>
                                </div>
                              )}

                              {loophole.irs_reference && (
                                <div className="pt-3 border-t border-slate-200">
                                  <p className="text-xs text-slate-500 font-mono">
                                    📚 Legal Reference: {loophole.irs_reference}
                                  </p>
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        ))}

                      {/* Strategy Categories Summary */}
                      <Card className="bg-gradient-to-br from-slate-50 to-blue-50">
                        <CardHeader>
                          <CardTitle className="text-base">Strategy Categories Found</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {[...new Set(advancedLoopholes.map(l => {
                              if (l.category.toLowerCase().includes('business')) return '🏢 Business';
                              if (l.category.toLowerCase().includes('real estate') || l.category.toLowerCase().includes('1031')) return '🏡 Real Estate';
                              if (l.category.toLowerCase().includes('retirement') || l.category.toLowerCase().includes('roth') || l.category.toLowerCase().includes('401k')) return '💰 Retirement';
                              if (l.category.toLowerCase().includes('investment') || l.category.toLowerCase().includes('capital')) return '📈 Investment';
                              if (l.category.toLowerCase().includes('charitable') || l.category.toLowerCase().includes('donation')) return '💝 Charitable';
                              if (l.category.toLowerCase().includes('estate') || l.category.toLowerCase().includes('family')) return '👨‍👩‍👧 Family/Estate';
                              if (l.category.toLowerCase().includes('energy') || l.category.toLowerCase().includes('solar')) return '🌱 Energy';
                              return '💡 Other';
                            }))].map(category => (
                              <Badge key={category} variant="outline" className="justify-center py-2">
                                {category}
                              </Badge>
                            ))}
                          </div>
                        </CardContent>
                      </Card>

                      {/* Professional Consultation CTA */}
                      <Alert className="bg-gradient-to-r from-amber-50 to-orange-50 border-amber-400 border-2">
                        <AlertTriangle className="h-5 w-5 text-amber-600" />
                        <AlertDescription className="text-amber-900">
                          <strong className="text-lg block mb-2">⚠️ Complex Strategies Require Professional Guidance</strong>
                          <p className="mb-2">
                            These advanced strategies can provide significant tax savings, but they require:
                          </p>
                          <ul className="list-disc list-inside space-y-1 text-sm">
                            <li>Proper documentation and record-keeping</li>
                            <li>Correct timing and execution</li>
                            <li>Compliance with specific IRS rules and procedures</li>
                            <li>Professional tax preparation and filing</li>
                          </ul>
                          <p className="mt-2 font-semibold">
                            📞 Consult with a CPA, EA (Enrolled Agent), or tax attorney before implementing any advanced strategy.
                          </p>
                        </AlertDescription>
                      </Alert>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* UPDATED: FILING TAB - Print & Mail Focus */}
            <TabsContent value="filing">
              <div className="space-y-6">
                {/* Professional Review Disclaimer */}
                <Alert className="bg-red-50 border-red-400 border-2">
                  <AlertTriangle className="h-6 w-6 text-red-600" />
                  <AlertDescription className="text-red-900">
                    <strong className="text-xl block mb-3">🚨 DRAFT TAX RETURN - PROFESSIONAL REVIEW REQUIRED BEFORE MAILING</strong>
                    <div className="space-y-2 text-base">
                      <p>
                        <strong>This is an AI-generated DRAFT.</strong> You MUST have it reviewed by a licensed tax professional before mailing to the IRS.
                      </p>
                      <ul className="list-disc list-inside space-y-1 ml-4">
                        <li>Business expenses are estimates - verify with actual receipts</li>
                        <li>Tax professional must sign as preparer if they help</li>
                        <li>You are legally responsible for accuracy</li>
                        <li>Errors can result in penalties and interest</li>
                      </ul>
                      <p className="font-bold mt-3 text-lg">
                        ✅ Have a CPA or Enrolled Agent review before you mail.
                      </p>
                    </div>
                  </AlertDescription>
                </Alert>

                {/* Generate Return Section */}
                <Card>
                  <CardHeader className="bg-gradient-to-r from-green-50 to-emerald-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          <FileText className="w-6 h-6 text-green-600" />
                          Step 1: Generate Your Draft Tax Return
                        </CardTitle>
                        <CardDescription className="mt-2">
                          Creates Form 1040 and all required schedules ready for printing
                        </CardDescription>
                      </div>
                      <Button
                        onClick={handleGenerateReturn}
                        disabled={generatingReturn || !taxProfile || taxDocuments.length === 0}
                        className="bg-gradient-to-r from-green-600 to-emerald-600"
                        size="lg"
                      >
                        {generatingReturn ? (
                          <>
                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                            Generating...
                          </>
                        ) : (
                          <>
                            <FileText className="w-5 h-5 mr-2" />
                            Generate Tax Forms
                          </>
                        )}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-6">
                    {!taxProfile ? (
                      <Alert>
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>
                          Run AI Analysis first to calculate your tax position before generating forms.
                        </AlertDescription>
                      </Alert>
                    ) : taxDocuments.length === 0 ? (
                      <Alert>
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>
                          Upload tax documents first before generating returns.
                        </AlertDescription>
                      </Alert>
                    ) : !taxReturn ? (
                      <div className="text-center py-8">
                        <FileText className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                        <p className="text-slate-600">
                          Click "Generate Tax Forms" to create your draft return for mailing
                        </p>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                {/* Generated Return Display */}
                {taxReturn && (
                  <>
                    {/* Return Summary */}
                    <Card className="border-2 border-green-500">
                      <CardHeader className="bg-gradient-to-r from-green-50 to-emerald-50">
                        <div className="flex items-center justify-between">
                          <div>
                            <CardTitle className="flex items-center gap-2">
                              <CheckCircle2 className="w-6 h-6 text-green-600" />
                              Draft Return Generated - {taxReturn.return_type}
                            </CardTitle>
                            <CardDescription className="mt-1">
                              Status: <Badge className={
                                taxReturn.status === 'ready_for_review' ? 'bg-green-600' :
                                  taxReturn.status === 'reviewed' ? 'bg-blue-600' :
                                    'bg-amber-600'
                              }>
                                {taxReturn.status?.replace(/_/g, ' ') || 'Unknown'}
                              </Badge>
                            </CardDescription>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              onClick={handleDownloadPDF}
                              variant="outline"
                              size="sm"
                              disabled={!taxReturn.generated_pdf_uri}
                            >
                              <Download className="w-4 h-4 mr-2" />
                              Download PDF
                            </Button>
                            <Button
                              onClick={handleGenerateReturn}
                              variant="outline"
                              size="sm"
                            >
                              <RefreshCw className="w-4 h-4 mr-2" />
                              Regenerate
                            </Button>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="pt-6">
                        {/* Tax Position Summary */}
                        <div className="grid md:grid-cols-4 gap-4 mb-6">
                          <Card className="bg-blue-50">
                            <CardContent className="p-4 text-center">
                              <p className="text-sm text-slate-600 mb-1">Total Income</p>
                              <p className="text-2xl font-bold text-slate-900">
                                ${(taxReturn.total_income || 0).toLocaleString()}
                              </p>
                            </CardContent>
                          </Card>
                          <Card className="bg-purple-50">
                            <CardContent className="p-4 text-center">
                              <p className="text-sm text-slate-600 mb-1">AGI</p>
                              <p className="text-2xl font-bold text-slate-900">
                                ${(taxReturn.adjusted_gross_income || 0).toLocaleString()}
                              </p>
                            </CardContent>
                          </Card>
                          <Card className="bg-amber-50">
                            <CardContent className="p-4 text-center">
                              <p className="text-sm text-slate-600 mb-1">Total Tax</p>
                              <p className="text-2xl font-bold text-slate-900">
                                ${(taxReturn.total_tax || 0).toLocaleString()}
                              </p>
                            </CardContent>
                          </Card>
                          <Card className={taxReturn.refund_amount > 0 ? 'bg-green-50' : 'bg-red-50'}>
                            <CardContent className="p-4 text-center">
                              <p className="text-sm text-slate-600 mb-1">
                                {taxReturn.refund_amount > 0 ? 'Refund' : 'Amount Owed'}
                              </p>
                              <p className={`text-2xl font-bold ${taxReturn.refund_amount > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                ${(Math.abs(taxReturn.refund_amount || taxReturn.amount_owed) || 0).toLocaleString()}
                              </p>
                            </CardContent>
                          </Card>
                        </div>

                        {/* Forms Included */}
                        <div className="mb-6">
                          <p className="text-sm font-semibold text-slate-700 mb-3">
                            Forms & Schedules Included:
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline" className="bg-white">
                              Form {taxReturn.return_type}
                            </Badge>
                            {taxReturn.schedules && Object.keys(taxReturn.schedules).map(schedule => (
                              <Badge key={schedule} variant="outline" className="bg-white">
                                {schedule.replace('_', ' ').toUpperCase()}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Warnings and Missing Info */}
                    {taxReturn.warnings && taxReturn.warnings.length > 0 && (
                      <Alert className="bg-amber-50 border-amber-400">
                        <AlertTriangle className="h-5 w-5 text-amber-600" />
                        <AlertDescription className="text-amber-900">
                          <strong className="block mb-2">⚠️ Review Required:</strong>
                          <ul className="list-disc list-inside space-y-1 text-sm">
                            {taxReturn.warnings.map((warning, idx) => (
                              <li key={idx}>{warning}</li>
                            ))}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    )}

                    {taxReturn.missing_information && taxReturn.missing_information.length > 0 && (
                      <Alert className="bg-red-50 border-red-400">
                        <AlertTriangle className="h-5 w-5 text-red-600" />
                        <AlertDescription className="text-red-900">
                          <strong className="block mb-2">❌ Missing Information:</strong>
                          <ul className="list-disc list-inside space-y-1 text-sm">
                            {taxReturn.missing_information.map((missing, idx) => (
                              <li key={idx}>{missing}</li>
                            ))}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    )}

                    {/* Step 2: Print Forms */}
                    <Card className="border-2 border-blue-500">
                      <CardHeader className="bg-gradient-to-r from-blue-50 to-blue-100">
                        <CardTitle className="flex items-center gap-2">
                          <Printer className="w-6 h-6 text-blue-600" />
                          Step 2: Print Your Tax Return Package
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-6 space-y-4">
                        <div className="grid md:grid-cols-2 gap-4">
                          <Button
                            onClick={handleDownloadPDF}
                            size="lg"
                            className="bg-blue-600 hover:bg-blue-700"
                          >
                            <Download className="w-5 h-5 mr-2" />
                            Download Complete Package
                          </Button>
                          <Button
                            onClick={() => window.print()}
                            size="lg"
                            variant="outline"
                          >
                            <Printer className="w-5 h-5 mr-2" />
                            Print Now
                          </Button>
                        </div>

                        <Alert className="bg-blue-50 border-blue-300">
                          <CheckSquare className="h-4 w-4 text-blue-600" />
                          <AlertDescription className="text-blue-900">
                            <strong>What to Print:</strong>
                            <ul className="list-disc list-inside text-sm mt-2 space-y-1">
                              <li>Form 1040 (2 copies - one to mail, one for your records)</li>
                              <li>All schedules that apply to you</li>
                              <li>W-2 forms (attach original or copy to FRONT of 1040)</li>
                              <li>1099 forms (include in package)</li>
                              <li>Mailing instructions (for reference)</li>
                            </ul>
                            <p className="text-sm mt-3 font-semibold">
                              💡 Print double-sided to save paper (IRS accepts this)
                            </p>
                          </AlertDescription>
                        </Alert>
                      </CardContent>
                    </Card>

                    {/* Step 3: Mailing Instructions */}
                    <Card className="border-2 border-green-500">
                      <CardHeader className="bg-gradient-to-r from-green-50 to-emerald-50">
                        <CardTitle className="flex items-center gap-2">
                          <Mail className="w-6 h-6 text-green-600" />
                          Step 3: Mail Your Return to IRS
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-6">
                        <MailingInstructions
                          mailingInfo={taxReturn.efile_data?.mailing_info}
                          taxYear={taxReturn.tax_year}
                          refundAmount={taxReturn.refund_amount}
                          paymentAmount={taxReturn.amount_owed}
                        />
                      </CardContent>
                    </Card>

                    {/* Tracking & Confirmation */}
                    <Card className="bg-gradient-to-br from-purple-50 to-pink-50">
                      <CardHeader>
                        <CardTitle>📋 After You Mail</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid md:grid-cols-2 gap-4">
                          <div className="p-4 bg-white rounded-lg border border-purple-200">
                            <p className="font-semibold text-slate-900 mb-2">✅ What to Keep</p>
                            <ul className="text-sm text-slate-700 space-y-1">
                              <li>• Copy of complete return</li>
                              <li>• Certified mail receipt (if used)</li>
                              <li>• All W-2s and 1099s</li>
                              <li>• All receipts for deductions</li>
                              <li>• Keep for at least 3 years</li>
                            </ul>
                          </div>

                          <div className="p-4 bg-white rounded-lg border border-blue-200">
                            <p className="font-semibold text-slate-900 mb-2">📞 Track Your Refund</p>
                            <ul className="text-sm text-slate-700 space-y-1">
                              <li>• IRS "Where's My Refund" tool</li>
                              <li>• Available after 4 weeks for mailed returns</li>
                              <li>• Need: SSN, filing status, exact refund amount</li>
                              <li>• Refunds typically arrive in 6-8 weeks</li>
                            </ul>
                          </div>
                        </div>

                        <Alert className="bg-green-50 border-green-300">
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                          <AlertDescription className="text-green-900">
                            <strong>🎉 Expected Refund Timeline:</strong>
                            <p className="text-sm mt-1">
                              For paper returns mailed by April 15:
                            </p>
                            <ul className="list-disc list-inside text-sm mt-2 space-y-1">
                              <li>• <strong>4 weeks:</strong> Return processed, refund status available</li>
                              <li>• <strong>6-8 weeks:</strong> Refund check mailed or direct deposit</li>
                              <li>• <strong>12 weeks:</strong> If no refund, contact IRS</li>
                            </ul>
                          </AlertDescription>
                        </Alert>
                      </CardContent>
                    </Card>

                    {/* Export Options (for professional use) */}
                    <Card className="bg-gradient-to-br from-slate-50 to-purple-50 border-slate-300">
                      <CardHeader>
                        <CardTitle className="text-base">
                          💼 Export for Tax Professional (Optional)
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-slate-600 mb-4">
                          If you want a tax professional to review and file electronically, you can export in these formats:
                        </p>
                        <div className="grid md:grid-cols-2 gap-3">
                          <Button
                            onClick={() => handleExport('turbotax_txf')}
                            disabled={exportMutation.isPending}
                            variant="outline"
                            size="sm"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            TurboTax (TXF)
                          </Button>
                          <Button
                            onClick={() => handleExport('proseries_xml')}
                            disabled={exportMutation.isPending}
                            variant="outline"
                            size="sm"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            ProSeries (XML)
                          </Button>
                          <Button
                            onClick={() => handleExport('csv')}
                            disabled={exportMutation.isPending}
                            variant="outline"
                            size="sm"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Spreadsheet (CSV)
                          </Button>
                          <Button
                            onClick={() => handleExport('json')}
                            disabled={exportMutation.isPending}
                            variant="outline"
                            size="sm"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Raw Data (JSON)
                          </Button>
                        </div>
                        <p className="text-xs text-slate-500 mt-3">
                          These exports allow tax professionals to import your data into their software for e-filing
                        </p>
                      </CardContent>
                    </Card>
                  </>
                )}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* Connect Dialog */}
      <Dialog open={showConnectDialog} onOpenChange={setShowConnectDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Request Tax Documents</DialogTitle>
            <DialogDescription>
              We'll send a professional email request to your employer or financial institution
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div>
              <Label>Document Type</Label>
              <Select
                value={connectionForm.connection_type}
                onValueChange={(val) => setConnectionForm({...connectionForm, connection_type: val})}
              >
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONNECTION_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Institution Name</Label>
              <Input
                placeholder="e.g., Acme Corporation, Wells Fargo, Fidelity"
                value={connectionForm.institution_name}
                onChange={(e) => setConnectionForm({...connectionForm, institution_name: e.target.value})}
                className="mt-2"
              />
            </div>

            <div>
              <Label>Institution Email</Label>
              <Input
                type="email"
                placeholder="payroll@company.com or support@bank.com"
                value={connectionForm.institution_email}
                onChange={(e) => setConnectionForm({...connectionForm, institution_email: e.target.value})}
                className="mt-2"
              />
              <p className="text-xs text-slate-500 mt-1">
                Usually: payroll@, hr@, or tax.documents@ for employers
              </p>
            </div>

            <Alert className="bg-amber-50 border-amber-300">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-sm text-amber-900">
                <strong>Note:</strong> Some institutions may require you to request documents through their portal instead.
                We'll send the email, but you may need to follow up directly.
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConnectDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRequestDocuments}
              disabled={requestDocsMutation.isPending || !connectionForm.institution_name || !connectionForm.institution_email}
            >
              {requestDocsMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Send Request
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}