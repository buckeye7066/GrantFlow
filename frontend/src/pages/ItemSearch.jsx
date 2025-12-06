import React, { useState, useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useRLSOrganizations } from '@/components/hooks/useRLSOrganizations';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/components/ui/use-toast';

// ID validation patterns
const ID_PATTERN = /^[0-9a-f]{24}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidProfileId(id) {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  return ID_PATTERN.test(trimmed) || UUID_PATTERN.test(trimmed);
}
import { 
  Search, 
  MapPin, 
  Package, 
  ExternalLink, 
  Phone, 
  Mail, 
  Loader2, 
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  Car,
  HeartPulse,
  Monitor,
  Home,
  Wrench
} from 'lucide-react';

const DISTANCE_OPTIONS = [
  { value: '25', label: 'Within 25 miles' },
  { value: '50', label: 'Within 50 miles' },
  { value: '100', label: 'Within 100 miles' },
  { value: '500', label: 'Within 500 miles' },
  { value: 'nationwide', label: 'Nationwide' },
  { value: 'worldwide', label: 'Worldwide' }
];

const CATEGORY_ICONS = {
  transportation: Car,
  medical: HeartPulse,
  technology: Monitor,
  housing: Home,
  equipment: Wrench,
  accessibility: CheckCircle2
};

