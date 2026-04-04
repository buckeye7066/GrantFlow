
import React from 'react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Printer, X, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import '@/styles/print.css';

// FIX: Expanded STATUSES to include ALL possible pipeline stages, ensuring no grants are missed during printing.
const STATUSES = [
  { value: "discovery", label: "Discovery" },
  { value: "discovered", label: "Discovered" },
  { value: "interested", label: "Assess" },
  { value: "drafting", label: "Drafting" },
  { value: "application_prep", label: "Application Prep" },
  { value: "revision", label: "Revision" },
  { value: "portal", label: "Portal" },
  { value: "submitted", label: "Submitted" },
  { value: "pending_review", label: "Pending Review" },
  { value: "follow_up", label: "Follow Up" },
  { value: "awarded", label: "Awarded" },
  { value: "report", label: "Reporting" },
  { value: "declined_no_review", label: "Declined (No Review)" },
  { value: "declined", label: "Declined" },
  { value: "closed", label: "Closed" },
];

const formatMoney = (amount) => {
    const parsed = typeof amount === 'number' ? amount : Number(amount);
    if (!Number.isFinite(parsed)) return null;
    return '$' + parsed.toLocaleString('en-US');
};

export default function PrintablePipeline({ grants = [], organization }) {
  const grantsByStatus = React.useMemo(() => {
    if (!grants) return {};
    return grants.reduce((acc, grant) => {
      const key = grant.status ?? "discovered";
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(grant);
      return acc;
    }, {});
  }, [grants]);
  
  // FIX: Final guard to prevent crash if organization object is temporarily unavailable.
  if (!organization) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="w-8 h-8 animate-spin" /> Loading...</div>;
  }
  
  const handleClose = () => {
    window.close();
  };

  const knownStatusValues = React.useMemo(() => new Set(STATUSES.map((s) => s.value)), []);
  const allStatuses = React.useMemo(() => {
    const unknownStatuses = Object.keys(grantsByStatus)
      .filter((k) => !knownStatusValues.has(k))
      .map((k) => ({ value: k, label: k }));
    return [...STATUSES, ...unknownStatuses];
  }, [grantsByStatus, knownStatusValues]);

  return (
      <div className="bg-white min-h-screen">
        <header className="p-4 sm:p-6 border-b bg-slate-50 flex justify-between items-center print:hidden">
            <div>
                <h1 className="text-2xl font-bold text-slate-900">Pipeline Report</h1>
                <p className="text-slate-600">For: {organization?.name ?? "Organization"}</p>
            </div>
            <div className="flex items-center gap-2">
                <Button variant="outline" onClick={handleClose}><X className="w-4 h-4 mr-2" />Close</Button>
            </div>
        </header>
        
        <div className="p-4 sm:p-8 gf-print-root" data-print-ready="true">
          <header className="hidden print:block gf-print-header mb-8">
            <div className="gf-title">
              <h1>Grant Pipeline Summary</h1>
              <div className="gf-meta">
                <span>{organization?.name ?? "Organization"}</span>
                <span>Generated on: {format(new Date(), 'P')}</span>
              </div>
            </div>
          </header>

          <main className="gf-print-body">
            <div className="gf-columns">
              {allStatuses.map((col) => {
                const columnGrants = grantsByStatus[col.value] ?? [];
                if (columnGrants.length === 0) return null;
                return (
                  <section key={col.value} className="gf-column">
                    <h2 className="gf-col-title">{col.label} ({columnGrants.length})</h2>
                    <div className="gf-cards">
                      {columnGrants.map(grant => (
                        <article key={grant.id} className="gf-card">
                          <h3 className="gf-card-title">{grant.title}</h3>
                          {grant.program_description && <p className="gf-card-summary">{grant.program_description}</p>}
                          <ul className="gf-card-meta">
                            {grant.funder && <li>{grant.funder}</li>}
                            {grant.deadline && !isNaN(Date.parse(grant.deadline)) && <li>Deadline: {format(new Date(grant.deadline), 'P')}</li>}
                            {grant.amount_max && <li>Award: {formatMoney(grant.amount_max)}</li>}
                          </ul>
                        </article>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </main>
        </div>
      </div>
  );
}
