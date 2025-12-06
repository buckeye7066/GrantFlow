import React from 'react';
import { format } from 'date-fns';
import { parseDateSafe } from '@/components/shared/dateUtils';
import { getProfileTypeMeta } from '@/components/shared/profileTypeUtils';

// Comprehensive status configuration with visual indicators
const STATUSES = [
  { value: "discovered", label: "Discovered", color: "slate", icon: "🔍" },
  { value: "interested", label: "Assessment", color: "blue", icon: "🎯" },
  { value: "drafting", label: "Drafting", color: "amber", icon: "✍️" },
  { value: "application_prep", label: "Application Prep", color: "orange", icon: "📝" },
  { value: "revision", label: "Revision", color: "yellow", icon: "🔄" },
  { value: "portal", label: "Portal Entry", color: "indigo", icon: "🌐" },
  { value: "submitted", label: "Submitted", color: "emerald", icon: "📤" },
  { value: "pending_review", label: "Under Review", color: "cyan", icon: "⏳" },
  { value: "follow_up", label: "Follow Up", color: "purple", icon: "📞" },
  { value: "awarded", label: "Awarded", color: "green", icon: "🎉" },
  { value: "report", label: "Reporting", color: "teal", icon: "📊" },
  { value: "declined", label: "Declined", color: "red", icon: "❌" },
  { value: "closed", label: "Closed", color: "gray", icon: "🔒" },
];

/**
 * Safely format a date for display
 * Handles rolling deadlines and invalid dates
 */
function formatDeadline(deadlineValue) {
  if (!deadlineValue) return null;
  
  if (typeof deadlineValue === 'string' && deadlineValue.toLowerCase() === 'rolling') {
    return 'Rolling';
  }
  
  const date = parseDateSafe(deadlineValue);
  if (!date) return null;
  
  try {
    return format(date, 'MMM d, yyyy');
  } catch (error) {
    return null;
  }
}

/**
 * Format monetary amount with proper handling of null/undefined
 * FIX: accept numeric strings and numbers
 */
function formatMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return '$' + n.toLocaleString('en-US');
}

/**
 * Build a concise summary from grant fields
 * Truncates to prevent overflow in print layout
 */
function buildGrantSummary(grant) {
  const parts = [];
  
  if (grant.funder) {
    parts.push(`Funder: ${grant.funder}`);
  }
  
  if (grant.program_description) {
    // Truncate long descriptions
    const desc = grant.program_description.length > 120 
      ? grant.program_description.slice(0, 117) + '...'
      : grant.program_description;
    parts.push(`About: ${desc}`);
  }
  
  if (grant.eligibility_summary) {
    const elig = grant.eligibility_summary.length > 100
      ? grant.eligibility_summary.slice(0, 97) + '...'
      : grant.eligibility_summary;
    parts.push(`Eligibility: ${elig}`);
  }
  
  return parts.join(' • ');
}

/**
 * Detail row component for profile information
 * Only renders if value exists
 */
const DetailRow = ({ label, value, fullWidth = false }) => {
  if (!value || (Array.isArray(value) && value.length === 0)) return null;
  
  const displayValue = Array.isArray(value) ? value.join(', ') : value;
  
  return (
    <div className={fullWidth ? 'gf-detail-full' : ''}>
      <dt className="gf-detail-label">{label}</dt>
      <dd className="gf-detail-value">{displayValue}</dd>
    </div>
  );
};

/**
 * Individual grant item component
 */
const GrantItem = ({ grant }) => {
  const deadline = formatDeadline(grant.deadline);
  const award = formatMoney(grant.award_ceiling ?? grant.typical_award);
  const summary = buildGrantSummary(grant);
  const isFiniteMatch = Number.isFinite(Number(grant.match_score));

  return (
    <article className="gf-grant-item">
      <div className="gf-grant-header">
        <h3 className="gf-grant-title">{grant.title || 'Untitled Grant'}</h3>
        {grant.starred && <span className="gf-grant-star" title="Priority">⭐</span>}
      </div>
      
      {summary && <p className="gf-grant-summary">{summary}</p>}
      
      <ul className="gf-grant-meta">
        {award && <li><strong>Award:</strong> {award}</li>}
        {deadline && <li><strong>Deadline:</strong> {deadline}</li>}
        {grant.opportunity_type && (
          <li><strong>Type:</strong> {String(grant.opportunity_type).replace(/_/g, ' ')}</li>
        )}
        {isFiniteMatch && (
          <li><strong>Match:</strong> {Number(grant.match_score)}%</li>
        )}
      </ul>
    </article>
  );
};

/**
 * Pipeline section grouped by status
 */