export default function ItemSearch() {
  const { toast } = useToast();
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [itemRequest, setItemRequest] = useState('');
  const [distanceMiles, setDistanceMiles] = useState('nationwide');
  const [searchResults, setSearchResults] = useState(null);

  // Fetch profiles with RLS
  const { data: profiles = [], isLoading: isLoadingProfiles } = useRLSOrganizations();

  // Get selected profile object
  const selectedProfile = useMemo(() => 
    profiles.find(p => p.id === selectedProfileId),
    [profiles, selectedProfileId]
  );

  // Search mutation
  const searchMutation = useMutation({
    mutationFn: async ({ item_request, profile_id, distance_miles }) => {
      // CRITICAL: Validate profile_id before sending
      if (!isValidProfileId(profile_id)) {
        throw new Error('The selected profile does not have a valid ID.');
      }
      
      // MINIMAL PAYLOAD - only required fields for searchForItem
      const payload = {
        item_request,
        profile_id
      };
      console.log('[ItemSearch] Calling searchForItem with payload:', JSON.stringify(payload));
      
      const response = await base44.functions.invoke('searchForItem', payload);
      
      console.log('[ItemSearch] searchForItem response:', {
        success: response.data?.success !== false,
        error: response.data?.error,
        opportunityCount: response.data?.opportunities?.length
      });
      
      return response;
    },
    onSuccess: (data) => {
      setSearchResults(data);
      toast({
        title: 'Search Complete!',
        description: `Found ${data.opportunities?.length || 0} funding opportunities for your item request.`
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Search Failed',
        description: error.message || 'Could not complete the search. Please try again.'
      });
    }
  });

  const handleSearch = () => {
    if (!itemRequest.trim()) {
      toast({
        variant: 'destructive',
        title: 'Missing Information',
        description: 'Please describe the item you need funding for.'
      });
      return;
    }

    if (!selectedProfileId) {
      toast({
        variant: 'destructive',
        title: 'Missing Profile',
        description: 'Please select a profile to search for.'
      });
      return;
    }

    // FAIL-SAFE: Validate ID format
    if (!isValidProfileId(selectedProfileId)) {
      console.warn('[ItemSearch] Invalid profile ID format:', selectedProfileId);
      toast({
        variant: 'destructive',
        title: 'Invalid Profile',
        description: 'The selected profile does not have a valid ID.'
      });
      return;
    }

    // Double-check we have the actual profile object with valid id
    if (!selectedProfile || !selectedProfile.id) {
      console.warn('[ItemSearch] Profile object invalid:', selectedProfile);
      toast({
        variant: 'destructive',
        title: 'Profile Error',
        description: 'Could not find the selected profile. Please try again.'
      });
      return;
    }

    console.log('[ItemSearch] Initiating search with profile_id:', selectedProfile.id);

    searchMutation.mutate({
      item_request: itemRequest,
      profile_id: selectedProfile.id, // Always use profile.id
      distance_miles: distanceMiles
    });
  };

  const getCategoryIcon = (category) => {
    const IconComponent = CATEGORY_ICONS[category?.toLowerCase()] || Package;
    return <IconComponent className="w-4 h-4" />;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-4xl font-bold text-slate-900 flex items-center gap-3">
            <Package className="w-10 h-10 text-blue-600" />
            Item-Specific Funding Search
          </h1>
          <p className="text-lg text-slate-600">
            Find funding for specific items and purchase assistance
          </p>
        </div>

        {/* Search Form */}
        <Card className="shadow-xl border-0">
          <CardHeader className="bg-gradient-to-r from-blue-600 to-purple-600 text-white">
            <CardTitle className="flex items-center gap-2">
              <Search className="w-5 h-5" />
              Search for Item Funding
            </CardTitle>
            <CardDescription className="text-blue-50">
              Describe the item you need and we'll find funding opportunities from federal, state, local, corporate, and nonprofit sources
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            {/* Profile Selector */}
            <div className="space-y-2">
              <Label htmlFor="profile">Select Profile *</Label>
              <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose who needs the item..." />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name} - {profile.city}, {profile.state}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                Select the organization or individual who needs the item
              </p>
            </div>

            {/* Item Request */}
            <div className="space-y-2">
              <Label htmlFor="item-request">What item do you need? *</Label>
              <Textarea
                id="item-request"
                value={itemRequest}
                onChange={(e) => setItemRequest(e.target.value)}
                placeholder="Example: 12-passenger wheelchair-accessible van for transporting disabled adults to medical appointments&#10;&#10;OR&#10;&#10;Laptop computer for homeschool student to complete online coursework"
                rows={4}
                className="resize-none"
              />
              <p className="text-xs text-slate-500">
                Be as specific as possible about the item, its purpose, and any special requirements
              </p>
            </div>

            {/* Distance Selector */}
            <div className="space-y-2">
              <Label htmlFor="distance">
                <MapPin className="w-4 h-4 inline mr-1" />
                Search Distance
              </Label>
              <Select value={distanceMiles} onValueChange={setDistanceMiles}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISTANCE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                Start local and expand if needed. System will automatically search wider if no local options exist.
              </p>
            </div>

            {/* Search Button */}
            <Button
              onClick={handleSearch}
              disabled={searchMutation.isPending}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-lg py-6"
            >
              {searchMutation.isPending ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Searching for Funding...
                </>
              ) : (
                <>
                  <Search className="w-5 h-5 mr-2" />
                  Search for Item Funding
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Results */}
        {searchResults && (
          <div className="space-y-6">
            {/* Summary */}
            <Card className="shadow-lg border-0">
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                      <CheckCircle2 className="w-6 h-6 text-green-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">
                      Found {searchResults.opportunities?.length || 0} Funding Opportunities
                    </h3>
                    <p className="text-sm text-slate-600">
                      For: <strong>{searchResults.item_request}</strong>
                    </p>
                    <p className="text-sm text-slate-600">
                      Profile: <strong>{searchResults.profile?.name}</strong> ({searchResults.profile?.location})
                    </p>
                    <p className="text-sm text-slate-600">
                      Distance: <strong>{DISTANCE_OPTIONS.find(o => o.value === searchResults.distance_miles)?.label || searchResults.distance_miles}</strong>
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Warnings */}
            {searchResults.missing_data_warnings && searchResults.missing_data_warnings.length > 0 && (
              <Card className="border-amber-200 bg-amber-50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-amber-900">
                    <AlertCircle className="w-5 h-5" />
                    Data Recommendations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {searchResults.missing_data_warnings.map((warning, idx) => (
                      <li key={idx} className="text-sm text-amber-800">• {warning}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Next Actions */}
            {searchResults.next_actions && searchResults.next_actions.length > 0 && (
              <Card className="border-blue-200 bg-blue-50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-blue-900">
                    <TrendingUp className="w-5 h-5" />
                    Recommended Next Steps
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="space-y-2 list-decimal list-inside">
                    {searchResults.next_actions.map((action, idx) => (
                      <li key={idx} className="text-sm text-blue-800">{action}</li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            )}

            {/* Opportunities */}
            <div className="space-y-4">
              <h2 className="text-2xl font-bold text-slate-900">Funding Opportunities</h2>
              
              {searchResults.opportunities && searchResults.opportunities.length > 0 ? (
                <div className="grid gap-4">
                  {searchResults.opportunities
                    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
                    .map((opp, idx) => (
                      <Card key={idx} className="shadow-lg hover:shadow-xl transition-shadow border-l-4 border-l-blue-500">
                        <CardHeader>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <CardTitle className="text-xl text-slate-900 flex items-center gap-2">
                                {getCategoryIcon(opp.category)}
                                {opp.program_name}
                              </CardTitle>
                              <CardDescription className="text-base mt-1">
                                {opp.sponsor}
                              </CardDescription>
                            </div>
                            {opp.confidence && (
                              <Badge 
                                variant={opp.confidence >= 80 ? 'default' : opp.confidence >= 60 ? 'secondary' : 'outline'}
                                className="text-sm"
                              >
                                {opp.confidence}% Match
                              </Badge>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="text-sm text-slate-700">{opp.description}</p>

                          {/* Details Grid */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {opp.program_type && (
                              <div>
                                <p className="text-xs text-slate-500 uppercase font-semibold mb-1">Program Type</p>
                                <Badge variant="outline">{opp.program_type}</Badge>
                              </div>
                            )}
                            
                            {opp.category && (
                              <div>
                                <p className="text-xs text-slate-500 uppercase font-semibold mb-1">Category</p>
                                <Badge variant="outline">{opp.category}</Badge>
                              </div>
                            )}

                            {(opp.amount_min || opp.amount_max) && (
                              <div>
                                <p className="text-xs text-slate-500 uppercase font-semibold mb-1">Amount Range</p>
                                <p className="text-sm font-medium text-slate-900">
                                  {opp.amount_min && opp.amount_max 
                                    ? `$${opp.amount_min.toLocaleString()} - $${opp.amount_max.toLocaleString()}`
                                    : opp.amount_max
                                    ? `Up to $${opp.amount_max.toLocaleString()}`
                                    : opp.amount_min
                                    ? `From $${opp.amount_min.toLocaleString()}`
                                    : 'Varies'}
                                </p>
                              </div>
                            )}

                            {opp.distance_miles && (
                              <div>
                                <p className="text-xs text-slate-500 uppercase font-semibold mb-1">Distance</p>
                                <p className="text-sm font-medium text-slate-900 flex items-center gap-1">
                                  <MapPin className="w-3 h-3" />
                                  {opp.distance_miles} miles away
                                </p>
                              </div>
                            )}

                            {opp.deadline && (
                              <div>
                                <p className="text-xs text-slate-500 uppercase font-semibold mb-1">Deadline</p>
                                <p className="text-sm font-medium text-slate-900">{opp.deadline}</p>
                              </div>
                            )}
                          </div>

                          {/* Eligibility */}
                          {opp.eligibility && (
                            <div>
                              <p className="text-xs text-slate-500 uppercase font-semibold mb-1">Eligibility</p>
                              <p className="text-sm text-slate-700">{opp.eligibility}</p>
                            </div>
                          )}

                          {/* Matched Fields */}
                          {opp.matched_fields && opp.matched_fields.length > 0 && (
                            <div>
                              <p className="text-xs text-slate-500 uppercase font-semibold mb-2">Why This Matches</p>
                              <div className="flex flex-wrap gap-2">
                                {opp.matched_fields.map((field, i) => (
                                  <Badge key={i} variant="secondary" className="text-xs">
                                    <CheckCircle2 className="w-3 h-3 mr-1" />
                                    {field}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          <Separator />

                          {/* Contact & Actions */}
                          <div className="flex flex-wrap items-center gap-3">
                            {opp.url && (
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => window.open(opp.url, '_blank')}
                              >
                                <ExternalLink className="w-4 h-4 mr-2" />
                                View Program
                              </Button>
                            )}
                            
                            {opp.contact_phone && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => window.open(`tel:${opp.contact_phone}`, '_blank')}
                              >
                                <Phone className="w-4 h-4 mr-2" />
                                {opp.contact_phone}
                              </Button>
                            )}
                            
                            {opp.contact_email && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => window.open(`mailto:${opp.contact_email}`, '_blank')}
                              >
                                <Mail className="w-4 h-4 mr-2" />
                                Email
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                </div>
              ) : (
                <Card className="border-slate-200">
                  <CardContent className="p-12 text-center">
                    <Package className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">No Direct Matches Found</h3>
                    <p className="text-slate-600 mb-4">
                      We couldn't find direct funding for this specific item, but check the "Related Opportunities" below.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Related Opportunities */}
            {searchResults.related_opportunities && searchResults.related_opportunities.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Related Funding Sources</CardTitle>
                  <CardDescription>
                    Alternative or related programs that may help
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {searchResults.related_opportunities.map((related, idx) => (
                      <li key={idx} className="text-sm text-slate-700 flex items-start gap-2">
                        <span className="text-blue-600 mt-0.5">•</span>
                        <span>{related}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}