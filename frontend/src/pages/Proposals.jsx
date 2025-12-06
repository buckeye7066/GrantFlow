import React, { useState, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Filter, DollarSign, Calendar, Building2, Search } from "lucide-react";
import { format } from "date-fns";
import AdvancedFilters from "@/components/pipeline/AdvancedFilters";
import { useRLSOrganizations, useRLSGrants } from "@/components/hooks/useAuthRLS";
import { normalize } from "@/components/shared/stringUtils";
import { parseDateSafe } from "@/components/shared/dateUtils";

// ─────────────────────────────────────────────────────────────────────────────
// SAFE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// M1 FIX: Using centralized parseDateSafe from dateUtils
const safeDate = parseDateSafe;

const isExpired = (grant) => {
  const d = safeDate(grant?.deadline);
  if (!d) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);

  return d < today;
};

const getAwardAmount = (proposal) => {
  return proposal?.typical_award ?? proposal?.award_ceiling ?? proposal?.award_floor ?? null;
};

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function Proposals() {
  const [filterOrg, setFilterOrg] = useState("all");
  const [filters, setFilters] = useState({
    search: '',
    minAmount: '',
    maxAmount: '',
    funderTypes: [],
    applicationMethods: [],
    opportunityTypes: [],
    tags: [],
    hideExpired: false,
    showOnlyExpired: false,
  });

  // RLS-safe queries
  const { data: grants = [], isLoading: isLoadingGrants } = useRLSGrants();
  const { data: organizations = [], isLoading: isLoadingOrgs, isLoadingUser } = useRLSOrganizations();

  const activeProposals = useMemo(() =>
    grants.filter(g => ['drafting', 'interested', 'application_prep', 'revision'].includes(g.status)),
    [grants]
  );

  // Extract all unique tags with safe normalization
  const allTags = useMemo(() => {
    const tagSet = new Set();
    activeProposals.forEach(proposal => {
      if (proposal.tags && Array.isArray(proposal.tags)) {
        proposal.tags.forEach(tag => {
          if (typeof tag === 'string') {
            tagSet.add(tag);
          }
        });
      }
    });
    return Array.from(tagSet).sort();
  }, [activeProposals]);

  // Apply all filters with safe operations
  const filteredProposals = useMemo(() => {
    let filtered = activeProposals;

    // Organization filter
    if (filterOrg !== "all") {
      filtered = filtered.filter(p => p.organization_id === filterOrg);
    }

    // Deadline status filters
    if (filters.hideExpired) {
      filtered = filtered.filter(proposal => !isExpired(proposal));
    }
    if (filters.showOnlyExpired) {
      filtered = filtered.filter(proposal => isExpired(proposal));
    }

    // Search filter - safe string operations
    if (filters.search) {
      const searchLower = normalize(filters.search);
      filtered = filtered.filter(proposal => {
        const titleMatch = normalize(proposal.title).includes(searchLower);
        const funderMatch = normalize(proposal.funder).includes(searchLower);
        const descMatch = normalize(proposal.program_description).includes(searchLower);
        const tagMatch = Array.isArray(proposal.tags) &&
          proposal.tags.some(tag => normalize(tag).includes(searchLower));
        return titleMatch || funderMatch || descMatch || tagMatch;
      });
    }

    // Amount filters - unified award amount
    if (filters.minAmount !== '') {
      const minAmount = parseFloat(filters.minAmount);
      if (!isNaN(minAmount)) {
        filtered = filtered.filter(proposal => {
          const award = getAwardAmount(proposal);
          return award !== null && award >= minAmount;
        });
      }
    }
    if (filters.maxAmount !== '') {
      const maxAmount = parseFloat(filters.maxAmount);
      if (!isNaN(maxAmount)) {
        filtered = filtered.filter(proposal => {
          const award = getAwardAmount(proposal);
          return award !== null && award <= maxAmount;
        });
      }
    }

    // Funder type filter
    if (filters.funderTypes && filters.funderTypes.length > 0) {
      filtered = filtered.filter(proposal =>
        proposal.funder_type && filters.funderTypes.includes(proposal.funder_type)
      );
    }

    // Application method filter
    if (filters.applicationMethods && filters.applicationMethods.length > 0) {
      filtered = filtered.filter(proposal =>
        proposal.application_method && filters.applicationMethods.includes(proposal.application_method)
      );
    }

    // Opportunity type filter
    if (filters.opportunityTypes && filters.opportunityTypes.length > 0) {
      filtered = filtered.filter(proposal =>
        proposal.opportunity_type && filters.opportunityTypes.includes(proposal.opportunity_type)
      );
    }

    // Tags filter - case-insensitive
    if (filters.tags && filters.tags.length > 0) {
      const filterTagsLower = filters.tags.map(t => normalize(t));
      filtered = filtered.filter(proposal =>
        Array.isArray(proposal.tags) &&
        proposal.tags.some(tag => filterTagsLower.includes(normalize(tag)))
      );
    }

    return filtered;
  // M2 FIX: Destructured filter dependencies to avoid JSON.stringify anti-pattern
  }, [
    activeProposals, 
    filterOrg, 
    filters.search,
    filters.minAmount,
    filters.maxAmount,
    filters.hideExpired,
    filters.showOnlyExpired,
    filters.funderTypes,
    filters.applicationMethods,
    filters.opportunityTypes,
    filters.tags
  ]);

  const isLoading = isLoadingUser || isLoadingGrants || isLoadingOrgs;

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col gap-4 mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900">Applications</h1>
              <p className="text-slate-600 mt-2">
                Manage your active funding applications • {filteredProposals.length} of {activeProposals.length} applications
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-slate-500" />
                <Select value={filterOrg} onValueChange={setFilterOrg}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Filter by organization" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Profiles</SelectItem>
                    {organizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Link to={createPageUrl("DiscoverGrants")}>
                <Button className="bg-blue-600 hover:bg-blue-700">
                  <Search className="w-4 h-4 mr-2" /> Find Opportunities
                </Button>
              </Link>
            </div>
          </div>

          {/* Advanced Filters */}
          <AdvancedFilters
            filters={filters}
            onFiltersChange={setFilters}
            availableTags={allTags}
          />
        </div>

        {isLoading ? (
          <div className="text-center text-slate-500 py-10">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
            Loading applications...
          </div>
        ) : filteredProposals.length === 0 ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                {activeProposals.length === 0 ? 'No Active Applications' : 'No Applications Match Your Filters'}
              </h3>
              <p className="text-slate-600 mb-6">
                {activeProposals.length === 0
                  ? "Your active applications will appear here. Start by finding an opportunity and marking it as 'Interested' or 'Drafting' in your pipeline."
                  : "Try adjusting your filters to see more applications."
                }
              </p>
              <Link to={createPageUrl("DiscoverGrants")}>
                <Button className="bg-blue-600 hover:bg-blue-700">
                  <Search className="w-4 h-4 mr-2" />
                  Discover Opportunities
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredProposals.map(proposal => {
              const org = organizations.find(o => o.id === proposal.organization_id);
              const expired = isExpired(proposal);
              const validDeadline = safeDate(proposal.deadline);
              const awardAmount = getAwardAmount(proposal);
              
              return (
                <Card key={proposal.id} className={`shadow-lg border-0 flex flex-col justify-between hover:shadow-xl transition-shadow duration-300 ${expired ? 'opacity-60 border-l-4 border-l-red-500' : ''}`}>
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <Badge variant="outline" className={
                        proposal.status === 'drafting' ? 'bg-purple-100 text-purple-700' : 
                        proposal.status === 'application_prep' ? 'bg-yellow-100 text-yellow-700' :
                        proposal.status === 'revision' ? 'bg-orange-100 text-orange-700' :
                        'bg-blue-100 text-blue-700'
                      }>{proposal.status}</Badge>
                      <div className="flex gap-1">
                        {expired && <Badge variant="destructive" className="bg-red-500 text-white">EXPIRED</Badge>}
                        {proposal.starred && <Badge variant="destructive" className="bg-yellow-400 text-yellow-900">Starred</Badge>}
                      </div>
                    </div>
                    <CardTitle className="text-xl text-slate-900 pt-2 line-clamp-2">{proposal.title}</CardTitle>
                    <p className="text-slate-700 font-medium">{proposal.funder || 'Unknown Funder'}</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {org && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Building2 className="w-4 h-4 shrink-0" />
                        <span className="truncate">{org.name}</span>
                      </div>
                    )}
                    {validDeadline && (
                      <div className={`flex items-center gap-2 text-sm ${expired ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>
                        <Calendar className="w-4 h-4 shrink-0" />
                        <span>Deadline: {format(validDeadline, 'MMM d, yyyy')}</span>
                      </div>
                    )}
                    {awardAmount !== null && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <DollarSign className="w-4 h-4 shrink-0" />
                        <span>Award: ~${awardAmount.toLocaleString()}</span>
                      </div>
                    )}
                    {proposal.tags && Array.isArray(proposal.tags) && proposal.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {proposal.tags.slice(0, 3).map((tag, idx) => (
                          <Badge key={`${tag}-${idx}`} variant="secondary" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                        {proposal.tags.length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            +{proposal.tags.length - 3}
                          </Badge>
                        )}
                      </div>
                    )}
                  </CardContent>
                  <CardFooter className="bg-slate-50 p-4 border-t">
                    <Link to={createPageUrl("GrantDetail") + `?id=${proposal.id}&tab=proposal`} className="w-full">
                      <Button variant="outline" className="w-full bg-white">View Application</Button>
                    </Link>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}