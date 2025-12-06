import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, ArrowLeft } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Custom hook
import { useReportDetail } from '@/components/hooks/useReportDetail';

// UI Components
import ReportToolbar from '@/components/compliance/ReportToolbar';
import ReportMetaCard from '@/components/compliance/ReportMetaCard';
import NarrativeSection from '@/components/compliance/NarrativeSection';
import ActivitiesSection from '@/components/compliance/ActivitiesSection';
import FinancialSection from '@/components/compliance/FinancialSection';
import ChallengesSection from '@/components/compliance/ChallengesSection';
import NextStepsSection from '@/components/compliance/NextStepsSection';
import EmptyReportState from '@/components/compliance/EmptyReportState';

export default function ComplianceReportDetail() {
  const urlParams = new URLSearchParams(window.location.search);
  const reportId = urlParams.get('id');

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  const {
    report,
    grant,
    organization,
    financialData,
    editableData,
    isDraft,
    isLoading: isDetailLoading,
    isGenerating,
    isSaving,
    error,
    handleSave,
    handleSubmit,
    handleGenerate,
    updateField,
  } = useReportDetail(reportId, { user, isAdmin, enabled: !!user?.email });

  // Combined loading state
  if (isLoadingUser || isDetailLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  // Access denied state
  if (!report && error?.code === 'ACCESS_DENIED') {
    return (
      <div className="p-8 text-center">
        <p className="text-red-600 font-semibold">Access denied.</p>
        <p className="text-slate-600 mt-2">
          You do not have permission to view this compliance report.
        </p>
      </div>
    );
  }

  // Error state
  if (!report) {
    return (
      <div className="p-8 text-center">
        <p className="text-slate-600">Report not found.</p>
      </div>
    );
  }

  // Check if user can edit (admin or owner)
  const canEdit = isAdmin || report.created_by === user?.email;
  const hasContent = !!report.narrative;

  return (
    <div className="p-6 md:p-8 min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
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

            <ReportToolbar
              isDraft={isDraft && canEdit}
              hasContent={hasContent}
              isGenerating={isGenerating}
              isSaving={isSaving}
              onGenerate={canEdit ? handleGenerate : undefined}
              onSave={canEdit ? handleSave : undefined}
              onSubmit={canEdit ? handleSubmit : undefined}
              disabled={!canEdit}
            />
          </div>
        </div>

        {/* Report Details */}
        <ReportMetaCard
          report={report}
          organization={organization}
          financialData={financialData}
        />

        {/* Report Content */}
        {!hasContent ? (
          <div className="mt-6">
            <EmptyReportState
              reportType={report.report_type}
              isGenerating={isGenerating}
              onGenerate={canEdit ? handleGenerate : undefined}
            />
          </div>
        ) : (
          <div className="space-y-6 mt-6">
            <NarrativeSection
              value={editableData.narrative}
              onChange={canEdit ? (value) => updateField('narrative', value) : undefined}
              isDraft={isDraft && canEdit}
            />

            <ActivitiesSection
              value={editableData.activities_summary}
              onChange={canEdit ? (value) => updateField('activities_summary', value) : undefined}
              isDraft={isDraft && canEdit}
            />

            <FinancialSection financialData={financialData} />

            <ChallengesSection
              value={editableData.challenges_faced}
              onChange={canEdit ? (value) => updateField('challenges_faced', value) : undefined}
              isDraft={isDraft && canEdit}
            />

            <NextStepsSection
              value={editableData.next_steps}
              onChange={canEdit ? (value) => updateField('next_steps', value) : undefined}
              isDraft={isDraft && canEdit}
            />
          </div>
        )}
      </div>
    </div>
  );
}