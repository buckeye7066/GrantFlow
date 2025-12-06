import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Custom hook for managing compliance report detail data with RLS filtering
 * @param {string} reportId - The report ID to fetch
 * @param {Object} options
 * @param {Object} options.user - Current user object
 * @param {boolean} options.isAdmin - Whether user is admin
 * @param {boolean} options.enabled - Whether to enable data fetching
 */
export function useReportDetail(reportId, { user, isAdmin, enabled = true } = {}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editableData, setEditableData] = useState({});
  const [accessDenied, setAccessDenied] = useState(false);

  // Fetch report with RLS filtering
  const { data: report, isLoading: isLoadingReport, error: reportError } = useQuery({
    queryKey: ['complianceReport', reportId, user?.email, isAdmin],
    queryFn: async () => {
      // Try to get the report first
      const allReports = isAdmin
        ? await base44.entities.ComplianceReport.filter({ id: reportId })
        : await base44.entities.ComplianceReport.filter({ id: reportId, created_by: user.email });
      
      if (allReports.length === 0) {
        // Check if report exists but user doesn't have access
        if (!isAdmin) {
          const exists = await base44.entities.ComplianceReport.filter({ id: reportId });
          if (exists.length > 0) {
            setAccessDenied(true);
            return null;
          }
        }
        return null;
      }
      
      setAccessDenied(false);
      return allReports[0];
    },
    enabled: enabled && !!reportId && !!user?.email,
  });

  // Initialize editable data when report loads
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

  // Fetch grant with RLS filtering
  const { data: grant, isLoading: isLoadingGrant } = useQuery({
    queryKey: ['grant', report?.grant_id, user?.email, isAdmin],
    queryFn: async () => {
      const grants = isAdmin
        ? await base44.entities.Grant.filter({ id: report.grant_id })
        : await base44.entities.Grant.filter({ id: report.grant_id, created_by: user.email });
      return grants[0] || null;
    },
    enabled: enabled && !!report?.grant_id && !!user?.email,
  });

  // Fetch organization with RLS filtering
  const { data: organization, isLoading: isLoadingOrg } = useQuery({
    queryKey: ['organization', report?.organization_id, user?.email, isAdmin],
    queryFn: async () => {
      const orgs = isAdmin
        ? await base44.entities.Organization.filter({ id: report.organization_id })
        : await base44.entities.Organization.filter({ id: report.organization_id, created_by: user.email });
      return orgs[0] || null;
    },
    enabled: enabled && !!report?.organization_id && !!user?.email,
  });

  // Generate report mutation with permission check
  const generateReportMutation = useMutation({
    mutationFn: () => {
      // Verify permission before generating
      if (!isAdmin && report?.created_by !== user?.email) {
        throw new Error('Permission denied: You cannot generate this report.');
      }
      return base44.functions.invoke('generateReport', { report_id: reportId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['complianceReport', reportId, user?.email, isAdmin] });
      toast({
        title: 'Report Generated! ✨',
        description: 'AI has generated your compliance report. Review and edit as needed.',
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

  // Update report mutation with permission check
  const updateReportMutation = useMutation({
    mutationFn: (data) => {
      // Verify permission before updating
      if (!isAdmin && report?.created_by !== user?.email) {
        throw new Error('Permission denied: You cannot edit this report.');
      }
      return base44.entities.ComplianceReport.update(reportId, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['complianceReport', reportId, user?.email, isAdmin] });
      toast({
        title: 'Report Saved',
        description: 'Your changes have been saved.',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Save Failed',
        description: error.message,
      });
    }
  });

  // Memoized values
  const financialData = useMemo(() => {
    if (!report?.financial_data) return null;
    try {
      return JSON.parse(report.financial_data);
    } catch {
      return null;
    }
  }, [report?.financial_data]);

  const isDraft = useMemo(() => {
    return report?.status === 'draft' || report?.status === 'scheduled';
  }, [report?.status]);

  const isLoading = isLoadingReport || isLoadingGrant || isLoadingOrg;

  const handleSave = () => {
    if (!isAdmin && report?.created_by !== user?.email) {
      toast({
        variant: 'destructive',
        title: 'Permission Denied',
        description: 'You do not have permission to edit this report.',
      });
      return;
    }
    updateReportMutation.mutate(editableData);
  };

  const handleSubmit = () => {
    if (!isAdmin && report?.created_by !== user?.email) {
      toast({
        variant: 'destructive',
        title: 'Permission Denied',
        description: 'You do not have permission to submit this report.',
      });
      return;
    }
    updateReportMutation.mutate({
      ...editableData,
      status: 'submitted',
      submitted_date: new Date().toISOString()
    });
    toast({
      title: 'Report Submitted! 🎉',
      description: 'Your report has been marked as submitted.',
    });
  };

  const handleGenerate = () => {
    if (!isAdmin && report?.created_by !== user?.email) {
      toast({
        variant: 'destructive',
        title: 'Permission Denied',
        description: 'You do not have permission to generate this report.',
      });
      return;
    }
    generateReportMutation.mutate();
  };

  const updateField = (field, value) => {
    if (!isAdmin && report?.created_by !== user?.email) {
      return; // Silently ignore if no permission
    }
    setEditableData(prev => ({ ...prev, [field]: value }));
  };

  // Build error object with access denied code
  const error = accessDenied 
    ? { code: 'ACCESS_DENIED', message: 'You do not have permission to view this report.' }
    : reportError;

  return {
    report,
    grant,
    organization,
    financialData,
    editableData,
    isDraft,
    isLoading,
    isGenerating: generateReportMutation.isPending,
    isSaving: updateReportMutation.isPending,
    error,
    handleSave,
    handleSubmit,
    handleGenerate,
    updateField,
  };
}