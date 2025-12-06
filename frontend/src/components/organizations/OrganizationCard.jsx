import React, { useMemo, useState, useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MapPin, TrendingUp, DollarSign, Send, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

// Utilities and subcomponents
import { 
  getProfileTypeMeta, 
  formatGradeLevel,
  getAssistanceCategoryLabels 
} from "@/components/shared/profileTypeUtils";
import { formatDateSafe } from "@/components/shared/dateUtils";
import ProfileImage from "./card/ProfileImage";
import ActionButtons from "./card/ActionButtons";
import StudentInfo from "./card/StudentInfo";
import IndividualInfo from "./card/IndividualInfo";
import TagList from "./card/TagList";

/**
 * SubmissionDropdown - Simple dropdown for grants ready to submit
 */
function SubmissionDropdown({ grants }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={menuRef}>
      <Button 
        variant="outline" 
        size="sm" 
        className="w-full justify-between gap-2 bg-orange-50 border-orange-300 text-orange-700 hover:bg-orange-100"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span className="flex items-center gap-2">
          <Send className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">Ready for Submission ({grants.length})</span>
        </span>
        <ChevronDown className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
      </Button>

      {isOpen && (
        <div 
          role="menu"
          className="absolute right-0 mt-2 w-64 rounded-md border bg-white shadow-lg z-50"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b">
            <p className="text-sm font-semibold text-slate-900">Ready for Submission</p>
          </div>
          <div className="py-1 max-h-64 overflow-y-auto">
            {grants.map(grant => (
              <Link 
                key={grant.id}
                to={createPageUrl(`GrantDetail?id=${grant.id}`)}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOpen(false);
                }}
                className="flex flex-col gap-1 px-3 py-2 hover:bg-slate-50 transition-colors"
              >
                <span className="font-medium text-sm line-clamp-1">{grant.title}</span>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Badge variant="outline" className="text-xs">
                    {String(grant.status || '').replace(/_/g, ' ')}
                  </Badge>
                  {grant.deadline && (
                    <span>Due: {formatDateSafe(grant.deadline, 'M/d/yyyy', 'TBD')}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * OrganizationCard - Displays organization/student/individual profile summary
 * 
 * Features:
 * - Type-specific styling and icons
 * - Conditional field display based on applicant type
 * - Action buttons for edit, delete, invoice, automated search
 * - Billing summary with paid/unpaid breakdown
 * - Responsive layout with hover effects
 */
export default function OrganizationCard({ 
  organization, 
  grantCount, 
  isSelected, 
  onClick, 
  onEdit, 
  onAutomatedSearch, 
  onDelete, 
  onInvoice 
}) {
  // Get type-specific metadata (color scheme, icon)
  const typeMeta = getProfileTypeMeta(organization.applicant_type);
  const { colorScheme, icon: Icon, category, opportunityLabel } = typeMeta;

  // Fetch billing data for this organization
  const { data: invoices = [] } = useQuery({
    queryKey: ['invoices', organization.id],
    queryFn: () => base44.entities.Invoice.filter({ organization_id: organization.id }),
    enabled: !!organization.id
  });

  // Fetch grants for submission dropdown and grant funding stats
  const { data: grants = [] } = useQuery({
    queryKey: ['grants', organization.id],
    queryFn: () => base44.entities.Grant.filter({ organization_id: organization.id }),
    enabled: !!organization.id
  });

  // FIX: Fetch only needed invoice lines by IDs, include invoices in query key for proper cache invalidation
  const { data: invoiceLines = [] } = useQuery({
    queryKey: ['invoiceLines', organization.id, invoices.map(i => i.id).join(',')],
    queryFn: async () => {
      const orgInvoiceIds = invoices.map(inv => inv.id);
      if (orgInvoiceIds.length === 0) return [];
      // Fallback: list + filter (API may not support $in)
      const allLines = await base44.entities.InvoiceLine.list();
      return allLines.filter(line => orgInvoiceIds.includes(line.invoice_id));
    },
    enabled: invoices.length > 0
  });

  // FIX: Safer numeric coercion helper
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Calculate grant funding totals for submitted/in-progress applications
  const grantStats = useMemo(() => {
    // Count grants that are submitted or in application process
    const appliedGrants = grants.filter(g => 
      ['drafting', 'application_prep', 'revision', 'portal', 'submitted', 'awarded'].includes(g.status)
    );
    
    const total = appliedGrants.reduce((sum, g) => {
      const amount = toNum(g.award_ceiling) || toNum(g.award_floor);
      return sum + amount;
    }, 0);

    // Breakdown by funder name (actual funding source)
    const funderBreakdown = {};
    appliedGrants.forEach(grant => {
      const funderName = grant.funder || 'Unknown Funder';
      const amount = toNum(grant.award_ceiling) || toNum(grant.award_floor);
      funderBreakdown[funderName] = (funderBreakdown[funderName] || 0) + amount;
    });

    return {
      total,
      funderBreakdown,
      grantCount: appliedGrants.length
    };
  }, [grants]);

  // Calculate total value of ALL matching grants (all statuses except declined/closed)
  const matchingGrantsTotal = useMemo(() => {
    const matchingGrants = grants.filter(g => 
      !['declined', 'closed'].includes(g.status)
    );
    
    return matchingGrants.reduce((sum, g) => {
      const amount = toNum(g.award_ceiling) || toNum(g.award_floor);
      return sum + amount;
    }, 0);
  }, [grants]);

  // Calculate billing totals
  const billingStats = useMemo(() => {
    const total = invoices.reduce((sum, inv) => sum + toNum(inv.total), 0);
    const paid = invoices
      .filter(inv => inv.status === 'Paid')
      .reduce((sum, inv) => sum + toNum(inv.total), 0);
    const unpaid = Math.max(0, total - paid);

    // Category breakdown
    const categoryBreakdown = {};
    invoiceLines.forEach(line => {
      const cat = line.task_category || 'Other';
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + toNum(line.amount);
    });

    return {
      total,
      paid,
      unpaid,
      categoryBreakdown,
      invoiceCount: invoices.length
    };
  }, [invoices, invoiceLines]);

  // Fetch taxonomy for assistance categories (only for individuals)
  const { data: taxonomyItems = [] } = useQuery({
    queryKey: ['taxonomy'],
    queryFn: () => base44.entities.Taxonomy.list(),
    enabled: category === 'individual' && !!organization.assistance_categories,
  });

  // Memoize assistance category labels
  const assistanceCategoryLabels = useMemo(() => {
    if (category !== 'individual' || !organization.assistance_categories) return [];
    return getAssistanceCategoryLabels(
      organization.assistance_categories, 
      taxonomyItems, 
      2
    );
  }, [category, organization.assistance_categories, taxonomyItems]);

  // Memoize grade level labels
  const gradeLevelLabels = useMemo(() => {
    if (category !== 'student') return [];
    
    const levels = organization.student_grade_levels || 
                   (organization.student_grade_level ? [organization.student_grade_level] : []);
    
    return levels.map(formatGradeLevel);
  }, [category, organization.student_grade_levels, organization.student_grade_level]);

  const borderClass = isSelected 
    ? `${colorScheme.border} shadow-xl` 
    : 'border-transparent';

  const showGrantFunding = grantStats.total > 0;
  const showBilling = billingStats.total > 0 && !showGrantFunding; // Only show billing if no grant funding
  const showMatchingTotal = matchingGrantsTotal > 0 && !showGrantFunding && !showBilling;

  // Filter grants ready for submission
  const readyForSubmission = useMemo(() => {
    return grants.filter(g => {
      if (!['portal', 'revision', 'application_prep'].includes(g.status)) return false;
      if (!g.deadline) return false;
      
      const deadlineDate = new Date(g.deadline);
      if (isNaN(deadlineDate.getTime())) return false; // Invalid date
      
      return deadlineDate > new Date();
    });
  }, [grants]);

  return (
    <Card 
      className={`hover:shadow-xl transition-all duration-300 border-2 overflow-hidden group cursor-pointer ${borderClass}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`View ${organization.name} profile`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {/* Color accent bar */}
      <div className={`h-1.5 bg-gradient-to-r ${colorScheme.gradient}`} />
      
      <CardContent className="p-4">
        {/* Header: Image, Name, Actions */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-start gap-4 flex-1">
            <ProfileImage
              imageUrl={organization.profile_image_url}
              name={organization.name}
              Icon={Icon}
              colorScheme={colorScheme}
            />
            
            <div className="flex-1">
              <div className="flex items-baseline gap-2">
                <h3 className="font-bold text-slate-900 text-base leading-tight">
                  {organization.name}
                </h3>
                {grantStats.total > 0 && (
                  <span className="text-xs font-semibold text-blue-600 whitespace-nowrap">
                    ${(grantStats.total / 1000).toFixed(0)}K
                  </span>
                )}
              </div>
              {organization.applicant_type && (
                <Badge variant="outline" className="mt-1.5 text-xs">
                  {String(organization.applicant_type).replace(/_/g, ' ')}
                </Badge>
              )}
            </div>
          </div>
          
          <ActionButtons
            organization={organization}
            onEdit={onEdit}
            onDelete={onDelete}
            onInvoice={onInvoice}
            onAutomatedSearch={onAutomatedSearch}
          />
        </div>

        {/* Grant Funding Summary */}
        {showGrantFunding && (
          <div className="mb-4 p-3 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg border border-blue-200">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-blue-700" />
                <span className="text-xs font-semibold text-blue-900 uppercase">Total</span>
              </div>
              <p className="text-xl font-bold text-blue-900">
                ${grantStats.total.toLocaleString()}
              </p>
            </div>

            {/* Breakdown by Funding Source */}
            {Object.keys(grantStats.funderBreakdown).length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-slate-700 mb-1">By Funding Source:</p>
                {Object.entries(grantStats.funderBreakdown)
                  .filter(([, amount]) => amount > 0)
                  .sort(([, a], [, b]) => b - a)
                  .map(([funder, amount]) => (
                    <div key={funder} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600 truncate max-w-[180px]" title={funder}>{funder}</span>
                      <span className="font-semibold text-slate-900 ml-2">
                        ${amount.toLocaleString()}
                      </span>
                    </div>
                  ))}
              </div>
            )}

            <div className="mt-2 pt-2 border-t border-blue-200">
              <p className="text-xs text-slate-600">
                {grantStats.grantCount} application{grantStats.grantCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        )}

        {/* Matching Grants Total */}
        {showMatchingTotal && (
          <div className="mb-4 p-3 bg-gradient-to-br from-purple-50 to-indigo-50 rounded-lg border border-purple-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-purple-700" />
                <span className="text-xs font-semibold text-purple-900 uppercase">Matching Grants</span>
              </div>
              <p className="text-xl font-bold text-purple-900">
                ${matchingGrantsTotal.toLocaleString()}
              </p>
            </div>
            <div className="mt-2 pt-2 border-t border-purple-200">
              <p className="text-xs text-slate-600">
                Total value of {grantCount} potential opportunit{grantCount !== 1 ? 'ies' : 'y'}
              </p>
            </div>
          </div>
        )}

        {/* Billing Summary */}
        {showBilling && (
          <div className="mb-4 p-3 bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg border border-green-200">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-green-700" />
                <span className="text-xs font-semibold text-green-900 uppercase">Total Billing</span>
              </div>
              <p className="text-xl font-bold text-green-900">
                ${billingStats.total.toLocaleString()}
              </p>
            </div>

            {/* Paid vs Unpaid */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="p-2 bg-white rounded border border-green-200">
                <p className="text-xs text-slate-600">Paid</p>
                <p className="text-sm font-bold text-green-600">
                  ${billingStats.paid.toLocaleString()}
                </p>
              </div>
              <div className="p-2 bg-white rounded border border-amber-200">
                <p className="text-xs text-slate-600">Unpaid</p>
                <p className="text-sm font-bold text-amber-600">
                  ${billingStats.unpaid.toLocaleString()}
                </p>
              </div>
            </div>

            {/* Category Breakdown */}
            {Object.keys(billingStats.categoryBreakdown).length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-slate-700 mb-1">By Category:</p>
                {Object.entries(billingStats.categoryBreakdown)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 3)
                  .map(([cat, amount]) => (
                    <div key={cat} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">{cat}</span>
                      <span className="font-semibold text-slate-900">
                        ${amount.toLocaleString()}
                      </span>
                    </div>
                  ))}
                {Object.keys(billingStats.categoryBreakdown).length > 3 && (
                  <p className="text-xs text-slate-500 italic">
                    +{Object.keys(billingStats.categoryBreakdown).length - 3} more categories
                  </p>
                )}
              </div>
            )}

            <div className="mt-2 pt-2 border-t border-green-200">
              <p className="text-xs text-slate-600">
                {billingStats.invoiceCount} invoice{billingStats.invoiceCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        )}

        {/* Type-specific content */}
        <div className="space-y-3">
          {/* Organization: Mission */}
          {category === 'organization' && organization.mission && (
            <p className="text-slate-600 text-sm line-clamp-2">
              {organization.mission}
            </p>
          )}

          {/* Student: GPA, Major, Grade Levels */}
          {category === 'student' && (
            <StudentInfo 
              organization={organization} 
              gradeLevelLabels={gradeLevelLabels} 
            />
          )}

          {/* Individual: Assistance Categories, Need Level */}
          {category === 'individual' && (
            <IndividualInfo 
              organization={organization}
              assistanceCategoryLabels={assistanceCategoryLabels}
            />
          )}

          {/* Location */}
          {organization.city && organization.state && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <MapPin className="w-3 h-3" aria-hidden="true" />
              <span className="truncate">
                {organization.city}, {organization.state}
              </span>
            </div>
          )}

          {/* Tags */}
          {category === 'organization' && organization.program_areas && (
            <TagList items={organization.program_areas} limit={3} />
          )}

          {category === 'student' && organization.extracurricular_activities && (
            <TagList items={organization.extracurricular_activities} limit={2} />
          )}
        </div>

        {/* Grant Count Footer with Submission Dropdown */}
        <div className="flex flex-col gap-2 pt-4 mt-4 border-t border-slate-100">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-600" aria-hidden="true" />
              <span className="text-sm font-medium text-slate-900">
                {grantCount} {opportunityLabel}
              </span>
            </div>
          </div>

          {/* Ready for Submission - Direct link if 1, dropdown if multiple */}
          {readyForSubmission.length === 1 && (
            <Link 
              to={createPageUrl(`GrantDetail?id=${readyForSubmission[0].id}`)}
              onClick={(e) => e.stopPropagation()}
              className="w-full"
            >
              <Button 
                variant="outline" 
                size="sm" 
                className="w-full justify-center gap-2 bg-orange-50 border-orange-300 text-orange-700 hover:bg-orange-100"
              >
                <Send className="w-3 h-3 flex-shrink-0" />
                <span className="whitespace-nowrap">Ready for Submission (1)</span>
              </Button>
            </Link>
          )}
          {readyForSubmission.length > 1 && (
            <SubmissionDropdown 
              grants={readyForSubmission}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}