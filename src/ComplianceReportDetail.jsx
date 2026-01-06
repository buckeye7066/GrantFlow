import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, ArrowLeft, Sparkles, Save, Send, Download, FileText, Calendar, Building2, DollarSign } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from "@/components/ui/use-toast";
import ReactMarkdown from 'react-markdown';

export default function ComplianceReportDetail() {
  const [searchParams] = useSearchParams();
  const reportId = searchParams.get('id');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [editableData, setEditableData] = useState({});

  const { data: report, isLoading: isLoadingReport } = useQuery({
    queryKey: ['complianceReport', reportId],
    queryFn: () => base44.entities.ComplianceReport.get(reportId),
    enabled: !!reportId,
  });

  // Replace onSuccess with useEffect
  useEffect(() => {
    if (report) {
      setEditableData({
        narrative: report.narrative || '',
        activities_summary: report.activities_summary || '',
        challenges_faced: report.challenges_faced || '',
        next_steps: report.next_steps || '',
      });
    }
  }, [report]);

  const { data: grant } = useQuery({
    queryKey: ['grant', report?.grant_id],
    queryFn: () => base44.entities.Grant.get(report.grant_id),
    enabled: !!report?.grant_id,
  });

  const { data: organization } = useQuery({
    queryKey: ['organization', report?.organization_id],
    queryFn: () => base44.entities.Organization.get(report.organization_id),
    enabled: !!report?.organization_id,
  });

  const generateReportMutation = useMutation({
    mutationFn: () => base44.functions.invoke('generateReport', { report_id: reportId }),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['complianceReport', reportId] });
      toast({
        title: "Report Generated! ✨",
        description: "AI has generated your compliance report. Review and edit as needed.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Generation Failed",
        description: error.message,
      });
    }
  });

  const updateReportMutation = useMutation({
    mutationFn: (data) => base44.entities.ComplianceReport.update(reportId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['complianceReport', reportId] });
      toast({
        title: "Report Saved",
        description: "Your changes have been saved.",
      });
    },
  });

  const handleSave = () => {
    updateReportMutation.mutate(editableData);
  };

  const handleSubmit = () => {
    updateReportMutation.mutate({
      ...editableData,
      status: 'submitted',
      submitted_date: new Date().toISOString()
    });
    toast({
      title: "Report Submitted! 🎉",
      description: "Your report has been marked as submitted.",
    });
  };

  if (isLoadingReport) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!report) {
    return <div className="p-8 text-center">Report not found.</div>;
  }

  const financialData = report.financial_data ? JSON.parse(report.financial_data) : null;
  const isGenerating = generateReportMutation.isPending;
  const isDraft = report.status === 'draft' || report.status === 'scheduled';

  return (
    <div className="p-6 md:p-8 min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <Link to={createPageUrl('Reports')}>
            <Button variant="ghost" className="mb-4">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Reports
            </Button>
          </Link>
          
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-3xl font-bold text-slate-900">
                  {report.report_type.charAt(0).toUpperCase() + report.report_type.slice(1)} Report
                </h1>
                <Badge className={
                  report.status === 'submitted' ? 'bg-green-100 text-green-800' :
                  report.status === 'accepted' ? 'bg-emerald-100 text-emerald-800' :
                  report.status === 'draft' ? 'bg-blue-100 text-blue-700' :
                  'bg-slate-100 text-slate-700'
                }>
                  {report.status.replace(/_/g, ' ')}
                </Badge>
              </div>
              <p className="text-slate-600">{grant?.title || 'Loading grant...'}</p>
            </div>
            <div className="flex gap-2">
              {isDraft && report.narrative && (
                <>
                  <Button variant="outline" onClick={handleSave} disabled={updateReportMutation.isPending}>
                    <Save className="w-4 h-4 mr-2" />
                    Save Draft
                  </Button>
                  <Button onClick={handleSubmit} disabled={updateReportMutation.isPending}>
                    <Send className="w-4 h-4 mr-2" />
                    Submit Report
                  </Button>
                </>
              )}
              {isDraft && !report.narrative && (
                <Button 
                  onClick={() => generateReportMutation.mutate()}
                  disabled={isGenerating}
                  className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
                >
                  {isGenerating ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
                  ) : (
                    <><Sparkles className="w-4 h-4 mr-2" /> Generate with AI</>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Report Details Card */}
        <Card className="shadow-lg border-0 mb-6">
          <CardHeader>
            <CardTitle>Report Information</CardTitle>
          </CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div className="flex items-center gap-3">
              <Building2 className="w-5 h-5 text-slate-500" />
              <div>
                <p className="text-xs text-slate-500">Organization</p>
                <p className="font-medium">{organization?.name || 'Loading...'}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Calendar className="w-5 h-5 text-slate-500" />
              <div>
                <p className="text-xs text-slate-500">Due Date</p>
                <p className="font-medium">{format(new Date(report.due_date), 'MMMM d, yyyy')}</p>
              </div>
            </div>
            {report.report_period_start && report.report_period_end && (
              <div className="flex items-center gap-3">
                <Calendar className="w-5 h-5 text-slate-500" />
                <div>
                  <p className="text-xs text-slate-500">Reporting Period</p>
                  <p className="font-medium">
                    {format(new Date(report.report_period_start), 'MMM d, yyyy')} - {format(new Date(report.report_period_end), 'MMM d, yyyy')}
                  </p>
                </div>
              </div>
            )}
            {financialData && (
              <div className="flex items-center gap-3">
                <DollarSign className="w-5 h-5 text-slate-500" />
                <div>
                  <p className="text-xs text-slate-500">Budget Status</p>
                  <p className="font-medium">${financialData.total_spent?.toLocaleString() || 0} spent ({financialData.percent_spent}%)</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Report Content */}
        {!report.narrative ? (
          <Card className="shadow-lg border-0 border-l-4 border-l-purple-500">
            <CardContent className="p-12 text-center">
              <Sparkles className="w-16 h-16 mx-auto text-purple-500 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Ready to Generate Report</h3>
              <p className="text-slate-600 mb-6 max-w-md mx-auto">
                Click "Generate with AI" to automatically create your {report.report_type} report based on your grant data, budget, activities, and progress.
              </p>
              <Button 
                onClick={() => generateReportMutation.mutate()}
                disabled={isGenerating}
                size="lg"
                className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
              >
                {isGenerating ? (
                  <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Generating Report...</>
                ) : (
                  <><Sparkles className="w-5 h-5 mr-2" /> Generate Report with AI</>
                )}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Executive Summary */}
            <Card className="shadow-lg border-0">
              <CardHeader>
                <CardTitle>Executive Summary</CardTitle>
                <CardDescription>High-level overview of the reporting period</CardDescription>
              </CardHeader>
              <CardContent>
                {isDraft ? (
                  <Textarea
                    value={editableData.narrative || ''}
                    onChange={(e) => setEditableData({...editableData, narrative: e.target.value})}
                    rows={8}
                    className="font-serif"
                  />
                ) : (
                  <div className="prose max-w-none">
                    <ReactMarkdown>{report.narrative}</ReactMarkdown>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Activities Summary */}
            <Card className="shadow-lg border-0">
              <CardHeader>
                <CardTitle>Activities Summary</CardTitle>
                <CardDescription>Detailed activities during the reporting period</CardDescription>
              </CardHeader>
              <CardContent>
                {isDraft ? (
                  <Textarea
                    value={editableData.activities_summary || ''}
                    onChange={(e) => setEditableData({...editableData, activities_summary: e.target.value})}
                    rows={10}
                    className="font-serif"
                  />
                ) : (
                  <div className="prose max-w-none">
                    <ReactMarkdown>{report.activities_summary}</ReactMarkdown>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Financial Summary */}
            {financialData && (
              <Card className="shadow-lg border-0">
                <CardHeader>
                  <CardTitle>Financial Summary</CardTitle>
                  <CardDescription>Budget and spending overview</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid md:grid-cols-3 gap-4">
                    <div className="p-4 bg-blue-50 rounded-lg">
                      <p className="text-xs text-blue-600 font-medium">Total Budget</p>
                      <p className="text-2xl font-bold text-blue-900">${financialData.total_budget?.toLocaleString() || 0}</p>
                    </div>
                    <div className="p-4 bg-amber-50 rounded-lg">
                      <p className="text-xs text-amber-600 font-medium">Total Spent</p>
                      <p className="text-2xl font-bold text-amber-900">${financialData.total_spent?.toLocaleString() || 0}</p>
                    </div>
                    <div className="p-4 bg-emerald-50 rounded-lg">
                      <p className="text-xs text-emerald-600 font-medium">Remaining</p>
                      <p className="text-2xl font-bold text-emerald-900">${financialData.remaining_budget?.toLocaleString() || 0}</p>
                    </div>
                  </div>
                  {financialData.financial_narrative && (
                    <div className="prose max-w-none">
                      <ReactMarkdown>{financialData.financial_narrative}</ReactMarkdown>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Challenges & Solutions */}
            <Card className="shadow-lg border-0">
              <CardHeader>
                <CardTitle>Challenges & Solutions</CardTitle>
                <CardDescription>Problems encountered and how they were addressed</CardDescription>
              </CardHeader>
              <CardContent>
                {isDraft ? (
                  <Textarea
                    value={editableData.challenges_faced || ''}
                    onChange={(e) => setEditableData({...editableData, challenges_faced: e.target.value})}
                    rows={6}
                    className="font-serif"
                  />
                ) : (
                  <div className="prose max-w-none">
                    <ReactMarkdown>{report.challenges_faced}</ReactMarkdown>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Next Steps */}
            <Card className="shadow-lg border-0">
              <CardHeader>
                <CardTitle>Next Steps</CardTitle>
                <CardDescription>Plans for the upcoming period</CardDescription>
              </CardHeader>
              <CardContent>
                {isDraft ? (
                  <Textarea
                    value={editableData.next_steps || ''}
                    onChange={(e) => setEditableData({...editableData, next_steps: e.target.value})}
                    rows={6}
                    className="font-serif"
                  />
                ) : (
                  <div className="prose max-w-none">
                    <ReactMarkdown>{report.next_steps}</ReactMarkdown>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}