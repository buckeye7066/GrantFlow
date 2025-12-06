import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Sparkles, Loader2, FileText, Download, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export default function ReportGenerator({ grant }) {
  const navigate = useNavigate();
  const [reportingPeriodStart, setReportingPeriodStart] = useState('');
  const [reportingPeriodEnd, setReportingPeriodEnd] = useState('');
  const [reportType, setReportType] = useState('progress');
  const [selectedSections, setSelectedSections] = useState([
    'executive_summary',
    'activities_summary',
    'progress_toward_goals',
    'financial_summary',
    'challenges_and_solutions',
    'next_steps'
  ]);
  const [generatedReport, setGeneratedReport] = useState(null);

  const queryClient = useQueryClient();

  const generateMutation = useMutation({
    mutationFn: async (data) => {
      const response = await base44.functions.invoke('generateProgressReport', { body: data });
      return response.data;
    },
    onSuccess: (data) => {
      setGeneratedReport(data);
      queryClient.invalidateQueries({ queryKey: ['allReports'] });
      toast.success('Report generated successfully!');
    },
    onError: (error) => {
      toast.error(`Failed to generate report: ${error.message}`);
    }
  });

  const handleGenerate = () => {
    if (!reportingPeriodStart || !reportingPeriodEnd) {
      toast.error('Please select reporting period dates');
      return;
    }

    if (selectedSections.length === 0) {
      toast.error('Please select at least one section');
      return;
    }

    generateMutation.mutate({
      grant_id: grant.id,
      report_type: reportType,
      reporting_period_start: reportingPeriodStart,
      reporting_period_end: reportingPeriodEnd,
      sections: selectedSections
    });
  };

  const allSections = [
    { id: 'executive_summary', label: 'Executive Summary', description: 'High-level overview' },
    { id: 'activities_summary', label: 'Activities Summary', description: 'Detailed activities' },
    { id: 'progress_toward_goals', label: 'Progress Toward Goals', description: 'Goal achievement' },
    { id: 'financial_summary', label: 'Financial Summary', description: 'Budget & spending' },
    { id: 'challenges_and_solutions', label: 'Challenges & Solutions', description: 'Problems addressed' },
    { id: 'next_steps', label: 'Next Steps', description: 'Future plans' }
  ];

  const toggleSection = (sectionId) => {
    setSelectedSections(prev =>
      prev.includes(sectionId)
        ? prev.filter(id => id !== sectionId)
        : [...prev, sectionId]
    );
  };

  return (
    <div className="space-y-6">
      <Card className="border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-600" />
            AI Report Generator
          </CardTitle>
          <CardDescription>
            Automatically generate comprehensive progress reports based on your grant data
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <FileText className="h-4 w-4" />
            <AlertDescription>
              AI will analyze your KPIs, expenses, milestones, and previous reports to create a 
              professional narrative report. You can review and edit before submission.
            </AlertDescription>
          </Alert>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <Label>Reporting Period Start</Label>
              <Input
                type="date"
                value={reportingPeriodStart}
                onChange={(e) => setReportingPeriodStart(e.target.value)}
              />
            </div>
            <div>
              <Label>Reporting Period End</Label>
              <Input
                type="date"
                value={reportingPeriodEnd}
                onChange={(e) => setReportingPeriodEnd(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label className="mb-3 block">Report Sections to Generate</Label>
            <div className="space-y-2">
              {allSections.map((section) => (
                <div key={section.id} className="flex items-start gap-3 p-3 rounded-lg bg-white border border-slate-200">
                  <Checkbox
                    checked={selectedSections.includes(section.id)}
                    onCheckedChange={() => toggleSection(section.id)}
                  />
                  <div className="flex-1">
                    <p className="font-medium text-sm">{section.label}</p>
                    <p className="text-xs text-slate-600">{section.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Button
            onClick={handleGenerate}
            disabled={generateMutation.isPending}
            className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
            size="lg"
          >
            {generateMutation.isPending ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Generating Report...
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5 mr-2" />
                Generate Progress Report
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {generatedReport && (
        <Card className="border-2 border-green-200 bg-green-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-900">
              <CheckCircle2 className="w-6 h-6" />
              Report Generated Successfully
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-3 gap-4 text-sm">
              <div className="p-3 bg-white rounded-lg">
                <p className="text-slate-600">KPIs Analyzed</p>
                <p className="text-2xl font-bold text-slate-900">{generatedReport.kpi_count}</p>
              </div>
              <div className="p-3 bg-white rounded-lg">
                <p className="text-slate-600">Total Spent</p>
                <p className="text-2xl font-bold text-slate-900">
                  ${generatedReport.total_spent?.toLocaleString()}
                </p>
              </div>
              <div className="p-3 bg-white rounded-lg">
                <p className="text-slate-600">Milestones Done</p>
                <p className="text-2xl font-bold text-slate-900">
                  {generatedReport.milestones_completed}
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={() => navigate(createPageUrl(`ComplianceReportDetail?id=${generatedReport.report_id}`))}
                className="flex-1"
              >
                <FileText className="w-4 h-4 mr-2" />
                View & Edit Report
              </Button>
              <Button variant="outline">
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
            </div>

            <Alert>
              <AlertDescription className="text-sm text-slate-600">
                💡 <strong>Next Steps:</strong> Review the generated report, make any necessary edits, 
                attach supporting documents, and submit before the deadline.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      )}
    </div>
  );
}