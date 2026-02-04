import React, { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Search, User, Heart, Target, TrendingUp, Sparkles } from 'lucide-react';
import SearchResults from '@/components/discovery/SearchResults';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { 
  runComprehensiveMatch, 
  runECFServiceSearch, 
  runStandardSearch 
} from '@/components/discovery/discoveryHelpers';
import {
  showNoProfileToast,
  showECFErrorToast,
  toastSearchStart,
  toastECFStart,
  toastSuccess,
  toastECFSuccess,
  toastError
} from '@/components/discovery/discoveryToasts';

const SEARCH_TEMPLATES = [
  {
    id: 'comprehensive',
    name: 'Comprehensive AI Match',
    description: 'Deep multi-source search using full profile analysis (RECOMMENDED)',
    icon: Sparkles,
    useComprehensiveMatch: true,
  },
  {
    id: 'custom',
    name: 'Quick Search',
    description: 'Fast search using basic profile information',
    icon: Search,
  },
  {
    id: 'faith_based',
    name: 'Faith-Based Organizations',
    description: 'Specialized search for churches, ministries, and faith-based nonprofits',
    icon: Heart,
    keywords: [
      'faith-based nonprofit',
      'church grant',
      'Christian ministry',
      'religious organization',
      'church ministry funding',
      'faith community outreach',
      'Christian nonprofit grant',
      'church building grant',
      'ministry expansion',
      'missionary support',
      'clergy grant',
      'denominational funding',
      'church renovation',
      'worship facility',
      'faith-based community service',
      'Christian education',
      'church youth program',
      'religious outreach',
      'church benevolence',
      'faith-based humanitarian aid'
    ],
    prompt: `Search for grants, cooperative agreements, awards, and funding programs in the United States available to:

- Faith-based and religious organizations, including churches, ministries, denominations, and individual licensed ministers
- Religious nonprofits that provide community outreach, education, housing, healthcare, or social-service programs
- Church-affiliated organizations serving communities through faith-based initiatives

Include funding sources from federal, state, and private foundations that support:
• Faith-based outreach and humanitarian aid
• Church facilities and infrastructure (building renovation, accessibility modifications)
• Religious education and youth programs
• Ministry and missionary support
• Church community service programs
• Faith-based counseling and recovery programs
• Religious childcare and education
• Church benevolence and assistance programs
• Denominational initiatives
• Interfaith community partnerships

Filter results to include programs that explicitly allow:
• 501(c)(3) religious nonprofits
• Churches and houses of worship
• Faith-based organizations
• Individual ministers with state credentials or denominational licenses
• Religious educational institutions
• Nationwide or multi-state eligibility`
  },
  {
    id: 'disability_services',
    name: 'Disability Services',
    description: 'Specialized search for organizations serving people with intellectual, developmental, or physical disabilities',
    icon: Heart,
    keywords: [
      'disability services',
      'intellectual disability',
      'developmental disability',
      'physical disability',
      'accessible housing',
      'disability employment',
      'inclusive employment',
      'community disability services',
      'disability nonprofit',
      'special needs services',
      'adaptive equipment',
      'accessibility grant',
      'disability support',
      'residential disability',
      'supported living',
      'vocational training disability',
      'disability transportation',
      'assistive technology',
      'disability inclusion',
      'community integration disability',
      'life skills disability',
      'respite care',
      'disability advocacy',
      'ADA compliance'
    ],
    prompt: `Search for grants, cooperative agreements, awards, and funding programs in the United States available to:

- Nonprofit human-services organizations providing community-based supports for people with intellectual, developmental, or physical disabilities (similar to Life Bridges TN or Community Options NJ)
- Disability service providers offering residential, employment, and community integration services
- Organizations serving individuals with special needs and their families

Include funding sources from federal, state, and private foundations that support:
• Residential or supported living programs
• Employment and vocational training for people with disabilities
• Accessible transportation services
• Accessible housing development
• Community inclusion and life-skills training
• Assistive technology and adaptive equipment
• Respite care for caregivers
• Day programs and recreational services
• Advocacy and rights protection
• Family support services
• Infrastructure improvements (facility upgrades, accessibility modifications)
• Staff and caregiver training

Filter results to include programs that explicitly allow:
• 501(c)(3) nonprofits serving people with disabilities
• Community-based disability service providers
• Residential facilities for people with disabilities
• Vocational rehabilitation programs
• Nationwide or multi-state eligibility`
  },
  {
    id: 'multi_tier_national',
    name: 'Multi-Tier National Discovery',
    description: 'Comprehensive search covering individuals, families/caregivers, and organizations serving qualifying populations',
    icon: Target,
    keywords: [
      // Tier 1 - Individual qualifiers
      'cancer survivor grant',
      'chronic illness assistance',
      'disability funding',
      'SSI recipient help',
      'SSDI benefits',
      'ECF CHOICES Tennessee',
      'senior citizen assistance',
      'veteran grant',
      'military family support',
      'low income aid',
      'unemployed assistance',
      'foster parent support',
      'adoptive parent funding',
      'immigrant assistance',
      'green card holder aid',
      'refugee support',
      'returning citizen grant',
      'formerly incarcerated help',
      'single parent funding',
      'clergy grant',
      'minister scholarship',
      'missionary support',
      'healthcare worker grant',
      'EMS worker assistance',
      'educator funding',
      'teacher grant',
      'public servant support',
      
      // Tier 2 - Family & caregiver expansion
      'family of veteran grant',
      'caregiver of cancer patient',
      'spouse of disability recipient',
      'child of immigrant scholarship',
      'family of senior citizen',
      'dependent of clergy',
      'Christian caregiver grant',
      'family caregiver support',
      'respite care funding',
      'caregiver assistance program',
      'family support services',
      
      // Tier 3 - Organizational layer
      'faith-based nonprofit',
      'ministry supporting families',
      'church caregiver outreach',
      'community action funding',
      'aging services grant',
      'immigrant family services',
      'veteran family support organization',
      'cancer support ministry',
      'disability family services',
      'community health organization'
    ],
    prompt: `Search all U.S.-based grants, financial-aid programs, and funding opportunities that serve individuals, families, caregivers, or nonprofit organizations connected to any qualifying group.

**TIER 1 – Primary Qualifiers:**
Cancer survivor or active cancer patient; chronic illness or disability; SSI/SSDI or ECF CHOICES of Tennessee recipient; senior citizen (65+); veteran or active military; low-income or unemployed individual; foster or adoptive parent; first- or second-generation immigrant; green-card holder; refugee; returning citizen; single parent; clergy, minister, or missionary; healthcare or EMS worker; educator or public servant; caregiver.

**TIER 2 – Family & Caregiver Expansion:**
Include spouses, dependents, parents, guardians, or primary caregivers of Tier 1 individuals.
Example keywords: family of veteran grant, caregiver of cancer patient funding, spouse of disability recipient assistance, child of immigrant scholarship, family of senior citizen aid, dependent of clergy scholarship, Christian caregiver grant.

**TIER 3 – Organizational/Community Layer:**
Include funding for 501(c)(3) nonprofits, ministries, churches, community organizations, or healthcare providers that serve or support Tiers 1 and 2 populations.
Search variants: faith-based nonprofit disability services grant, ministry supporting families of veterans, church caregiver outreach grant, community-action funding for immigrant families, aging-services family support program grant.

**FUNDING SOURCES TO INCLUDE:**
Federal agencies (HHS, HUD, USDA, DOE, VA, Administration for Community Living)
State and local programs
Private foundations (United Way, Lilly Endowment, Templeton Foundation, local community foundations)
Corporate CSR programs
Religious and faith-based funders

**PROGRAM FOCUS AREAS:**
• Health and medical assistance
• Housing and shelter
• Education and scholarships
• Faith-based ministry and outreach
• Social services and emergency aid
• Workforce development and employment
• Caregiver support and respite care
• Family support services
• Mental health and counseling
• Transportation and accessibility

**RETURN FOR EACH RESULT:**
• Funder/program name and contact information
• Eligible applicants (individual / family / caregiver / organization)
• Purpose area (health, housing, education, faith, social-service, workforce, emergency aid)
• Faith-based eligibility (explicitly allowed / restricted / not specified)
• Geographic scope (local, state, regional, national)
• Typical funding range and deadlines
• Special notes on family or caregiver eligibility

**RANKING CRITERIA:**
1. Programs explicitly funding both the qualifier AND their family/caregivers
2. Programs allowing faith-based or community nonprofits to serve those families
3. National reach with replicable models suitable for ministry or social-service partners
4. Programs with rolling or frequent deadlines

**CATEGORIZE RESULTS BY:**
- Health & Medical
- Social/Economic Support
- Faith-Based Ministry
- Education & Scholarships
- Housing & Shelter
- Workforce & Employment
- Emergency Assistance`
  },
  {
    id: 'ecf_services',
    name: 'ECF CHOICES Benefits & Services',
    description: 'Local services, benefits, and assistance for ECF CHOICES participants in Tennessee',
    icon: Heart,
    ecfOnly: true,
  },
];

