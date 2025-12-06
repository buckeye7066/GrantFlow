import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { 
  Loader2, 
  Database, 
  Trash2, 
  ExternalLink, 
  Search,
  MapPin,
  AlertTriangle,
  Filter,
  RefreshCw,
  Sparkles,
  User,
  CheckSquare,
  Square,
  Plus
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { callFunctionWithRetry } from '@/components/shared/functionClient';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// US States list
const US_STATES = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' }, { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' }, { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' }, { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' }, { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' }, { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' }, { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' }, { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' }, { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' }, { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' }, { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' }, { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' }, { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' }, { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' }, { code: 'DC', name: 'District of Columbia' },
];

export default function FundingOpportunities() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // 'all', 'tennessee', or specific ID
  const [deleteProgress, setDeleteProgress] = useState({ current: 0, total: 0, active: false });
  const [selectedOpportunities, setSelectedOpportunities] = useState(new Set());
  const [addingToPipeline, setAddingToPipeline] = useState(false);

  // Geographic filter inputs
  const [geoState, setGeoState] = useState('');
  const [geoZip, setGeoZip] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [pullingFromProfile, setPullingFromProfile] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  // Fetch all funding opportunities
  const { data: opportunities = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['fundingOpportunities'],
    queryFn: () => base44.entities.FundingOpportunity.list('-created_date', 5000),
    staleTime: 0,
  });

  // Fetch organizations for profile selection
  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('name'),
  });

  // Pull geographic info from selected profile
  const handlePullFromProfile = async () => {
    if (!selectedProfileId) {
      toast({ variant: 'destructive', title: 'Select a profile first' });
      return;
    }

    setPullingFromProfile(true);
    try {
      const org = organizations.find(o => o.id === selectedProfileId);
      if (org) {
        // Extract state - check multiple fields
        const state = org.state?.toUpperCase() || '';
        if (state && state.length === 2) {
          setGeoState(state);
        }
        
        // Extract zip
        const zip = org.zip || '';
        if (zip) {
          setGeoZip(zip.substring(0, 5)); // First 5 digits
        }

        toast({
          title: 'Profile data loaded',
          description: `State: ${state || 'Not found'}, ZIP: ${zip || 'Not found'}`,
        });
      }
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err?.message });
    } finally {
      setPullingFromProfile(false);
    }
  };

  // Run crawler search with geographic filters
  const handleSearchCrawlers = async () => {
    // For database filtering, we don't need to call backend - just filter locally
    // Profile selection is now optional for filtering
    
    if (!selectedProfileId && !geoState) {
      toast({ 
        variant: 'destructive', 
        title: 'Selection Required', 
        description: 'Please select a profile or state to filter opportunities.' 
      });
      return;
    }

    setIsSearching(true);
    try {
      // Get profile data if selected
      const org = selectedProfileId ? organizations.find(o => o.id === selectedProfileId) : null;
      const searchState = geoState || org?.state?.toUpperCase();

      // Apply filters to the local data
      if (searchState) {
        setStateFilter(searchState);
      }
      
      toast({
        title: 'Filter Applied',
        description: searchState 
          ? `Showing opportunities for ${searchState}${geoZip ? ` (ZIP: ${geoZip})` : ''}`
          : 'Showing all opportunities',
      });
      
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Filter Error',
        description: err?.message || 'Failed to apply filter.',
      });
    } finally {
      setIsSearching(false);
    }
  };

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (ids) => {
      let deleted = 0;
      let skipped = 0;
      const total = ids.length;
      
      setDeleteProgress({ current: 0, total, active: true });
      
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        try {
          await base44.entities.FundingOpportunity.delete(id);
          deleted++;
        } catch (err) {
          // Record may already be deleted - skip gracefully
          const msg = err?.message || '';
          if (msg.includes('not found') || msg.includes('404')) {
            console.warn(`[Delete] Skipping already-deleted record: ${id}`);
            skipped++;
          } else {
            // Re-throw unexpected errors
            throw err;
          }
        }
        setDeleteProgress({ current: i + 1, total, active: true });
      }
      
      setDeleteProgress({ current: 0, total: 0, active: false });
      return { deleted, skipped };
    },
    onSuccess: (result, ids) => {
      queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] });
      const { deleted, skipped } = result || { deleted: ids.length, skipped: 0 };
      toast({
        title: 'Deleted Successfully',
        description: skipped > 0 
          ? `Removed ${deleted} opportunities. ${skipped} were already deleted.`
          : `Removed ${deleted} funding opportunities.`,
      });
      setShowDeleteDialog(false);
      setDeleteTarget(null);
    },
    onError: (error) => {
      // Refresh data to sync with actual DB state
      queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] });
      toast({
        variant: 'destructive',
        title: 'Delete Failed',
        description: error?.message || 'Failed to delete opportunities.',
      });
    },
  });

  // Extract unique states and sources for filters
  const { states, sources, stateCounts } = useMemo(() => {
    const stateSet = new Set();
    const sourceSet = new Set();
    const counts = {};

    opportunities.forEach(opp => {
      // Extract state from regions array
      const regions = opp.regions || [];
      regions.forEach(r => {
        if (r.length === 2 && r === r.toUpperCase()) {
          stateSet.add(r);
          counts[r] = (counts[r] || 0) + 1;
        }
      });
      // Also check explicit state field
      if (opp.state) {
        stateSet.add(opp.state.toUpperCase());
        counts[opp.state.toUpperCase()] = (counts[opp.state.toUpperCase()] || 0) + 1;
      }
      if (opp.source) {
        sourceSet.add(opp.source);
      }
    });

    return {
      states: Array.from(stateSet).sort(),
      sources: Array.from(sourceSet).sort(),
      stateCounts: counts,
    };
  }, [opportunities]);

  // Filter opportunities
  const filteredOpportunities = useMemo(() => {
    return opportunities.filter(opp => {
      // Search filter
      if (searchTerm) {
        const search = searchTerm.toLowerCase();
        const matches = 
          opp.title?.toLowerCase().includes(search) ||
          opp.sponsor?.toLowerCase().includes(search) ||
          opp.descriptionMd?.toLowerCase().includes(search);
        if (!matches) return false;
      }

      // State filter - include national opportunities and profile-scoped matches
      if (stateFilter !== 'all') {
        // National opportunities match all states
        if (opp.is_national === true) {
          // National opportunities pass the filter
        } else {
          const regions = opp.regions || [];
          const hasState = regions.includes(stateFilter) || 
                           opp.state?.toUpperCase() === stateFilter ||
                           regions.some(r => r.toUpperCase() === stateFilter);
          if (!hasState) return false;
        }
      }

      // Source filter
      if (sourceFilter !== 'all') {
        if (opp.source !== sourceFilter) return false;
      }

      return true;
    });
  }, [opportunities, searchTerm, stateFilter, sourceFilter]);

  // Get Tennessee opportunities for cleanup
  const tennesseeOpportunities = useMemo(() => {
    return opportunities.filter(opp => {
      const regions = opp.regions || [];
      return regions.includes('TN') || 
             opp.state?.toUpperCase() === 'TN' ||
             opp.title?.toLowerCase().includes('tennessee') ||
             opp.sponsor?.toLowerCase().includes('tennessee') ||
             opp.descriptionMd?.toLowerCase().includes('tennessee') ||
             opp.source === 'ecf_choices_discovery';
    });
  }, [opportunities]);

  const handleDelete = (target) => {
    setDeleteTarget(target);
    setShowDeleteDialog(true);
  };

  const confirmDelete = () => {
    let idsToDelete = [];

    if (deleteTarget === 'all') {
      idsToDelete = opportunities.map(o => o.id);
    } else if (deleteTarget === 'tennessee') {
      idsToDelete = tennesseeOpportunities.map(o => o.id);
    } else if (deleteTarget) {
      idsToDelete = [deleteTarget];
    }

    if (idsToDelete.length > 0) {
      deleteMutation.mutate(idsToDelete);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
                <Database className="w-8 h-8 text-blue-600" />
                Funding Opportunities Database
              </h1>
              <p className="text-slate-600 mt-2">
                {opportunities.length} total opportunities in database
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  await refetch();
                }}
                disabled={isFetching}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
                {isFetching ? 'Refreshing...' : 'Refresh'}
              </Button>
              <Button
                className="bg-blue-600 hover:bg-blue-700"
                onClick={handleSearchCrawlers}
                disabled={isSearching || (!geoState && !selectedProfileId)}
              >
                {isSearching ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Search className="w-4 h-4 mr-2" />
                )}
                Search for Grants
              </Button>
            </div>
          </div>
        </div>

        {/* State Distribution Warning */}
        {tennesseeOpportunities.length > 0 && (
          <Card className="mb-6 border-amber-200 bg-amber-50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-amber-900">
                <AlertTriangle className="w-5 h-5" />
                Cross-State Data Detected
              </CardTitle>
              <CardDescription className="text-amber-700">
                {tennesseeOpportunities.length} Tennessee-specific opportunities found. 
                These may cause contamination for non-TN profiles.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDelete('tennessee')}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete All Tennessee Data ({tennesseeOpportunities.length})
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* State Distribution Stats */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="w-5 h-5 text-blue-600" />
              Geographic Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Geographic Input Controls */}
            <div className="flex flex-wrap gap-3 mb-4 p-4 bg-slate-50 rounded-lg border items-end">
              <div className="flex-1 min-w-[140px]">
                <Label className="text-xs text-slate-600 mb-1 block">Profile</Label>
                <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                  <SelectTrigger className="h-9">
                    <User className="w-4 h-4 mr-2 text-slate-400" />
                    <SelectValue placeholder="Select profile" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={null}>None</SelectItem>
                    {organizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="w-24">
                <Label className="text-xs text-slate-600 mb-1 block">State</Label>
                <Select value={geoState} onValueChange={setGeoState}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="State" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={null}>Any</SelectItem>
                    {US_STATES.map(s => (
                      <SelectItem key={s.code} value={s.code}>
                        {s.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="w-24">
                <Label className="text-xs text-slate-600 mb-1 block">ZIP</Label>
                <Input
                  placeholder="e.g. 37311"
                  value={geoZip}
                  onChange={(e) => setGeoZip(e.target.value.replace(/\D/g, '').substring(0, 5))}
                  className="h-9"
                  maxLength={5}
                />
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={handlePullFromProfile}
                disabled={!selectedProfileId || pullingFromProfile}
                className="h-9"
              >
                {pullingFromProfile ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-1 text-purple-600" />
                    Pull from Profile
                  </>
                )}
              </Button>

              <Button
                size="sm"
                onClick={handleSearchCrawlers}
                disabled={isSearching || (!geoState && !selectedProfileId)}
                className="h-9 bg-blue-600 hover:bg-blue-700"
              >
                {isSearching ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Search className="w-4 h-4 mr-1" />
                    Apply Filters
                  </>
                )}
              </Button>

              {selectedProfileId && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const org = organizations.find(o => o.id === selectedProfileId);
                    if (org) {
                      // Force load profile data
                      setGeoState(org.state?.toUpperCase() || '');
                      setGeoZip(org.zip?.substring(0, 5) || '');
                      toast({
                        title: 'Profile Loaded',
                        description: `Loaded ${org.name}: State=${org.state || 'N/A'}, ZIP=${org.zip || 'N/A'}`,
                      });
                    }
                  }}
                  className="h-9"
                >
                  <User className="w-4 h-4 mr-1" />
                  Load Profile
                </Button>
              )}
            </div>

            {/* Active Filter Display */}
            <div className="mb-4 p-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-200">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-blue-900">
                  <MapPin className="w-4 h-4 inline mr-1" />
                  Active Filter: All 50 States
                </span>
                {(stateFilter !== 'all' || geoZip) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setStateFilter('all'); setGeoZip(''); }}
                    className="text-blue-600 h-6 text-xs"
                  >
                    Reset to All
                  </Button>
                )}
              </div>
              
              {/* All 50 States Grid */}
              <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-13 gap-1 mb-3">
                {US_STATES.map(s => {
                  const count = stateCounts[s.code] || 0;
                  const isSelected = stateFilter === s.code;
                  const hasData = count > 0;
                  
                  return (
                    <button
                      key={s.code}
                      onClick={() => setStateFilter(isSelected ? 'all' : s.code)}
                      className={`
                        px-2 py-1 text-xs font-medium rounded transition-all
                        ${isSelected 
                          ? 'bg-blue-600 text-white shadow-md ring-2 ring-blue-300' 
                          : hasData 
                            ? 'bg-white text-slate-700 hover:bg-blue-100 border border-slate-200 shadow-sm'
                            : 'bg-slate-100 text-slate-400 border border-slate-100'
                        }
                      `}
                      title={`${s.name}: ${count} opportunities`}
                    >
                      {s.code}
                      {hasData && <span className="ml-1 opacity-70">({count})</span>}
                    </button>
                  );
                })}
              </div>

              {/* ZIP Code Sub-Filter - Shows when a state is selected */}
              {stateFilter !== 'all' && (
                <div className="mt-3 pt-3 border-t border-blue-200">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs font-medium text-blue-800">
                      Filter by ZIP in {stateFilter}:
                    </span>
                    <Input
                      placeholder="Enter ZIP code..."
                      value={geoZip}
                      onChange={(e) => setGeoZip(e.target.value.replace(/\D/g, '').substring(0, 5))}
                      className="h-7 w-32 text-xs"
                      maxLength={5}
                    />
                    {geoZip && (
                      <Badge variant="secondary" className="text-xs">
                        ZIP: {geoZip}
                        <button 
                          onClick={() => setGeoZip('')}
                          className="ml-1 hover:text-red-600"
                        >
                          ×
                        </button>
                      </Badge>
                    )}
                    
                    {/* Show common ZIPs for selected state from data */}
                    {(() => {
                      const stateZips = new Set();
                      opportunities.forEach(opp => {
                        if ((opp.regions?.includes(stateFilter) || opp.state?.toUpperCase() === stateFilter)) {
                          // Extract ZIP from various fields if available
                          const zip = opp.zip || opp.zipCode || '';
                          if (zip && /^\d{5}/.test(zip)) {
                            stateZips.add(zip.substring(0, 5));
                          }
                        }
                      });
                      const zipArray = Array.from(stateZips).slice(0, 8);
                      
                      if (zipArray.length > 0) {
                        return (
                          <div className="flex gap-1 flex-wrap">
                            <span className="text-xs text-slate-500">Quick:</span>
                            {zipArray.map(z => (
                              <button
                                key={z}
                                onClick={() => setGeoZip(z)}
                                className={`px-2 py-0.5 text-xs rounded ${
                                  geoZip === z 
                                    ? 'bg-blue-600 text-white' 
                                    : 'bg-white text-slate-600 hover:bg-blue-50 border'
                                }`}
                              >
                                {z}
                              </button>
                            ))}
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </div>
              )}

              {/* Summary Stats */}
              <div className="mt-3 pt-2 border-t border-blue-100 flex items-center gap-4 text-xs text-slate-600">
                <span>
                  <strong className="text-blue-700">{states.length}</strong> states with data
                </span>
                <span>
                  <strong className="text-blue-700">{opportunities.length}</strong> total opportunities
                </span>
                {stateFilter !== 'all' && (
                  <span className="text-blue-600 font-medium">
                    Showing: {US_STATES.find(s => s.code === stateFilter)?.name || stateFilter} ({stateCounts[stateFilter] || 0})
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Filter opportunities..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="w-[180px]">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by state" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All States</SelectItem>
                  {states.map(state => (
                    <SelectItem key={state} value={state}>
                      {state} ({stateCounts[state]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="w-[200px]">
                  <Database className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  {sources.map(source => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {(stateFilter !== 'all' || sourceFilter !== 'all' || searchTerm) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStateFilter('all');
                    setSourceFilter('all');
                    setSearchTerm('');
                  }}
                >
                  Clear Filters
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Results count and actions */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-slate-600">
            Showing {filteredOpportunities.length} of {opportunities.length} opportunities
            {selectedOpportunities.size > 0 && (
              <span className="ml-2 text-blue-600 font-medium">
                ({selectedOpportunities.size} selected)
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* Select All Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (selectedOpportunities.size === filteredOpportunities.length) {
                  setSelectedOpportunities(new Set());
                } else {
                  setSelectedOpportunities(new Set(filteredOpportunities.map(o => o.id)));
                }
              }}
              className="text-blue-600 hover:text-blue-700"
            >
              {selectedOpportunities.size === filteredOpportunities.length && filteredOpportunities.length > 0 ? (
                <>
                  <CheckSquare className="w-4 h-4 mr-2" />
                  Deselect All
                </>
              ) : (
                <>
                  <Square className="w-4 h-4 mr-2" />
                  Select All ({filteredOpportunities.length})
                </>
              )}
            </Button>

            {/* Add Selected to Pipeline */}
            {selectedOpportunities.size > 0 && selectedProfileId && (
              <Button
                size="sm"
                onClick={async () => {
                  if (!selectedProfileId) {
                    toast({ variant: 'destructive', title: 'Select a profile first' });
                    return;
                  }
                  setAddingToPipeline(true);
                  let added = 0;
                  const selectedArray = Array.from(selectedOpportunities);
                  for (const oppId of selectedArray) {
                    const opp = opportunities.find(o => o.id === oppId);
                    if (!opp) continue;
                    try {
                      await base44.entities.Grant.create({
                        organization_id: selectedProfileId,
                        profile_id: selectedProfileId,
                        title: opp.title || 'Untitled',
                        funder: opp.sponsor || 'Unknown',
                        url: opp.url || '',
                        deadline: opp.deadlineAt || opp.closeDate || null,
                        award_floor: opp.awardMin || null,
                        award_ceiling: opp.awardMax || null,
                        program_description: opp.descriptionMd || '',
                        status: 'discovered',
                        ai_status: 'idle',
                        funding_opportunity_id: opp.id
                      });
                      added++;
                    } catch (err) {
                      console.warn('Failed to add grant:', err?.message);
                    }
                  }
                  setAddingToPipeline(false);
                  setSelectedOpportunities(new Set());
                  toast({
                    title: 'Added to Pipeline',
                    description: `${added} opportunities added to the selected profile's pipeline.`,
                  });
                  queryClient.invalidateQueries({ queryKey: ['grants'] });
                }}
                disabled={addingToPipeline}
                className="bg-green-600 hover:bg-green-700"
              >
                {addingToPipeline ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4 mr-2" />
                )}
                Add {selectedOpportunities.size} to Pipeline
              </Button>
            )}

            {filteredOpportunities.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDelete('all')}
                disabled={deleteMutation.isPending}
                className="text-red-600 hover:text-red-700"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete All ({opportunities.length})
              </Button>
            )}
          </div>
        </div>

        {/* Opportunities List */}
        <div className="space-y-4">
          {filteredOpportunities.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Database className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">No Opportunities Found</h3>
                <p className="text-slate-600">
                  {opportunities.length === 0 
                    ? 'Run the data crawlers to populate opportunities.'
                    : 'No opportunities match your current filters.'}
                </p>
              </CardContent>
            </Card>
          ) : (
            filteredOpportunities.slice(0, 50).map(opp => (
              <Card 
                key={opp.id} 
                className={`hover:shadow-md transition-shadow cursor-pointer ${selectedOpportunities.has(opp.id) ? 'ring-2 ring-blue-500 bg-blue-50' : ''}`}
                onClick={() => {
                  const newSet = new Set(selectedOpportunities);
                  if (newSet.has(opp.id)) {
                    newSet.delete(opp.id);
                  } else {
                    newSet.add(opp.id);
                  }
                  setSelectedOpportunities(newSet);
                }}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {selectedOpportunities.has(opp.id) ? (
                        <CheckSquare className="w-5 h-5 text-blue-600 flex-shrink-0" />
                      ) : (
                        <Square className="w-5 h-5 text-slate-400 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-slate-900 truncate">
                            {opp.title}
                          </h3>
                        {opp.url && (
                          <a 
                            href={opp.url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                      <p className="text-sm text-slate-600 mb-2">
                        {opp.sponsor}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline" className="text-xs">
                          {opp.source}
                        </Badge>
                        {(opp.regions || []).map(region => (
                          <Badge 
                            key={region} 
                            variant={region === 'TN' ? 'destructive' : 'secondary'}
                            className="text-xs"
                          >
                            {region}
                          </Badge>
                        ))}
                        {opp.state && (
                          <Badge 
                            variant={opp.state.toUpperCase() === 'TN' ? 'destructive' : 'secondary'}
                            className="text-xs"
                          >
                            State: {opp.state}
                          </Badge>
                        )}
                        {opp.profile_id && (
                          <Badge variant="outline" className="text-xs bg-green-50">
                            Profile-scoped
                          </Badge>
                        )}
                        {opp.is_national && (
                          <Badge variant="outline" className="text-xs bg-blue-50">
                            National
                          </Badge>
                        )}
                      </div>
                    </div></div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); handleDelete(opp.id); }}
                      disabled={deleteMutation.isPending}
                      className="text-red-500 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
          
          {filteredOpportunities.length > 50 && (
            <p className="text-center text-slate-500 py-4">
              Showing first 50 of {filteredOpportunities.length} results. Use filters to narrow down.
            </p>
          )}
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="relative overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Deletion</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget === 'all' && (
                <>Are you sure you want to delete ALL {opportunities.length} funding opportunities? This cannot be undone.</>
              )}
              {deleteTarget === 'tennessee' && (
                <>Are you sure you want to delete all {tennesseeOpportunities.length} Tennessee-specific opportunities? This will help prevent cross-state contamination.</>
              )}
              {deleteTarget && deleteTarget !== 'all' && deleteTarget !== 'tennessee' && (
                <>Are you sure you want to delete this opportunity? This cannot be undone.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>
                    {deleteProgress.active 
                      ? `${deleteProgress.current}/${deleteProgress.total}`
                      : 'Deleting...'}
                  </span>
                </div>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
            
            {/* Progress bar */}
            {deleteMutation.isPending && deleteProgress.active && deleteProgress.total > 1 && (
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-200 rounded-b-lg overflow-hidden">
                <div 
                  className="h-full bg-red-500 transition-all duration-150"
                  style={{ width: `${(deleteProgress.current / deleteProgress.total) * 100}%` }}
                />
              </div>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}