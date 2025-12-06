import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Printer, X, Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useGrantsByStatus, GRANT_STATUSES } from '@/components/hooks/useGrantsByStatus';
import GrantStatusColumn from './GrantStatusColumn';
import { format } from 'date-fns';

/**
 * Status order optimized for usage frequency
 * Most active statuses first for better print layout
 */
const PRINT_STATUS_ORDER = [
  { value: "interested", label: "Assessment", icon: "🎯", color: "bg-blue-100 text-blue-700" },
  { value: "drafting", label: "Drafting", icon: "✍️", color: "bg-purple-100 text-purple-700" },
  { value: "application_prep", label: "Application Prep", icon: "📝", color: "bg-yellow-100 text-yellow-700" },
  { value: "submitted", label: "Submitted", icon: "📤", color: "bg-emerald-100 text-emerald-700" },
  { value: "awarded", label: "Awarded", icon: "🎉", color: "bg-green-100 text-green-700" },
  { value: "discovered", label: "Discovered", icon: "🔍", color: "bg-slate-100 text-slate-700" },
  { value: "revision", label: "Revision", icon: "🔄", color: "bg-orange-100 text-orange-700" },
  { value: "portal", label: "Portal Entry", icon: "🌐", color: "bg-indigo-100 text-indigo-700" },
  { value: "pending_review", label: "Under Review", icon: "⏳", color: "bg-cyan-100 text-cyan-700" },
  { value: "follow_up", label: "Follow Up", icon: "📞", color: "bg-teal-100 text-teal-700" },
  { value: "report", label: "Reporting", icon: "📊", color: "bg-blue-100 text-blue-700" },
  { value: "declined", label: "Declined", icon: "❌", color: "bg-red-100 text-red-700" },
  { value: "closed", label: "Closed", icon: "🔒", color: "bg-gray-100 text-gray-700" },
];

/**
 * PrintablePipeline - Print-optimized grant pipeline view
 * 
 * Features:
 * - Organized by grant status
 * - Print-friendly layout
 * - Auto-print option
 * - Loading and error states
 * - Accessible structure
 * 
 * @param {Object} props
 * @param {boolean} props.autoPrint - Automatically trigger print dialog on load
 */
export default function PrintablePipeline({ autoPrint = false }) {
  const [searchParams] = useSearchParams();
  const organizationId = searchParams.get('organization_id');
  const [isPrinting, setIsPrinting] = useState(false);

  // Fetch organization
  const { 
    data: organization, 
    isLoading: isLoadingOrg, 
    error: orgError 
  } = useQuery({
    queryKey: ['organization', organizationId],
    queryFn: () => base44.entities.Organization.get(organizationId),
    enabled: !!organizationId,
  });

  // Fetch grants for this organization
  const { 
    data: grants = [], 
    isLoading: isLoadingGrants, 
    error: grantsError 
  } = useQuery({
    queryKey: ['grants', organizationId],
    queryFn: () => base44.entities.Grant.filter({ organization_id: organizationId }),
    enabled: !!organizationId,
  });

  // Group grants by status
  const grantsByStatus = useGrantsByStatus(grants);

  // Handle auto-print
  useEffect(() => {
    if (autoPrint && !isLoadingOrg && !isLoadingGrants && organization && grants.length > 0) {
      // Small delay to ensure rendering is complete
      const timer = setTimeout(() => {
        handlePrint();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [autoPrint, isLoadingOrg, isLoadingGrants, organization, grants.length]);

  /**
   * Trigger print dialog
   */
  const handlePrint = () => {
    setIsPrinting(true);
    window.print();
    // Reset printing state after print dialog closes
    setTimeout(() => setIsPrinting(false), 1000);
  };

  /**
   * Close preview and return to previous page
   */
  const handleClose = () => {
    window.close();
    // Fallback if window.close() doesn't work
    if (window.history.length > 1) {
      window.history.back();
    }
  };

  // Loading state
  const isLoading = isLoadingOrg || isLoadingGrants;
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading pipeline...</p>
        </div>
      </div>
    );
  }

  // Error state
  const error = orgError || grantsError;
  if (error || !organization) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error?.message || 'Organization not found or could not load pipeline data.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Calculate stats
  const totalGrants = grants.length;
  const columnsWithGrants = PRINT_STATUS_ORDER.filter(
    status => grantsByStatus[status.value] && grantsByStatus[status.value].length > 0
  );

  // No grants state
  if (totalGrants === 0) {
    return (
      <div className="min-h-screen bg-slate-50">
        {/* Screen Header */}
        <div className="no-print bg-white border-b border-slate-200 p-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-slate-900">Grant Pipeline Preview</h1>
          <Button onClick={handleClose} variant="ghost" size="sm">
            <X className="w-4 h-4 mr-2" />
            Close
          </Button>
        </div>

        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="text-6xl mb-4">📋</div>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">No Grants Found</h2>
            <p className="text-slate-600">
              {organization.name} doesn't have any grants in their pipeline yet.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const generatedDate = format(new Date(), 'MMMM d, yyyy');

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Print Styles */}
      <style jsx global>{`
        @media print {
          @page {
            margin: 0.5in;
            size: letter landscape;
          }
          
          body {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          
          .no-print {
            display: none !important;
          }
          
          .print-root {
            padding: 0 !important;
            background: white !important;
          }
          
          .print-header {
            page-break-after: avoid;
          }
          
          .print-status-column {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          .print-grant-card {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          .print-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 1rem;
            page-break-inside: auto;
          }
        }
        
        @media screen {
          .print-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1.5rem;
          }
        }
      `}</style>

      {/* Screen-only Action Bar */}
      <div className="no-print bg-white border-b border-slate-200 p-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Grant Pipeline Preview</h1>
            <p className="text-sm text-slate-600 mt-1">
              {organization.name} • {totalGrants} grant{totalGrants !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button 
              onClick={handlePrint}
              disabled={isPrinting}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Printer className="w-4 h-4 mr-2" />
              {isPrinting ? 'Printing...' : 'Print Pipeline'}
            </Button>
            <Button onClick={handleClose} variant="ghost">
              <X className="w-4 h-4 mr-2" />
              Close
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="print-root p-6 max-w-7xl mx-auto">
        {/* Print Header */}
        <header className="print-header mb-6 pb-4 border-b-2 border-slate-300">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">
                {organization.name}
              </h1>
              <p className="text-sm text-slate-600 mt-1">Grant Pipeline Summary</p>
            </div>
            <div className="text-right text-sm text-slate-600">
              <p>Generated: {generatedDate}</p>
              <p className="font-semibold">{totalGrants} Total Grant{totalGrants !== 1 ? 's' : ''}</p>
              <p>{columnsWithGrants.length} Active Stage{columnsWithGrants.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
        </header>

        {/* Grant Columns Grid */}
        <div className="print-grid" role="main" aria-label="Grant pipeline organized by status">
          {columnsWithGrants.map((status) => {
            const statusGrants = grantsByStatus[status.value] || [];
            
            return (
              <GrantStatusColumn
                key={status.value}
                label={status.label}
                icon={status.icon}
                grants={statusGrants}
                colorClass={status.color}
              />
            );
          })}
        </div>

        {/* Footer */}
        <footer className="mt-8 pt-4 border-t border-slate-200 text-center text-xs text-slate-500">
          <p>Generated by GrantFlow • {generatedDate}</p>
          <p className="mt-1">Organization ID: {organizationId?.slice(0, 8)}</p>
        </footer>
      </div>
    </div>
  );
}