export default function DiscoverGrants() {
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('comprehensive');
  const [searchState, setSearchState] = useState('idle'); // 'idle', 'loading', 'success', 'error'
  const [searchResults, setSearchResults] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [searchFilters] = useState({});
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('name'),
  });

  // Memoized selected organization
  const selectedOrg = useMemo(() => 
    organizations.find(o => o.id === selectedOrgId),
    [organizations, selectedOrgId]
  );

  const isECFProfile = selectedOrg?.medicaid_enrolled && selectedOrg?.medicaid_waiver_program === 'ecf_choices';

  const handleDiscover = async () => {
    // Validation
    if (!selectedOrgId) {
      showNoProfileToast(toast);
      return;
    }

    const template = SEARCH_TEMPLATES.find(t => t.id === selectedTemplate);

    // ECF validation
    if (template?.ecfOnly && !isECFProfile) {
      showECFErrorToast(toast);
      return;
    }

    // Reset state and start search
    setSearchState('loading');
    setSearchResults([]);
    setErrorMessage(null);

    try {
      let result;

      // Route to appropriate search handler
      if (template?.useComprehensiveMatch) {
        toastSearchStart(toast, true);
        result = await runComprehensiveMatch(selectedOrg, searchFilters);
        toastSuccess(toast, result.count, 'comprehensive');
      } else if (selectedTemplate === 'ecf_services') {
        toastECFStart(toast);
        result = await runECFServiceSearch(selectedOrgId, queryClient);
        toastECFSuccess(toast, result.count);
      } else {
        toastSearchStart(toast, false);
        result = await runStandardSearch(template, selectedOrgId, searchFilters);
        toastSuccess(toast, result.count, template?.name);
      }

      setSearchResults(result.opportunities);
      setSearchState('success');

    } catch (error) {
      console.error('[DiscoverGrants] Search error:', error);
      const message = error instanceof Error ? error.message : 'An error occurred while searching';
      setErrorMessage(message);
      setSearchState('error');
      toastError(toast, message);
    }
  };

  const handleAddToPipeline = async (opportunity) => {
    // Check for duplicates
    if (opportunity.url) {
      const existingGrants = await base44.entities.Grant.filter({
        organization_id: selectedOrgId,
        url: opportunity.url
      });
      
      if (existingGrants.length > 0) {
        toast({
          title: 'Already in Pipeline',
          description: `"${opportunity.title}" is already in your pipeline.`,
          variant: 'default',
        });
        return existingGrants[0];
      }
    }
    
    const grantData = {
      organization_id: selectedOrgId,
      title: opportunity.title,
      funder: opportunity.sponsor,
      url: opportunity.url,
      deadline: opportunity.deadlineAt,
      amount_min: opportunity.awardMin,
      amount_max: opportunity.awardMax,
      eligibility_summary: opportunity.eligibilityBullets?.join('\n') || '',
      program_description: opportunity.descriptionMd,
      status: 'discovered',
      match_score: opportunity.match,
    };

    try {
      const newGrant = await base44.entities.Grant.create(grantData);
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      toast({
        title: 'Grant Added to Pipeline',
        description: `${opportunity.title} has been added to your grants pipeline.`,
      });
      return newGrant;
    } catch (error) {
      console.error('Failed to add grant to pipeline:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({
        variant: 'destructive',
        title: 'Failed to Add Grant',
        description: message,
      });
    }
  };

  const isLoading = searchState === 'loading';
  const hasResults = searchState === 'success';
  const hasError = searchState === 'error';

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Search className="w-8 h-8 text-blue-600" />
            Discover Funding Opportunities
          </h1>
          <p className="text-slate-600 mt-2">
            Find scholarships, grants, benefits, and assistance programs that match your profile
          </p>
        </header>

        <Card className="shadow-lg border-0 mb-8">
          <CardHeader className="border-b border-slate-100">
            <CardTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-blue-600" />
              Select Profile to Search
            </CardTitle>
            <CardDescription>
              Choose a profile and search method to find matching opportunities
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6">
            <div className="space-y-4">
              {/* Profile Selector */}
              <div>
                <Label className="text-base font-semibold mb-3 block">Select Profile</Label>
                <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                  <SelectTrigger className="h-12">
                    <SelectValue placeholder="Choose an organization or individual..." />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map(org => {
                      const isOrgECF = org.medicaid_enrolled && org.medicaid_waiver_program === 'ecf_choices';
                      return (
                        <SelectItem key={org.id} value={org.id}>
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-slate-500" />
                            {org.name}
                            {isOrgECF && (
                              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs">
                                ECF CHOICES
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              {/* Selected Profile Info */}
              {selectedOrg && (
                <Alert className={
                  isECFProfile
                    ? 'bg-green-50 border-green-200'
                    : 'bg-blue-50 border-blue-200'
                }>
                  <User className={`h-4 w-4 ${
                    isECFProfile ? 'text-green-600' : 'text-blue-600'
                  }`} />
                  <AlertDescription className={
                    isECFProfile ? 'text-green-900' : 'text-blue-800'
                  }>
                    <strong>Selected:</strong> {selectedOrg.name}
                    {selectedOrg.applicant_type && (
                      <span className="ml-2">({selectedOrg.applicant_type.replace(/_/g, ' ')})</span>
                    )}
                    {selectedOrg.state && <span className="ml-2">• {selectedOrg.state}</span>}
                    {isECFProfile && (
                      <span className="block mt-1 font-semibold">
                        🏥 ECF CHOICES Participant
                      </span>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {/* Search Templates */}
              <div>
                <Label className="text-base font-semibold mb-3 block">Search Method</Label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {SEARCH_TEMPLATES.map(template => {
                    if (template.ecfOnly && !isECFProfile) return null;

                    const Icon = template.icon;
                    return (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => setSelectedTemplate(template.id)}
                        className={`p-4 rounded-lg border-2 text-left transition-all ${
                          selectedTemplate === template.id
                            ? 'border-blue-600 bg-blue-50'
                            : 'border-slate-200 bg-white hover:border-blue-300'
                        }`}
                      >
                        <div className="flex items-center gap-3 mb-2">
                          <Icon className={`w-5 h-5 ${
                            selectedTemplate === template.id ? 'text-blue-600' : 'text-slate-400'
                          }`} />
                          <h3 className="font-semibold">{template.name}</h3>
                        </div>
                        <p className="text-sm text-slate-600">{template.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Search Button */}
              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <Button
                  onClick={handleDiscover}
                  disabled={!selectedOrgId || isLoading}
                  className="bg-blue-600 hover:bg-blue-700 flex-1"
                  size="lg"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Searching...
                    </>
                  ) : (
                    <>
                      <Search className="w-5 h-5 mr-2" />
                      Discover Opportunities
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results Display */}
        {isLoading && (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Searching for Opportunities</h3>
              <p className="text-slate-600">
                Analyzing thousands of funding opportunities to find the best matches...
              </p>
            </CardContent>
          </Card>
        )}

        {hasError && (
          <Card className="shadow-lg border-0 border-l-4 border-l-red-500">
            <CardContent className="p-8">
              <div className="flex items-start gap-4">
                <div className="p-3 bg-red-50 rounded-lg">
                  <TrendingUp className="w-6 h-6 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">Search Error</h3>
                  <p className="text-slate-600 mb-4">{errorMessage}</p>
                  <Button onClick={handleDiscover} variant="outline">
                    Try Again
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {hasResults && searchResults.length === 0 && (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Matches Found</h3>
              <p className="text-slate-600">
                No opportunities found for this profile. Try adjusting the profile details or check data sources.
              </p>
            </CardContent>
          </Card>
        )}

        {hasResults && searchResults.length > 0 && (
          <SearchResults
            results={searchResults}
            profileId={selectedOrgId}
            onAddToPipeline={handleAddToPipeline}
            organizationName={selectedOrg?.name}
          />
        )}

        {!hasResults && !isLoading && !hasError && (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Ready to Discover Opportunities</h3>
              <p className="text-slate-600">
                Select a profile above and click "Discover Opportunities" to get started
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}