import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuthContext } from '@/components/hooks/useAuthRLS';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Building2, 
  Plus, 
  Search, 
  DollarSign, 
  Calendar as CalendarIcon,
  Mail,
  Phone,
  Globe,
  TrendingUp,
  Loader2
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import FunderForm from '@/components/funders/FunderForm';

// Safe string normalizer to avoid crashes on null/array values
const safeLower = (v) =>
  typeof v === 'string' ? v.toLowerCase() : v == null ? '' : String(v).toLowerCase();

export default function Funders() {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [relationshipFilter, setRelationshipFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editingFunder, setEditingFunder] = useState(null);

  const { user, isAdmin, isLoadingUser } = useAuthContext();

  const { data: funders = [], isLoading: isLoadingFunders } = useQuery({
    queryKey: ['funders', user?.email, isAdmin],
    queryFn: () =>
      isAdmin ? base44.entities.Funder.list() : base44.entities.Funder.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const { data: grants = [] } = useQuery({
    queryKey: ['grants', user?.email, isAdmin],
    queryFn: () =>
      isAdmin ? base44.entities.Grant.list() : base44.entities.Grant.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const isLoading = isLoadingUser || isLoadingFunders;

  // Precompute grant counts by funder name (O(N) instead of O(N*M))
  const grantsByFunderName = useMemo(() => {
    const map = {};
    for (const g of grants) {
      const key = typeof g?.funder === 'string' ? g.funder : '';
      if (!key) continue;
      map[key] = (map[key] || 0) + 1;
    }
    return map;
  }, [grants]);

  const filteredFunders = useMemo(() => {
    const q = safeLower(searchTerm);
    return (funders || []).filter((f) => {
      const name = safeLower(f?.name);
      const focus = safeLower(f?.focus_areas);
      const matchesSearch = name.includes(q) || focus.includes(q);
      const matchesType = typeFilter === 'all' || f?.funder_type === typeFilter;
      const matchesRelationship = relationshipFilter === 'all' || f?.relationship_strength === relationshipFilter;
      return matchesSearch && matchesType && matchesRelationship;
    });
  }, [funders, searchTerm, typeFilter, relationshipFilter]);

  const getRelationshipColor = (strength) => {
    const colors = {
      none: 'bg-slate-100 text-slate-800',
      initial_contact: 'bg-blue-100 text-blue-800',
      developing: 'bg-purple-100 text-purple-800',
      established: 'bg-green-100 text-green-800',
      strong: 'bg-emerald-100 text-emerald-800',
      very_strong: 'bg-teal-100 text-teal-800',
    };
    return colors[strength || 'none'] || colors.none;
  };

  const handleEdit = (funder) => {
    setEditingFunder(funder);
    setShowForm(true);
  };

  const handleFormClose = () => {
    setShowForm(false);
    setEditingFunder(null);
  };

  // Safe formatters for display
  const formatCurrency = (val) => {
    if (val == null || isNaN(val)) return 'N/A';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
  };

  const formatDate = (val) => {
    if (!val) return 'Never';
    try {
      return new Date(val).toLocaleDateString();
    } catch {
      return 'Invalid';
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (showForm) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="max-w-4xl mx-auto">
          <FunderForm funder={editingFunder} onClose={handleFormClose} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <Building2 className="w-8 h-8 text-blue-600" />
              Funder Relationship Management
            </h1>
            <p className="text-slate-600 mt-1">{funders?.length || 0} funders in database</p>
          </div>
          <Button onClick={() => setShowForm(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Add Funder
          </Button>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Search</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search funders..."
                    className="pl-10"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Type</label>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="foundation">Foundation</SelectItem>
                    <SelectItem value="government">Government</SelectItem>
                    <SelectItem value="corporate">Corporate</SelectItem>
                    <SelectItem value="individual">Individual</SelectItem>
                    <SelectItem value="nonprofit">Nonprofit</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Relationship</label>
                <Select value={relationshipFilter} onValueChange={setRelationshipFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Relationships</SelectItem>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="initial_contact">Initial Contact</SelectItem>
                    <SelectItem value="developing">Developing</SelectItem>
                    <SelectItem value="established">Established</SelectItem>
                    <SelectItem value="strong">Strong</SelectItem>
                    <SelectItem value="very_strong">Very Strong</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Funder Cards */}
        {filteredFunders.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Funders Found</h3>
              <p className="text-slate-600 mb-4">
                {searchTerm || typeFilter !== 'all' || relationshipFilter !== 'all'
                  ? 'Try adjusting your filters'
                  : 'Add your first funder to get started'}
              </p>
              <Button onClick={() => setShowForm(true)} className="gap-2">
                <Plus className="w-4 h-4" />
                Add Funder
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredFunders.map((funder) => {
              const grantCount = grantsByFunderName[funder?.name] || 0;
              return (
                <Card
                  key={funder.id}
                  className="cursor-pointer hover:shadow-lg transition-shadow"
                  onClick={() => navigate(createPageUrl(`FunderProfile?id=${funder.id}`))}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-lg truncate">{funder?.name || 'Unnamed Funder'}</CardTitle>
                        <CardDescription className="mt-1 capitalize">
                          {funder?.funder_type || 'Unknown type'}
                        </CardDescription>
                      </div>
                      <Badge className={getRelationshipColor(funder?.relationship_strength)}>
                        {(funder?.relationship_strength || 'none').replace(/_/g, ' ')}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {/* Focus Areas */}
                      {funder?.focus_areas && (
                        <p className="text-sm text-slate-600 line-clamp-2">{funder.focus_areas}</p>
                      )}

                      {/* Stats Row */}
                      <div className="flex items-center gap-4 text-sm">
                        <div className="flex items-center gap-1 text-slate-600">
                          <TrendingUp className="w-4 h-4" />
                          <span>{grantCount} grants</span>
                        </div>
                        {(funder?.typical_award_min != null || funder?.typical_award_max != null) && (
                          <div className="flex items-center gap-1 text-slate-600">
                            <DollarSign className="w-4 h-4" />
                            <span>
                              {formatCurrency(funder?.typical_award_min)} - {formatCurrency(funder?.typical_award_max)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Contact Info */}
                      <div className="flex items-center gap-3 text-xs text-slate-500">
                        {funder?.website && (
                          <div className="flex items-center gap-1">
                            <Globe className="w-3 h-3" />
                            <span className="truncate max-w-[100px]">Website</span>
                          </div>
                        )}
                        {funder?.contact_email && (
                          <div className="flex items-center gap-1">
                            <Mail className="w-3 h-3" />
                            <span>Email</span>
                          </div>
                        )}
                        {funder?.contact_phone && (
                          <div className="flex items-center gap-1">
                            <Phone className="w-3 h-3" />
                            <span>Phone</span>
                          </div>
                        )}
                      </div>

                      {/* Last Contact */}
                      {funder?.last_contact_date && (
                        <div className="flex items-center gap-1 text-xs text-slate-500">
                          <CalendarIcon className="w-3 h-3" />
                          <span>Last contact: {formatDate(funder.last_contact_date)}</span>
                        </div>
                      )}
                    </div>

                    {/* Edit Button */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full mt-4"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEdit(funder);
                      }}
                    >
                      Edit Funder
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}