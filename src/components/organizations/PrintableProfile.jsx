
import React from 'react';
import { format } from 'date-fns';

// FIX: Expanded STATUSES to include ALL possible pipeline stages, ensuring no grants are missed.
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

const capitalize = (s) => s && s.charAt(0).toUpperCase() + s.slice(1);

function buildSummary(grant) {
  const parts = [
    grant.funder && `Source: ${grant.funder}`,
    grant.program_description && `Focus: ${grant.program_description}`,
    grant.eligibility_summary && `Eligible: ${grant.eligibility_summary}`
  ].filter(Boolean);
  const s = parts.join(' · ');
  return s.length > 180 ? s.slice(0, 177) + '…' : s;
}

const formatMoney = (amount) => {
    if (typeof amount !== 'number' || !isFinite(amount)) return 'N/A';
    return '$' + amount.toLocaleString('en-US');
};

const DetailRow = ({ label, value }) => {
    if (!value || (Array.isArray(value) && value.length === 0)) return null;
    const displayValue = Array.isArray(value) ? value.join(', ') : value;
    return (
        <>
            <dt>{label}</dt>
            <dd>{displayValue}</dd>
        </>
    );
};

export default function PrintableProfile({ organization, grants = [], contactMethods = [], subtitle = '' }) {
  // The 'ready' state and useEffect for `data-print-ready` are removed as per the outline's direct setting to "true".

  const grantsByStatus = React.useMemo(() => {
    const grouped = {};
    // Initialize grouped object with all possible statuses to maintain order and labels
    STATUSES.forEach(s => {
      grouped[s.value] = { label: s.label, grants: [] };
    });

    // Populate the groups with actual grants
    grants.forEach(grant => {
      if (grant.status && grouped[grant.status]) {
        grouped[grant.status].grants.push(grant);
      } else {
        // Distinguish missing status from unrecognised status for observability
        if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production') {
           
          console.warn('[PrintableProfile] Grant with unexpected status:', grant.id, grant.status);
        }
        if (!grouped['unknown']) {
          grouped['unknown'] = { label: "Unknown Status", grants: [] };
        }
        grouped['unknown'].grants.push(grant);
      }
    });

    // Create an ordered array of statuses that actually have grants
    const orderedAndFiltered = STATUSES.map(s => {
      const statusGroup = grouped[s.value];
      return statusGroup && statusGroup.grants.length > 0
        ? { value: s.value, label: statusGroup.label, grants: statusGroup.grants }
        : null;
    }).filter(Boolean); // Filter out empty status groups

    // If there are any 'unknown' grants, add them at the end
    if (grouped['unknown'] && grouped['unknown'].grants.length > 0) {
      orderedAndFiltered.push(grouped['unknown']);
    }

    return orderedAndFiltered;
  }, [grants]);

  const emails = contactMethods.filter(c => c.type === 'email');
  const phones = contactMethods.filter(c => c.type === 'phone');

  // Disable analytics in print mode using React useEffect instead of script injection
  React.useEffect(() => {
    window.__PRINT_MODE__ = true;
    // Disable analytics calls
    const noop = function(){};
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || noop;
    window.mixpanel = window.mixpanel || { init: noop, track: noop, people: { set: noop } };
    
    return () => {
      window.__PRINT_MODE__ = false;
    };
  }, []);

  return (
    <>
      {/* Updated root div className and data-print-ready attribute */}
      <div className="p-4 sm:p-8 gf-print-root" data-print-ready="true">
        <header className="gf-print-header">
          <div className="gf-title">
            <h1>Profile &amp; Grant Pipeline Summary</h1>
            {subtitle && <p className="gf-subtitle">{subtitle}</p>} {/* Display subtitle if provided */}
            <div className="gf-meta">
              <span className="gf-org">{organization?.name}</span>
              <span className="gf-date">Generated on: {format(new Date(), 'PPP')}</span>
              {organization?.city && organization?.state && (
                <span className="gf-loc">{organization.city}, {organization.state}</span>
              )}
            </div>
          </div>
        </header>

        <main className="gf-print-body">
          <section className="gf-core gf-section">
            <h2>Core Information</h2>
            <dl className="gf-core-grid">
              <DetailRow label="Organization Name" value={organization?.name} />
              {emails.length > 0 && <DetailRow label="Email" value={emails.map(e => e.value)} />}
              {phones.length > 0 && <DetailRow label="Phone" value={phones.map(p => p.value)} />}
              <DetailRow label="Mission" value={organization?.mission} />
              <DetailRow label="Primary Goal" value={organization?.primary_goal} />
              <DetailRow label="Target Population" value={organization?.target_population} />
              <DetailRow label="Track Record" value={organization?.past_experience} />
            </dl>
          </section>

          {/* Conditional rendering for grant pipeline sections, grouped by status */}
          {grantsByStatus.length > 0 && (
            // You can optionally add a general pipeline overview title here if desired
            // <section className="gf-pipeline-overview gf-section">
            //   <h2>Grant Pipeline</h2>
            // </section>
            // Iterating directly over statuses, each getting its own section
            grantsByStatus.map(({ label, grants: grantsForStatus }) =>
              grantsForStatus.length > 0 && ( // Ensure we only render sections for statuses with grants
                <section key={label} className="gf-pipeline-section gf-section">
                  <h2>{label} ({grantsForStatus.length})</h2>
                  <div className="gf-list">
                    {grantsForStatus.map(grant => (
                      <article key={grant.id} className="gf-item">
                        <h3 className="gf-item-title">{grant.title}</h3>
                        <p className="gf-item-summary">{buildSummary(grant)}</p>
                        {(grant.amount_max || grant.deadline || grant.opportunity_type) && (
                            <ul className="gf-item-meta">
                              {grant.amount_max && <li>Typical Award: {formatMoney(grant.amount_max)}</li>}
                              {grant.deadline && !isNaN(new Date(grant.deadline)) && <li>Deadline: {format(new Date(grant.deadline), 'P')}</li>}
                              {grant.opportunity_type && <li>Category: {grant.opportunity_type.replace(/_/g, ' ')}</li>}
                              {grant.application_url && (
                                <li>Apply: <a href={grant.application_url} target="_blank" rel="noopener noreferrer" className="gf-item-url">{grant.application_url}</a></li>
                              )}
                            </ul>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )
            )
          )}
        </main>
      </div>
    </>
  );
}