const PipelineSection = ({ status, grants }) => {
  const statusConfig = STATUSES.find(s => s.value === status) || 
    { label: 'Unknown Status', icon: '❓', color: 'gray' };
  
  return (
    <section className="gf-pipeline-section gf-section">
      <div className="gf-section-header">
        <span className="gf-status-icon" aria-hidden="true">{statusConfig.icon}</span>
        <h2 className="gf-section-title">
          {statusConfig.label}
          <span className="gf-count">({grants.length})</span>
        </h2>
      </div>
      
      <div className="gf-grant-list">
        {grants.map(grant => (
          <GrantItem key={grant.id} grant={grant} />
        ))}
      </div>
    </section>
  );
};

/**
 * PrintableProfile - Optimized profile and pipeline summary for PDF export
 * 
 * Features:
 * - Clean, print-optimized layout
 * - Robust date/number formatting with fallbacks
 * - Modular component structure
 * - Handles individual and organization profiles
 * - Safe handling of missing data
 */
export default function PrintableProfile({ 
  organization, 
  grants = [], 
  contactMethods = [],
  taxonomyItems = []
}) {
  // Determine profile type and metadata
  const profileMeta = React.useMemo(() => {
    if (!organization?.applicant_type) {
      return { label: 'Profile', category: 'organization' };
    }
    return getProfileTypeMeta(organization.applicant_type);
  }, [organization?.applicant_type]);

  // Extract contact information
  const emails = React.useMemo(() => 
    contactMethods.filter(c => c.type === 'email').map(e => e.value),
    [contactMethods]
  );
  
  const phones = React.useMemo(() => 
    contactMethods.filter(c => c.type === 'phone').map(p => p.value),
    [contactMethods]
  );

  // Group grants by status
  const grantsByStatus = React.useMemo(() => {
    const grouped = {};
    
    // Initialize all statuses
    STATUSES.forEach(s => {
      grouped[s.value] = [];
    });

    // Group grants
    grants.forEach(grant => {
      const status = grant.status || 'unknown';
      if (grouped[status]) {
        grouped[status].push(grant);
      } else {
        if (!grouped['unknown']) grouped['unknown'] = [];
        grouped['unknown'].push(grant);
      }
    });

    // Return only non-empty groups in order
    return STATUSES
      .filter(s => grouped[s.value] && grouped[s.value].length > 0)
      .map(s => ({ status: s.value, grants: grouped[s.value] }));
  }, [grants]);

  // FIX: coerce amounts to numbers safely
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Calculate stats
  const totalGrants = (grants || []).length;
  const totalAwardPotential = React.useMemo(() => {
    return (grants || []).reduce((sum, g) => sum + (toNum(g.award_ceiling) || toNum(g.typical_award)), 0);
  }, [grants]);
  
  // FIX: include extended pipeline statuses in "applied" calculation
  const appliedStatuses = new Set([
    'drafting',
    'application_prep',
    'revision',
    'portal',
    'submitted',
    'pending_review',
    'follow_up',
    'report',
    'awarded',
  ]);

  // Calculate total funding applied for (submitted/awarded grants)
  const totalFundingApplied = React.useMemo(() => {
    return (grants || [])
      .filter(g => appliedStatuses.has(g.status))
      .reduce((sum, g) => sum + (toNum(g.award_ceiling) || toNum(g.typical_award)), 0);
  }, [grants]);

  // Safety check
  if (!organization) {
    return (
      <div className="p-8">
        <p className="text-red-600">Error: No organization data provided</p>
      </div>
    );
  }

  const isIndividual = profileMeta.category !== 'organization';
  const generatedDate = format(new Date(), 'MMMM d, yyyy \'at\' h:mm a');

  return (
    <>
      {/* Inline script to set print mode */}
      <script dangerouslySetInnerHTML={{ __html: `
        window.__PRINT_MODE__ = true;
        (function(){
          const noop = function(){};
          window.dataLayer = window.dataLayer || [];
          window.gtag = window.gtag || noop;
          window.mixpanel = window.mixpanel || { init: noop, track: noop, people: { set: noop } };
        })();
      `}} />
      
      <div className="gf-print-root" data-print-ready="true">
        {/* Header */}
        <header className="gf-print-header">
          <div className="gf-header-main">
            <h1 className="gf-main-title">Profile & Pipeline Summary</h1>
            <p className="gf-profile-type">{profileMeta.label}</p>
          </div>
          
          <div className="gf-header-meta">
            <div className="gf-meta-item">
              <span className="gf-meta-label">Profile:</span>
              <span className="gf-meta-value">{organization.name}</span>
            </div>
            {organization.city && organization.state && (
              <div className="gf-meta-item">
                <span className="gf-meta-label">Location:</span>
                <span className="gf-meta-value">{organization.city}, {organization.state}</span>
              </div>
            )}
            {totalFundingApplied > 0 && (
              <div className="gf-meta-item gf-total-highlight">
                <span className="gf-meta-label">TOTAL:</span>
                <span className="gf-meta-value gf-total-value">{formatMoney(totalFundingApplied)}</span>
              </div>
            )}
            <div className="gf-meta-item">
              <span className="gf-meta-label">Generated:</span>
              <span className="gf-meta-value">{generatedDate}</span>
            </div>
          </div>
        </header>

        <main className="gf-print-body">
          {/* Core Information Section */}
          <section className="gf-core-section gf-section">
            <h2 className="gf-section-title">
              {isIndividual ? 'Personal Information' : 'Organization Information'}
            </h2>
            
            <dl className="gf-detail-grid">
              <DetailRow 
                label={isIndividual ? "Name" : "Organization Name"} 
                value={organization.name} 
              />
              
              {emails.length > 0 && <DetailRow label="Email" value={emails} />}
              {phones.length > 0 && <DetailRow label="Phone" value={phones} />}
              
              {!isIndividual && organization.website && (
                <DetailRow label="Website" value={organization.website} />
              )}
              
              {!isIndividual && organization.ein && (
                <DetailRow label="EIN" value={organization.ein} />
              )}
              
              {!isIndividual && organization.annual_budget && (
                <DetailRow 
                  label="Annual Budget" 
                  value={formatMoney(organization.annual_budget)} 
                />
              )}
              
              {!isIndividual && organization.staff_count && (
                <DetailRow label="Staff Count" value={organization.staff_count.toString()} />
              )}
              
              {organization.mission && (
                <DetailRow label="Mission" value={organization.mission} fullWidth />
              )}
              
              {organization.primary_goal && (
                <DetailRow label="Primary Goal" value={organization.primary_goal} fullWidth />
              )}
              
              {organization.target_population && (
                <DetailRow label="Target Population" value={organization.target_population} fullWidth />
              )}
              
              {organization.geographic_focus && (
                <DetailRow label="Geographic Focus" value={organization.geographic_focus} fullWidth />
              )}
              
              {organization.program_areas && organization.program_areas.length > 0 && (
                <DetailRow label="Program Areas" value={organization.program_areas} fullWidth />
              )}
              
              {organization.keywords && organization.keywords.length > 0 && (
                <DetailRow label="Keywords" value={organization.keywords} fullWidth />
              )}
            </dl>
          </section>

          {/* Pipeline Overview */}
          {totalGrants > 0 && (
            <section className="gf-overview-section gf-section">
              <h2 className="gf-section-title">Grant Pipeline Overview</h2>
              <div className="gf-stats-grid">
                <div className="gf-stat-card">
                  <div className="gf-stat-value">{totalGrants}</div>
                  <div className="gf-stat-label">
                    Total {profileMeta.opportunityLabel || 'Opportunities'}
                  </div>
                </div>
                {totalAwardPotential > 0 && (
                  <div className="gf-stat-card">
                    <div className="gf-stat-value">{formatMoney(totalAwardPotential)}</div>
                    <div className="gf-stat-label">Potential Funding</div>
                  </div>
                )}
                <div className="gf-stat-card">
                  <div className="gf-stat-value">{grantsByStatus.length}</div>
                  <div className="gf-stat-label">Active Stages</div>
                </div>
              </div>
            </section>
          )}

          {/* Pipeline Sections by Status */}
          {grantsByStatus.length > 0 ? (
            grantsByStatus.map(({ status, grants: statusGrants }) => (
              <PipelineSection 
                key={status} 
                status={status} 
                grants={statusGrants} 
              />
            ))
          ) : (
            <section className="gf-empty-section gf-section">
              <div className="gf-empty-state">
                <p className="gf-empty-icon" aria-hidden="true">📋</p>
                <h3 className="gf-empty-title">No Grants in Pipeline</h3>
                <p className="gf-empty-text">
                  Start discovering {profileMeta.opportunityLabel?.toLowerCase() || 'opportunities'} for this profile.
                </p>
              </div>
            </section>
          )}
        </main>

        {/* Footer */}
        <footer className="gf-print-footer">
          <div className="gf-footer-divider"></div>
          <p className="gf-footer-text">
            This summary was generated by GrantFlow on {format(new Date(), 'MMMM d, yyyy')}
          </p>
          <p className="gf-footer-note">
            Document ID: {organization.id?.slice(0, 8) || 'N/A'}
          </p>
        </footer>
      </div>

      {/* Print-optimized CSS */}
      <style jsx>{`
        @media print {
          @page {
            margin: 0.75in;
            size: letter portrait;
          }
          
          body {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          
          .gf-print-root {
            font-size: 10pt;
            line-height: 1.4;
            color: #1e293b;
          }
        }
        
        .gf-print-root {
          max-width: 8.5in;
          margin: 0 auto;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: white;
        }
        
        .gf-print-header {
          margin-bottom: 24px;
          padding-bottom: 16px;
          border-bottom: 2px solid #e2e8f0;
        }
        
        .gf-main-title {
          font-size: 24pt;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 4px 0;
        }
        
        .gf-profile-type {
          font-size: 12pt;
          color: #64748b;
          font-weight: 500;
          margin: 0;
        }
        
        .gf-header-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
          margin-top: 12px;
          font-size: 9pt;
        }
        
        .gf-meta-item {
          display: flex;
          gap: 4px;
        }
        
        .gf-meta-label {
          color: #64748b;
          font-weight: 600;
        }
        
        .gf-meta-value {
          color: #1e293b;
        }
        
        .gf-total-highlight {
          padding: 4px 12px;
          background: #dbeafe;
          border-radius: 4px;
        }
        
        .gf-total-value {
          font-weight: 700;
          color: #1e40af;
          font-size: 10pt;
        }
        
        .gf-section {
          margin-bottom: 24px;
          page-break-inside: avoid;
        }
        
        .gf-section-title {
          font-size: 14pt;
          font-weight: 600;
          color: #0f172a;
          margin: 0 0 12px 0;
          padding-bottom: 6px;
          border-bottom: 1px solid #e2e8f0;
        }
        
        .gf-detail-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px 24px;
          margin: 0;
        }
        
        .gf-detail-grid > div {
          display: contents;
        }
        
        .gf-detail-full {
          grid-column: 1 / -1;
        }
        
        .gf-detail-label {
          font-weight: 600;
          color: #475569;
          font-size: 9pt;
          margin: 0;
        }
        
        .gf-detail-value {
          color: #1e293b;
          font-size: 9pt;
          margin: 0;
          word-break: break-word;
        }
        
        .gf-stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 16px;
        }
        
        .gf-stat-card {
          padding: 12px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          text-align: center;
        }
        
        .gf-stat-value {
          font-size: 20pt;
          font-weight: 700;
          color: #0f172a;
        }
        
        .gf-stat-label {
          font-size: 8pt;
          color: #64748b;
          margin-top: 4px;
        }
        
        .gf-section-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }
        
        .gf-status-icon {
          font-size: 16pt;
        }
        
        .gf-count {
          font-weight: 400;
          color: #64748b;
          font-size: 11pt;
          margin-left: 6px;
        }
        
        .gf-grant-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        
        .gf-grant-item {
          padding: 12px;
          border: 1px solid #e2e8f0;
          border-radius: 4px;
          background: #f8fafc;
          page-break-inside: avoid;
        }
        
        .gf-grant-header {
          display: flex;
          justify-content: space-between;
          align-items: start;
          margin-bottom: 6px;
        }
        
        .gf-grant-title {
          font-size: 11pt;
          font-weight: 600;
          color: #0f172a;
          margin: 0;
          flex: 1;
        }
        
        .gf-grant-star {
          font-size: 12pt;
          margin-left: 8px;
        }
        
        .gf-grant-summary {
          font-size: 8.5pt;
          color: #475569;
          margin: 0 0 8px 0;
          line-height: 1.3;
        }
        
        .gf-grant-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin: 0;
          padding: 0;
          list-style: none;
          font-size: 8pt;
          color: #64748b;
        }
        
        .gf-grant-meta li {
          margin: 0;
        }
        
        .gf-empty-section {
          padding: 40px 20px;
          text-align: center;
        }
        
        .gf-empty-icon {
          font-size: 48pt;
          margin-bottom: 12px;
        }
        
        .gf-empty-title {
          font-size: 14pt;
          font-weight: 600;
          color: #475569;
          margin: 0 0 8px 0;
        }
        
        .gf-empty-text {
          font-size: 10pt;
          color: #64748b;
          margin: 0;
        }
        
        .gf-print-footer {
          margin-top: 32px;
          padding-top: 16px;
        }
        
        .gf-footer-divider {
          height: 1px;
          background: #e2e8f0;
          margin-bottom: 12px;
        }
        
        .gf-footer-text {
          font-size: 8pt;
          color: #64748b;
          margin: 0 0 4px 0;
          text-align: center;
        }
        
        .gf-footer-note {
          font-size: 7pt;
          color: #94a3b8;
          margin: 0;
          text-align: center;
        }
        
        @media print {
          .gf-section {
            page-break-after: auto;
          }
          
          .gf-grant-item {
            page-break-inside: avoid;
          }
        }
      `}</style>
    </>
  );
}