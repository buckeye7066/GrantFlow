
import React from 'react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Printer, X, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

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
    if (typeof amount !== 'number') return null;
    return '$' + amount.toLocaleString('en-US');
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
              {STATUSES.map(col => {
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
                            {grant.deadline && !isNaN(new Date(grant.deadline)) && <li>Deadline: {format(new Date(grant.deadline), 'P')}</li>}
                            {grant.award_ceiling && <li>Award: {formatMoney(grant.award_ceiling)}</li>}
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
        <style dangerouslySetInnerHTML={{ __html: `
            @media screen {
              .gf-columns {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                gap: 1rem;
              }
              .gf-column {
                background-color: #f8fafc;
                border-radius: 0.5rem;
                padding: 1rem;
                border: 1px solid #e2e8f0;
              }
              .gf-col-title {
                font-size: 1rem;
                font-weight: 600;
                padding-bottom: 0.5rem;
                border-bottom: 1px solid #e2e8f0;
                margin-bottom: 1rem;
              }
              .gf-card {
                background: white;
                padding: 1rem;
                border-radius: 0.5rem;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                margin-bottom: 1rem;
              }
              .gf-card-title { font-weight: 600; margin-bottom: 0.25rem; }
              .gf-card-summary { font-size: 0.875rem; color: #475569; margin-bottom: 0.5rem; }
              .gf-card-meta { list-style: none; padding: 0; margin: 0; font-size: 0.75rem; color: #64748b; }
            }

            @media print {
              html, body { background: #fff !important; }
              .gf-print-root { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              @page { margin: 0.75in; }
              .gf-columns { display: block; }
              .gf-column { margin-bottom: 2rem; } /* FIX: Removed break-after: page; */
              .gf-col-title { font-size: 14px; font-weight: 700; margin-bottom: 10px; border-bottom: 2px solid #1e293b; padding-bottom: 3px; }
              .gf-cards { display: block; }
              .gf-card { page-break-inside: avoid; break-inside: avoid; margin: 12px 0 10px; padding-bottom: 8px; border-bottom: 1px solid #f1f5f9; }
              .gf-card-title { font-size: 13.5px; font-weight: 700; margin: 0 0 3px; line-height: 1.25; }
              .gf-card-summary { font-size: 12px; line-height: 1.45; color:#374151; margin: 0 0 6px; }
              .gf-card-meta { margin:0; padding:0; list-style:none; display:flex; gap:12px; flex-wrap:wrap; font-size:11px; color:#475569; }
            }
        `}} />
      </div>
  );
}
