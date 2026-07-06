
import React, { useState, useMemo } from "react";
import client from '@/api/client';
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { daysUntilLocal } from "@/components/shared/dateUtils";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Filter, Plus, DollarSign, Calendar, Building2, Search, Award } from "lucide-react";
import { format } from "date-fns";
import AdvancedFilters from "@/components/pipeline/AdvancedFilters";
import ComparableAwardsPanel from "@/components/proposals/ComparableAwardsPanel";

export default function Proposals() {
  const [filterOrg, setFilterOrg] = useState("all");
  // Comparable-awards side panel (real NIH RePORTER awards, reference only).
  const [awardsProposal, setAwardsProposal] = useState(null); // { id, title } | null
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

  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants'],
    queryFn: () => client.entities.Grant.list('-created_date'),
  });

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list(),
  });

  const activeProposals = useMemo(
    () => grants.filter(g => ['drafting', 'interested', 'application_prep', 'revision'].includes(g.status)),
    [grants]
  );

  // Extract all unique tags
  const allTags = useMemo(() => {
    const tagSet = new Set();
    activeProposals.forEach(proposal => {
      if (proposal.tags && Array.isArray(proposal.tags)) {
        proposal.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return Array.from(tagSet).sort();
  }, [activeProposals]);

  // Helper to validate date
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    if (dateString.toLowerCase() === 'rolling') return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  // Helper to check if deadline is expired
  const isExpired = (grant) => {
    if (!grant.deadline) return false;
    if (grant.deadline.toLowerCase() === 'rolling') return false;
    if (!isValidDate(grant.deadline)) return false;
    // Expired only once the deadline DAY has passed in the user's local calendar
    // (daysUntilLocal < 0). Avoids the UTC off-by-one that flagged a still-open
    // deadline as expired for users in negative-offset zones.
    return daysUntilLocal(grant.deadline) < 0;
  };

  // Apply all filters
  const filteredProposals = useMemo(() => {
    let filtered = activeProposals;

    // Organization filter
    if (filterOrg !== "all") {
      filtered = filtered.filter(p => p.organization_id === filterOrg);
    }

    // Deadline status filters â mutually exclusive; showOnlyExpired takes precedence
    if (filters.showOnlyExpired) {
      filtered = filtered.filter(proposal => isExpired(proposal));
    } else if (filters.hideExpired) {
      filtered = filtered.filter(proposal => !isExpired(proposal));
    }

    // Search filter
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filtered = filtered.filter(proposal =>
        proposal.title?.toLowerCase().includes(searchLower) ||
        proposal.funder?.toLowerCase().includes(searchLower) ||
        proposal.program_description?.toLowerCase().includes(searchLower) ||
        proposal.tags?.some(tag => tag.toLowerCase().includes(searchLower))
      );
    }

    // Amount filters
    if (filters.minAmount !== '') {
      const minAmount = parseFloat(filters.minAmount);
      filtered = filtered.filter(proposal => {
        const bestAmount =
          proposal.amount_max ?? proposal.typical_award ?? proposal.amount_min ?? null;
        // If no amount data at all, keep the record (prefer recall over suppression)
        if (bestAmount === null) return true;
        return bestAmount >= minAmount;
      });
    }
    if (filters.maxAmount !== '') {
      const maxAmount = parseFloat(filters.maxAmount);
      filtered = filtered.filter(proposal => {
        const lowestAmount =
          proposal.amount_min ?? proposal.typical_award ?? proposal.amount_max ?? null;
        // If no amount data at all, keep the record (prefer recall over suppression)
        if (lowestAmount === null) return true;
        return lowestAmount <= maxAmount;
      });
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

    // Tags filter
    if (filters.tags && filters.tags.length > 0) {
      filtered = filtered.filter(proposal =>
        proposal.tags && proposal.tags.some(tag => filters.tags.includes(tag))
      );
    }

    return filtered;
  }, [activeProposals, filterOrg, filters]);

  const isLoading = isLoadingGrants || isLoadingOrgs;

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col gap-4 mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900">Proposals</h1>
              <p className="text-slate-600 mt-2">
                Manage your proposals • {filteredProposals.length} of {activeProposals.length} proposals
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
            allTags={allTags}
          />
        </div>

        {isLoading ? (
          <div className="text-center text-slate-500 py-10">Loading proposals...</div>
        ) : filteredProposals.length === 0 ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                {activeProposals.length === 0 ? 'No Active Proposals' : 'No Proposals Match Your Filters'}
              </h3>
              <p className="text-slate-600 mb-6">
                {activeProposals.length === 0
                  ? "Your active proposals will appear here. Start by finding an opportunity and marking it as 'Interested' or 'Drafting' in your pipeline."
                  : "Try adjusting your filters to see more proposals."
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
          <div className="flex flex-col-reverse lg:flex-row gap-6 items-start">
          <div className={`grid md:grid-cols-2 ${awardsProposal ? 'lg:grid-cols-2' : 'lg:grid-cols-3'} gap-6 flex-1`}>
            {filteredProposals.map(proposal => {
              const org = organizations.find(o => o.id === proposal.organization_id);
              const expired = isExpired(proposal);
              const hasValidDeadline = isValidDate(proposal.deadline);
              
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
                    <p className="text-slate-700 font-medium">{proposal.funder}</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {org && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Building2 className="w-4 h-4 shrink-0" />
                        <span className="truncate">{org.name}</span>
                      </div>
                    )}
                    {hasValidDeadline && (
                      <div className={`flex items-center gap-2 text-sm ${expired ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>
                        <Calendar className="w-4 h-4 shrink-0" />
                        <span>Deadline: {format(new Date(proposal.deadline), 'MMM d, yyyy')}</span>
                      </div>
                    )}
                    {(proposal.amount_max || proposal.typical_award) && (
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                            <DollarSign className="w-4 h-4 shrink-0" />
                            <span>
                                Award: ~${(proposal.typical_award || proposal.amount_max).toLocaleString()}
                            </span>
                        </div>
                    )}
                    {proposal.tags && proposal.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {proposal.tags.slice(0, 3).map(tag => (
                          <Badge key={tag} variant="secondary" className="text-xs">
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
                  <CardFooter className="bg-slate-50 p-4 border-t flex flex-col gap-2">
                    <Link to={createPageUrl("GrantDetail", { id: proposal.id, tab: "proposal" })} className="w-full">
                      <Button variant="outline" className="w-full bg-white">View Proposal</Button>
                    </Link>
                    <Button
                      variant="ghost"
                      className="w-full text-amber-700 hover:text-amber-800 hover:bg-amber-50"
                      onClick={() => setAwardsProposal(
                        awardsProposal?.id === proposal.id ? null : { id: proposal.id, title: proposal.title }
                      )}
                    >
                      <Award className="w-4 h-4 mr-2" />
                      {awardsProposal?.id === proposal.id ? 'Hide Comparable Awards' : 'Comparable Awards'}
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
          {awardsProposal && (
            <aside className="w-full lg:w-96 lg:shrink-0 lg:sticky lg:top-6">
              <ComparableAwardsPanel
                grantId={awardsProposal.id}
                grantTitle={awardsProposal.title}
                onClose={() => setAwardsProposal(null)}
              />
            </aside>
          )}
          </div>
        )}
      </div>
    </div>
  );
}
