
import React, { useMemo, useState } from 'react';
import client from '@/api/client';
import { createLogger } from '@/utils/logger';
import { formatAddress } from '@/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Mail, Phone, Globe, MapPin, CheckCircle, Briefcase, Building, Heart, Tags, Target, Edit, X, Save } from 'lucide-react';
import EditableField from '../shared/EditableField';
import EditableTagList from '../shared/EditableTagList';
// removed â AIFormField is not used in this component
import { useToast } from '@/components/ui/use-toast';

// Field sets managed by each editable section. Only these keys are diffed/persisted.
const HEALTH_KEYS = [
  'cancer_survivor', 'chronic_illness', 'dialysis_patient', 'organ_transplant', 'hiv_aids', 'tbi_survivor',
  'amputee', 'neurodivergent', 'visual_impairment', 'hearing_impairment', 'wheelchair_user', 'substance_recovery',
  'mental_health_condition', 'long_covid', 'maternal_health', 'hospice_care',
  'cancer_type', 'cancer_diagnosis_year', 'chronic_illness_type'
];

const HEALTH_BADGE_KEYS = [
  'cancer_survivor', 'chronic_illness', 'dialysis_patient', 'organ_transplant', 'hiv_aids', 'tbi_survivor',
  'amputee', 'neurodivergent', 'visual_impairment', 'hearing_impairment', 'wheelchair_user', 'substance_recovery',
  'mental_health_condition', 'long_covid', 'maternal_health', 'hospice_care'
];

const DEMOGRAPHICS_KEYS = [
  'african_american', 'hispanic_latino', 'asian_american', 'native_american', 'lgbtq', 'new_immigrant',
  'tribal_affiliation'
];

const DEMOGRAPHICS_BADGE_KEYS = [
  'african_american', 'hispanic_latino', 'asian_american', 'native_american', 'lgbtq', 'new_immigrant'
];

const FAMILY_KEYS = [
  'single_parent', 'foster_youth', 'homeless', 'low_income', 'refugee', 'formerly_incarcerated', 'returning_citizen',
  'caregiver', 'orphan', 'adopted', 'widow_widower', 'grandparent_raising_grandchildren', 'first_time_parent',
  'domestic_violence_survivor', 'trafficking_survivor', 'disaster_survivor', 'minor_child', 'young_adult', 'foster_parent'
];

const SECTION_FIELD_SETS = {
  health: HEALTH_KEYS,
  demographics: DEMOGRAPHICS_KEYS,
  family: FAMILY_KEYS,
};

// Allow-list of fields that can ever be written from this component. Prevents arbitrary/server-managed
// keys from being pushed back to the server.
const EDITABLE_FIELDS = new Set([
  'keywords', 'focus_areas', 'current_college', 'target_colleges', 'intended_major',
  'extracurricular_activities', 'mission', 'primary_goal', 'target_population', 'geographic_focus',
  'funding_amount_needed', 'timeline', 'past_experience', 'unique_qualities', 'collaboration_partners',
  'sustainability_plan', 'barriers_faced', 'special_circumstances', 'program_areas',
  ...HEALTH_KEYS, ...DEMOGRAPHICS_KEYS, ...FAMILY_KEYS
]);

// Normalize/sanitize a user-supplied URL for safe use as an href.
function sanitizeWebsiteUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return null;
  // Prepend https:// if no scheme present
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href;
    }
    return null;
  } catch {
    return null;
  }
}

function formatNumber(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num.toLocaleString();
}

export default function OrganizationProfileDetails({ organization, contactMethods = [], onUpdate, isUpdating, taxonomyItems = [] }) {
  const { toast } = useToast();
  const log = useMemo(() => createLogger('OrganizationProfileDetails'), []);
  const [editingSection, setEditingSection] = useState(null);
  const [tempData, setTempData] = useState({});
  const [isGeneratingKeywords, setIsGeneratingKeywords] = useState(false);
  const [isGeneratingFocusAreas, setIsGeneratingFocusAreas] = useState(false);

  const emails = contactMethods.filter(c => c.type === 'email').map(c => c.value);
  const phones = contactMethods.filter(c => c.type === 'phone').map(c => c.value);

  const isOrganization = organization.applicant_type === 'organization' || !organization.applicant_type;
  const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(organization.applicant_type);
  const isIndividual = ['individual_need', 'medical_assistance', 'family'].includes(organization.applicant_type);

  // Helper function to handle updates
  const handleUpdate = (fieldName, value) => {
    log.debug('Updating field', fieldName);
    if (!onUpdate) {
      console.error('[OrganizationProfileDetails] onUpdate handler is missing!');
      return;
    }

    // Validate fieldName against an allow-list to prevent arbitrary field writes.
    if (typeof fieldName !== 'string' || !EDITABLE_FIELDS.has(fieldName)) {
      console.error('[OrganizationProfileDetails] Attempted to update disallowed field:', fieldName);
      return;
    }

    onUpdate({
      id: organization.id,
      orgData: { [fieldName]: value }
    });
  };

  // Start editing a section
  const startEditing = (section) => {
    setEditingSection(section);
    // Only copy the fields this section actually manages.
    const fieldSet = SECTION_FIELD_SETS[section] || [];
    const sectionData = {};
    fieldSet.forEach(key => {
      sectionData[key] = organization[key];
    });
    setTempData(sectionData);
  };

  // Save edits for a section
  const saveSection = () => {
    const fieldSet = SECTION_FIELD_SETS[editingSection] || [];
    const fieldsToUpdate = {};
    fieldSet.forEach(key => {
      if (!EDITABLE_FIELDS.has(key)) return;
      // Only include fields that have actually changed
      if (JSON.stringify(tempData[key]) !== JSON.stringify(organization[key])) {
        fieldsToUpdate[key] = tempData[key];
      }
    });

    if (Object.keys(fieldsToUpdate).length > 0 && onUpdate) {
      onUpdate({
        id: organization.id,
        orgData: fieldsToUpdate
      });
    }

    setEditingSection(null);
    setTempData({});
  };

  // Cancel editing
  const cancelEdit = () => {
    setEditingSection(null);
    setTempData({});
  };

  // Update temp data
  const updateTempField = (field, value) => {
    setTempData(prev => ({ ...prev, [field]: value }));
  };

  // When editing, currentData should reflect organization with tempData overrides for the managed fields.
  const currentData = editingSection ? { ...organization, ...tempData } : organization;

  // Get organization type label from taxonomy
  const orgTypeLabel = React.useMemo(() => {
    if (!isOrganization || !organization.nonprofit_type) return null;
    const item = taxonomyItems.find(t => t.group === 'organization_type' && t.slug === organization.nonprofit_type);
    return item ? item.label : organization.nonprofit_type;
  }, [organization.nonprofit_type, taxonomyItems, isOrganization]);

  const websiteUrl = sanitizeWebsiteUrl(organization.website);

  // AI suggestion for keywords
  const handleSuggestKeywords = async () => {
    setIsGeneratingKeywords(true);
    try {
      const contextInfo = `
Profile: ${organization.name}
Type: ${organization.applicant_type}
${organization.mission ? `Mission: ${organization.mission}` : ''}
${organization.primary_goal ? `Goal: ${organization.primary_goal}` : ''}
${organization.target_population ? `Population: ${organization.target_population}` : ''}
${organization.nonprofit_type ? `Organization Type: ${organization.nonprofit_type}` : ''}
${organization.intended_major ? `Major: ${organization.intended_major}` : ''}
${organization.assistance_categories ? `Assistance: ${organization.assistance_categories.join(', ')}` : ''}
`;

      const prompt = `Based on the following profile, suggest 8-12 relevant keywords that would help match this profile with funding opportunities. Return ONLY a JSON array of keyword strings.

PROFILE:
${contextInfo}

Return format: ["keyword1", "keyword2", "keyword3", ...]

Keywords should be:
- Specific and actionable
- Related to their field, demographics, or needs
- Useful for funding opportunity matching
- A mix of broad and specific terms`;

      const response = await client.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            keywords: { type: "array", items: { type: "string" } }
          }
        }
      });

      if (response && Array.isArray(response.keywords)) {
        // Sanitise: strings only, non-empty, max 60 chars, deduplicate
        const existing = organization.keywords || [];
        const sanitised = response.keywords
          .filter(k => typeof k === 'string' && k.trim().length > 0)
          .map(k => k.trim().slice(0, 60))
          .filter(k => !existing.includes(k));
        const merged = [...existing, ...sanitised];
        if (sanitised.length === 0) {
          toast({
            variant: 'destructive',
            title: 'No New Keywords',
            description: 'AI suggestions were already present or invalid.',
          });
          return;
        }
        handleUpdate('keywords', merged);
        toast({
          title: 'Keywords Generated',
          description: `Added ${sanitised.length} new keyword(s) to help match funding opportunities.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "AI Response Error",
          description: "The AI didn't return valid keywords. Please try again.",
        });
      }
    } catch (error) {
      console.error('Failed to generate keywords:', error);
      toast({
        variant: "destructive",
        title: "AI Suggestion Failed",
        description: error.message || "Could not generate keywords. Please check your connection and try again.",
      });
    } finally {
      setIsGeneratingKeywords(false);
    }
  };

  // AI suggestion for focus areas
  const handleSuggestFocusAreas = async () => {
    setIsGeneratingFocusAreas(true);
    try {
      const contextInfo = `
Profile: ${organization.name}
Type: ${organization.applicant_type}
${organization.mission ? `Mission: ${organization.mission}` : ''}
${organization.primary_goal ? `Goal: ${organization.primary_goal}` : ''}
${organization.program_areas && organization.program_areas.length > 0 ? `Programs: ${organization.program_areas.join(', ')}` : ''}
${organization.intended_major ? `Major: ${organization.intended_major}` : ''}
${organization.keywords && organization.keywords.length > 0 ? `Keywords: ${organization.keywords.join(', ')}` : ''}
`;

      const prompt = `Based on the following profile, suggest 5-8 focus areas or interests that describe what they work on or are passionate about. Return ONLY a JSON array of focus area strings.

PROFILE:
${contextInfo}

Return format: ["focus1", "focus2", "focus3", ...]

Focus areas should be:
- Thematic areas of work or interest
- Broader than keywords but specific enough to be meaningful
- Examples: "Youth Development", "Environmental Conservation", "STEM Education", "Mental Health Advocacy"`;

      const response = await client.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            focus_areas: { type: "array", items: { type: "string" } }
          }
        }
      });

      if (response && Array.isArray(response.focus_areas)) {
        const existing = organization.focus_areas || [];
        const sanitised = response.focus_areas
          .filter(f => typeof f === 'string' && f.trim().length > 0)
          .map(f => f.trim().slice(0, 80))
          .filter(f => !existing.includes(f));
        const merged = [...existing, ...sanitised];
        if (sanitised.length === 0) {
          toast({
            variant: 'destructive',
            title: 'No New Focus Areas',
            description: 'AI suggestions were already present or invalid.',
          });
          return;
        }
        handleUpdate('focus_areas', merged);
        toast({
          title: 'Focus Areas Generated',
          description: `Added ${sanitised.length} new focus area(s) to your profile.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "AI Response Error",
          description: "The AI didn't return valid focus areas. Please try again.",
        });
      }
    } catch (error) {
      console.error('Failed to generate focus areas:', error);
      toast({
        variant: "destructive",
        title: "AI Suggestion Failed",
        description: error.message || "Could not generate focus areas. Please check your connection and try again.",
      });
    } finally {
      setIsGeneratingFocusAreas(false);
    }
  };

  const gpaValue = organization.gpa !== null && organization.gpa !== undefined ? parseFloat(organization.gpa) : NaN;
  const annualBudgetFormatted = formatNumber(organization.annual_budget);
  const householdIncomeFormatted = formatNumber(organization.household_income);

  let dateOfBirthFormatted = null;
  if (organization.date_of_birth) {
    const dob = new Date(organization.date_of_birth);
    dateOfBirthFormatted = Number.isNaN(dob.getTime()) ? null : dob.toLocaleDateString();
  }

  return (
    <div className="space-y-6">
      {/* Contact Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-blue-600" />
            Contact Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {emails.length > 0 && (
            <div className="flex items-start gap-3">
              <Mail className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Email</div>
                {emails.map((email, idx) => (
                  <a key={idx} href={`mailto:${email}`} className="text-blue-600 hover:underline block">
                    {email}
                  </a>
                ))}
              </div>
            </div>
          )}

          {phones.length > 0 && (
            <div className="flex items-start gap-3">
              <Phone className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Phone</div>
                {phones.map((phone, idx) => (
                  <a key={idx} href={`tel:${phone}`} className="text-blue-600 hover:underline block">
                    {phone}
                  </a>
                ))}
              </div>
            </div>
          )}

          {websiteUrl && (
            <div className="flex items-start gap-3">
              <Globe className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Website</div>
                <a href={websiteUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  {organization.website}
                </a>
              </div>
            </div>
          )}

          {(organization.address || organization.city || organization.state || organization.zip) && (
            <div className="flex items-start gap-3">
              <MapPin className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Address</div>
                <div className="text-slate-600">
                  {organization.address && (
                    <div>{formatAddress(organization.address)}</div>
                  )}
                  {(organization.city || organization.state || organization.zip) && (
                    <div>
                      {organization.city}{organization.city && organization.state && ', '}{organization.state} {organization.zip}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Keywords & Focus Areas */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tags className="w-5 h-5 text-blue-600" />
            Keywords
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EditableTagList
            title="Tags"
            description="Keywords help match you with relevant funding opportunities"
            tags={organization.keywords || []}
            onTagsChange={(newTags) => handleUpdate('keywords', newTags)}
            onSuggest={handleSuggestKeywords}
            isSuggesting={isGeneratingKeywords}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="w-5 h-5 text-blue-600" />
            Focus Areas / Interests
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EditableTagList
            title="Tags"
            description="What areas of work or interest are you focused on?"
            tags={organization.focus_areas || []}
            onTagsChange={(newTags) => handleUpdate('focus_areas', newTags)}
            onSuggest={handleSuggestFocusAreas}
            isSuggesting={isGeneratingFocusAreas}
          />
        </CardContent>
      </Card>

      {/* Student Education Details - NEW SECTION */}
      {isStudent && (
        <Card className="border-indigo-200">
          <CardHeader className="bg-indigo-50">
            <CardTitle className="text-indigo-900">Education Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {organization.current_college && (
              <div className="mb-3">
                <div className="text-sm font-medium text-slate-700 mb-1">Current College/University</div>
                <EditableField
                  value={organization.current_college}
                  onSave={(value) => handleUpdate('current_college', value)}
                  disabled={isUpdating}
                />
              </div>
            )}

            <div className="mb-3">
              <div className="text-sm font-medium text-slate-700 mb-2">Target/Interested Colleges</div>
              <EditableTagList
                title="Colleges"
                description="Add all colleges/universities you're interested in, applying to, or attending. We'll search for school-specific scholarships and opportunities from these institutions."
                tags={organization.target_colleges || []}
                onTagsChange={(newTags) => handleUpdate('target_colleges', newTags)}
              />
            </div>

            {organization.intended_major && (
              <div className="mb-3">
                <div className="text-sm font-medium text-slate-700 mb-1">Intended Major</div>
                <EditableField
                  value={organization.intended_major}
                  onSave={(value) => handleUpdate('intended_major', value)}
                  disabled={isUpdating}
                />
              </div>
            )}

            {!Number.isNaN(gpaValue) && (
              <div className="mb-3">
                <div className="text-sm font-medium text-slate-700 mb-1">GPA</div>
                <div className="text-slate-600">{gpaValue.toFixed(2)}</div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              {organization.act_score && (
                <div>
                  <div className="text-sm font-medium text-slate-700 mb-1">ACT Score</div>
                  <div className="text-slate-600">{organization.act_score}</div>
                </div>
              )}
              {organization.sat_score && (
                <div>
                  <div className="text-sm font-medium text-slate-700 mb-1">SAT Score</div>
                  <div className="text-slate-600">{organization.sat_score}</div>
                </div>
              )}
            </div>

            {organization.extracurricular_activities && organization.extracurricular_activities.length > 0 && (
              <div className="mt-3">
                <div className="text-sm font-medium text-slate-700 mb-2">Extracurricular Activities</div>
                <EditableTagList
                  title="Activities"
                  tags={organization.extracurricular_activities}
                  onTagsChange={(newTags) => handleUpdate('extracurricular_activities', newTags)}
                />
              </div>
            )}

            {organization.first_generation && (
              <div className="mt-3 flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-indigo-600" />
                <span className="text-sm font-medium">First-Generation College Student</span>
              </div>
            )}
            {organization.stem_student && (
              <div className="mt-2 flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-indigo-600" />
                <span className="text-sm font-medium">STEM Field Student</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Organization Details */}
      {isOrganization && (
        <Card className="border-indigo-200">
          <CardHeader className="bg-indigo-50">
            <CardTitle className="text-indigo-900 flex items-center gap-2">
              <Building className="w-5 h-5" />
              Organization Details
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {organization.ein && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="text-sm font-medium text-slate-700">EIN</div>
                <div className="text-slate-600">{organization.ein}</div>
              </div>
            )}
            {organization.uei && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="text-sm font-medium text-slate-700">UEI</div>
                <div className="text-slate-600">{organization.uei}</div>
              </div>
            )}
            {orgTypeLabel && (
              <div className="mb-3">
                <div className="text-sm font-medium text-slate-700 mb-1">Organization Type</div>
                <div className="text-slate-600">{orgTypeLabel}</div>
              </div>
            )}
            {annualBudgetFormatted !== null && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="text-sm font-medium text-slate-700">Annual Budget</div>
                <div className="text-slate-600">${annualBudgetFormatted}</div>
              </div>
            )}
            {organization.staff_count && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="text-sm font-medium text-slate-700">Staff Count</div>
                <div className="text-slate-600">{organization.staff_count}</div>
              </div>
            )}
            {organization.indirect_rate && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="text-sm font-medium text-slate-700">Indirect Rate</div>
                <div className="text-slate-600">{organization.indirect_rate}%</div>
              </div>
            )}

            {/* General Qualifications with Descriptions */}
            {(organization.sam_registered || organization.faith_based || organization.rural || organization.minority_serving || 
              organization.c3_public_charity || organization.c3_private_foundation) && (
              <div className="mt-4 pt-4 border-t">
                <div className="text-sm font-semibold text-slate-700 mb-3">General Qualifications</div>
                <div className="space-y-2">
                  {organization.sam_registered && (
                    <div>
                      <Badge className="bg-indigo-100 text-indigo-800">SAM.gov Registered</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">System for Award Management - required for federal grants</p>
                    </div>
                  )}
                  {organization.faith_based && (
                    <div>
                      <Badge className="bg-indigo-100 text-indigo-800">Faith-Based Organization</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Religious nonprofit, church, ministry, or denominational organization</p>
                    </div>
                  )}
                  {organization.rural && (
                    <div>
                      <Badge className="bg-indigo-100 text-indigo-800">Serves Rural Area</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Organization primarily serves rural communities or populations</p>
                    </div>
                  )}
                  {organization.minority_serving && (
                    <div>
                      <Badge className="bg-indigo-100 text-indigo-800">Minority-Serving</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Organization primarily serves minority populations or communities</p>
                    </div>
                  )}
                  {organization.c3_public_charity && (
                    <div>
                      <Badge className="bg-indigo-100 text-indigo-800">501(c)(3) Public Charity</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Tax-exempt nonprofit that receives public support</p>
                    </div>
                  )}
                  {organization.c3_private_foundation && (
                    <div>
                      <Badge className="bg-indigo-100 text-indigo-800">501(c)(3) Private Foundation</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Tax-exempt nonprofit funded by single source/family</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Specialized Organization Types with Descriptions */}
            {(organization.fqhc || organization.community_action_agency || organization.cdc_org || 
              organization.housing_authority || organization.workforce_board || organization.veterans_service_org ||
              organization.volunteer_fire_ems || organization.research_institute || organization.cooperative ||
              organization.cdfi_partner || organization.msi_institution || organization.rural_health_clinic ||
              organization.environmental_org || organization.labor_union_org || organization.agricultural_extension) && (
              <div className="mt-4 pt-4 border-t">
                <div className="text-sm font-semibold text-slate-700 mb-3">Specialized Organization Types</div>
                <div className="space-y-2">
                  {organization.fqhc && (
                    <div>
                      <Badge className="bg-purple-100 text-purple-800">FQHC</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Federally Qualified Health Center</p>
                    </div>
                  )}
                  {organization.community_action_agency && (
                    <div>
                      <Badge className="bg-purple-100 text-purple-800">Community Action Agency</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Federally designated anti-poverty organization</p>
                    </div>
                  )}
                  {organization.cdc_org && (
                    <div>
                      <Badge className="bg-purple-100 text-purple-800">CDC</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Community Development Corporation - nonprofit focused on revitalizing communities</p>
                    </div>
                  )}
                  {organization.housing_authority && (
                    <div>
                      <Badge className="bg-purple-100 text-purple-800">Housing Authority</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Public or tribal housing agency</p>
                    </div>
                  )}
                  {organization.workforce_board && (
                    <div>
                      <Badge className="bg-purple-100 text-purple-800">Workforce Development Board</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Local workforce investment board</p>
                    </div>
                  )}
                  {organization.veterans_service_org && (
                    <div>
                      <Badge className="bg-purple-100 text-purple-800">Veterans Service Organization</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Organization serving veterans and military families</p>
                    </div>
                  )}
                  {organization.msi_institution && (
                    <div>
                      <Badge className="bg-purple-100 text-purple-800">MSI/HBCU/HSI/TCU</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Minority-Serving Institution / Historically Black College / Hispanic-Serving / Tribal College</p>
                    </div>
                  )}
                  {organization.cdfi_partner && (
                    <div>
                      <Badge className="bg-purple-100 text-purple-800">CDFI Partner</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Community Development Financial Institution</p>
                    </div>
                  )}
                  {organization.volunteer_fire_ems && <Badge className="bg-purple-100 text-purple-800">Volunteer Fire/EMS</Badge>}
                  {organization.research_institute && <Badge className="bg-purple-100 text-purple-800">Research Institute</Badge>}
                  {organization.cooperative && <Badge className="bg-purple-100 text-purple-800">Cooperative</Badge>}
                  {organization.rural_health_clinic && <Badge className="bg-purple-100 text-purple-800">Rural Health Clinic</Badge>}
                  {organization.environmental_org && <Badge className="bg-purple-100 text-purple-800">Environmental Org</Badge>}
                  {organization.labor_union_org && <Badge className="bg-purple-100 text-purple-800">Labor Union</Badge>}
                  {organization.agricultural_extension && <Badge className="bg-purple-100 text-purple-800">Agricultural Extension</Badge>}
                </div>
              </div>
            )}

            {/* Business Certifications with Descriptions */}
            {(organization.business_8a || organization.sdvosb || organization.hubzone || organization.dbe ||
              organization.mbe || organization.wbe || organization.sbe || organization.minority_owned_business ||
              organization.women_owned_business) && (
              <div className="mt-4 pt-4 border-t">
                <div className="text-sm font-semibold text-slate-700 mb-3">Business Certifications</div>
                <div className="space-y-2">
                  {organization.business_8a && (
                    <div>
                      <Badge className="bg-green-100 text-green-800">8(a) Certified</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">SBA program for disadvantaged business enterprises</p>
                    </div>
                  )}
                  {organization.sdvosb && (
                    <div>
                      <Badge className="bg-green-100 text-green-800">SDVOSB</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Service-Disabled Veteran-Owned Small Business (VA-verified certification)</p>
                    </div>
                  )}
                  {organization.hubzone && (
                    <div>
                      <Badge className="bg-green-100 text-green-800">HUBZone Certified</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Historically Underutilized Business Zone certification</p>
                    </div>
                  )}
                  {organization.dbe && (
                    <div>
                      <Badge className="bg-green-100 text-green-800">DBE</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Disadvantaged Business Enterprise - DOT certification for minority/women-owned businesses</p>
                    </div>
                  )}
                  {organization.mbe && (
                    <div>
                      <Badge className="bg-green-100 text-green-800">MBE</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Minority Business Enterprise - state/local certification</p>
                    </div>
                  )}
                  {organization.wbe && (
                    <div>
                      <Badge className="bg-green-100 text-green-800">WBE</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Women Business Enterprise - state/local certification</p>
                    </div>
                  )}
                  {organization.minority_owned_business && <Badge className="bg-green-100 text-green-800">Minority-Owned Business</Badge>}
                  {organization.women_owned_business && <Badge className="bg-green-100 text-green-800">Women-Owned Business</Badge>}
                  {organization.sbe && <Badge className="bg-green-100 text-green-800">SBE</Badge>}
                </div>
              </div>
            )}

            {/* Geographic & Special Designations with Descriptions */}
            {(organization.qct || organization.opportunity_zone || organization.ej_area || 
              organization.persistent_poverty_county || organization.tribal_land || organization.us_territory ||
              organization.fema_disaster_area || organization.appalachian_region || organization.urban_underserved) && (
              <div className="mt-4 pt-4 border-t">
                <div className="text-sm font-semibold text-slate-700 mb-3">Geographic & Special Designations</div>
                <div className="space-y-2">
                  {organization.qct && (
                    <div>
                      <Badge className="bg-orange-100 text-orange-800">QCT</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Qualified Census Tract - HUD-designated low-income area</p>
                    </div>
                  )}
                  {organization.opportunity_zone && (
                    <div>
                      <Badge className="bg-orange-100 text-orange-800">Opportunity Zone</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Economically distressed community eligible for tax incentives</p>
                    </div>
                  )}
                  {organization.ej_area && (
                    <div>
                      <Badge className="bg-orange-100 text-orange-800">Environmental Justice Area</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">EPA-designated community with environmental and health disparities</p>
                    </div>
                  )}
                  {organization.persistent_poverty_county && (
                    <div>
                      <Badge className="bg-orange-100 text-orange-800">Persistent Poverty County</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">USDA county with 20%+ poverty for 30+ years</p>
                    </div>
                  )}
                  {organization.fema_disaster_area && (
                    <div>
                      <Badge className="bg-orange-100 text-orange-800">FEMA Disaster Area</Badge>
                      <p className="text-xs text-slate-500 mt-1 ml-1">Area with active or recent federal disaster declaration</p>
                    </div>
                  )}
                  {organization.tribal_land && <Badge className="bg-orange-100 text-orange-800">Tribal Land</Badge>}
                  {organization.us_territory && <Badge className="bg-orange-100 text-orange-800">U.S. Territory</Badge>}
                  {organization.appalachian_region && <Badge className="bg-orange-100 text-orange-800">Appalachian Region</Badge>}
                  {organization.urban_underserved && <Badge className="bg-orange-100 text-orange-800">Urban Underserved</Badge>}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {organization.program_areas && organization.program_areas.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-blue-600" />
              Program Areas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EditableTagList
              title="Program Areas"
              tags={organization.program_areas}
              onTagsChange={(newTags) => handleUpdate('program_areas', newTags)}
            />
          </CardContent>
        </Card>
      )}

      {/* Individual/Assistance Details */}
      {isIndividual && organization.assistance_categories && organization.assistance_categories.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Heart className="w-5 h-5 text-rose-600" />
              Assistance Needed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {organization.assistance_categories.map((slug, idx) => {
                const item = taxonomyItems.find(t => t.group === 'individual_assistance' && t.slug === slug);
                const label = item ? item.label : slug;
                return (
                  <Badge key={idx} variant="outline" className="bg-rose-50 text-rose-700">
                    {label}
                  </Badge>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Mission / Bio */}
      {organization.mission && (
        <Card>
          <CardHeader>
            <CardTitle>
              {isOrganization ? 'Mission Statement' : isStudent ? 'Personal Statement' : 'Bio'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.mission}
              onSave={(value) => handleUpdate('mission', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {/* AI Narrative Questions */}
      {organization.primary_goal && (
        <Card>
          <CardHeader>
            <CardTitle>Primary Goal</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.primary_goal}
              onSave={(value) => handleUpdate('primary_goal', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.target_population && (
        <Card>
          <CardHeader>
            <CardTitle>{isOrganization ? 'Target Population' : isStudent ? 'Background & Identity' : 'Personal Story'}</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.target_population}
              onSave={(value) => handleUpdate('target_population', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.geographic_focus && (
        <Card>
          <CardHeader>
            <CardTitle>Geographic Focus</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.geographic_focus}
              onSave={(value) => handleUpdate('geographic_focus', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.funding_amount_needed && (
        <Card>
          <CardHeader>
            <CardTitle>Funding Need</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.funding_amount_needed}
              onSave={(value) => handleUpdate('funding_amount_needed', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.timeline && (
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.timeline}
              onSave={(value) => handleUpdate('timeline', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.past_experience && (
        <Card>
          <CardHeader>
            <CardTitle>Track Record / Past Experience</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.past_experience}
              onSave={(value) => handleUpdate('past_experience', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.unique_qualities && (
        <Card>
          <CardHeader>
            <CardTitle>Unique Qualities / Competitive Advantage</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.unique_qualities}
              onSave={(value) => handleUpdate('unique_qualities', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.collaboration_partners && (
        <Card>
          <CardHeader>
            <CardTitle>Collaboration Partners / Support System</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.collaboration_partners}
              onSave={(value) => handleUpdate('collaboration_partners', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.sustainability_plan && (
        <Card>
          <CardHeader>
            <CardTitle>Sustainability / Long-Term Plans</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.sustainability_plan}
              onSave={(value) => handleUpdate('sustainability_plan', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {organization.barriers_faced && (
        <Card>
          <CardHeader>
            <CardTitle>Barriers / Challenges</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.barriers_faced}
              onSave={(value) => handleUpdate('barriers_faced', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {isIndividual && organization.special_circumstances && (
        <Card>
          <CardHeader>
            <CardTitle>Special Circumstances</CardTitle>
          </CardHeader>
          <CardContent>
            <EditableField
              value={organization.special_circumstances}
              onSave={(value) => handleUpdate('special_circumstances', value)}
              multiline
              disabled={isUpdating}
            />
          </CardContent>
        </Card>
      )}

      {/* Personal Information (Individuals Only) */}
      {isIndividual && (organization.date_of_birth || organization.age || organization.household_income || organization.household_size || organization.immigration_status) && (
        <Card>
          <CardHeader>
            <CardTitle>Personal Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {dateOfBirthFormatted && (
              <div className="grid grid-cols-2 gap-2">
                <div className="text-sm font-medium text-slate-700">Date of Birth</div>
                <div className="text-slate-600">{dateOfBirthFormatted}</div>
              </div>
            )}
            {organization.age && (
              <div className="grid grid-cols-2 gap-2">
                <div className="text-sm font-medium text-slate-700">Age</div>
                <div className="text-slate-600">{organization.age}</div>
              </div>
            )}
            {organization.immigration_status && (
              <div className="grid grid-cols-2 gap-2">
                <div className="text-sm font-medium text-slate-700">Immigration Status</div>
                <div className="text-slate-600">{organization.immigration_status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</div>
              </div>
            )}
            {organization.household_size && (
              <div className="grid grid-cols-2 gap-2">
                <div className="text-sm font-medium text-slate-700">Household Size</div>
                <div className="text-slate-600">{organization.household_size} people</div>
              </div>
            )}
            {householdIncomeFormatted !== null && (
              <div className="grid grid-cols-2 gap-2">
                <div className="text-sm font-medium text-slate-700">Annual Household Income</div>
                <div className="text-slate-600">${householdIncomeFormatted}</div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Government Assistance Programs */}
      {(isIndividual || isStudent) && (organization.medicaid_enrolled || organization.medicare_recipient || 
       organization.ssi_recipient || organization.ssdi_recipient || organization.snap_recipient || 
       organization.tanf_recipient || organization.section8_housing || organization.public_housing_resident || 
       organization.medicaid_waiver_program || organization.tenncare_id) && (
        <Card className="border-teal-200">
          <CardHeader className="bg-teal-50">
            <CardTitle className="text-teal-900">Government Assistance Programs</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="space-y-2">
              {organization.medicaid_enrolled && (
                <div>
                  <Badge className="bg-teal-100 text-teal-800">Medicaid</Badge>
                  {organization.medicaid_waiver_program && organization.medicaid_waiver_program !== 'none' && (
                    <div className="ml-4 mt-1">
                      <span className="text-sm text-slate-600">Waiver: </span>
                      <span className="text-sm font-medium text-slate-700">
                        {organization.medicaid_waiver_program === 'ecf_choices' && 'ECF CHOICES (TN) - Employment and Community First CHOICES'}
                        {organization.medicaid_waiver_program === 'katie_beckett' && 'Katie Beckett - Medicaid for children with disabilities regardless of parent income'}
                        {organization.medicaid_waiver_program === 'self_determination' && 'Self-Determination'}
                        {organization.medicaid_waiver_program === 'family_support' && 'Family Support'}
                        {organization.medicaid_waiver_program === 'other' && 'Other'}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {organization.medicare_recipient && <Badge className="bg-teal-100 text-teal-800">Medicare</Badge>}
              {organization.ssi_recipient && (
                <div>
                  <Badge className="bg-teal-100 text-teal-800">SSI</Badge>
                  <p className="text-xs text-slate-500 mt-1 ml-1">Supplemental Security Income - cash assistance for disabled, blind, or elderly with limited income</p>
                </div>
              )}
              {organization.ssdi_recipient && (
                <div>
                  <Badge className="bg-teal-100 text-teal-800">SSDI</Badge>
                  <p className="text-xs text-slate-500 mt-1 ml-1">Social Security Disability Insurance - for those who worked and paid Social Security taxes</p>
                </div>
              )}
              {organization.snap_recipient && (
                <div>
                  <Badge className="bg-teal-100 text-teal-800">SNAP</Badge>
                  <p className="text-xs text-slate-500 mt-1 ml-1">Supplemental Nutrition Assistance Program (Food Stamps)</p>
                </div>
              )}
              {organization.tanf_recipient && (
                <div>
                  <Badge className="bg-teal-100 text-teal-800">TANF</Badge>
                  <p className="text-xs text-slate-500 mt-1 ml-1">Temporary Assistance for Needy Families - cash assistance and support services</p>
                </div>
              )}
              {organization.section8_housing && <Badge className="bg-teal-100 text-teal-800">Section 8 Housing</Badge>}
              {organization.public_housing_resident && <Badge className="bg-teal-100 text-teal-800">Public Housing Resident</Badge>}
            </div>
            {organization.tenncare_id && (
              <div className="mt-3 pt-3 border-t">
                <div className="text-sm font-medium text-slate-700 mb-1">TennCare ID</div>
                <div className="text-slate-600">{organization.tenncare_id}</div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Health & Medical Conditions - EDITABLE */}
      {isIndividual && (
        <Card className="border-rose-200">
          <CardHeader className="bg-rose-50 flex flex-row items-center justify-between">
            <CardTitle className="text-rose-900">Health & Medical Conditions</CardTitle>
            {editingSection !== 'health' ? (
              <Button variant="ghost" size="sm" onClick={() => startEditing('health')} disabled={isUpdating}>
                <Edit className="w-4 h-4" />
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={isUpdating}>
                  <X className="w-4 h-4" />
                </Button>
                <Button variant="default" size="sm" onClick={saveSection} disabled={isUpdating}>
                  <Save className="w-4 h-4" />
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="pt-4">
            {editingSection === 'health' ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'cancer_survivor', label: 'Cancer Survivor' },
                    { id: 'chronic_illness', label: 'Chronic Illness' },
                    { id: 'dialysis_patient', label: 'Dialysis Patient' },
                    { id: 'organ_transplant', label: 'Organ Transplant' },
                    { id: 'hiv_aids', label: 'HIV/AIDS' },
                    { id: 'tbi_survivor', label: 'TBI Survivor' },
                    { id: 'amputee', label: 'Amputee' },
                    { id: 'neurodivergent', label: 'Neurodivergent' },
                    { id: 'visual_impairment', label: 'Visual Impairment' },
                    { id: 'hearing_impairment', label: 'Hearing Impairment' },
                    { id: 'wheelchair_user', label: 'Wheelchair User' },
                    { id: 'substance_recovery', label: 'Substance Recovery' },
                    { id: 'mental_health_condition', label: 'Mental Health' },
                    { id: 'long_covid', label: 'Long COVID' },
                    { id: 'maternal_health', label: 'Maternal Health' },
                    { id: 'hospice_care', label: 'Hospice Care' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={currentData[item.id] === true}
                        onCheckedChange={(checked) => updateTempField(item.id, checked === true)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
                {currentData.cancer_survivor && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3 mt-3 bg-rose-50 rounded">
                    <div>
                      <Label htmlFor="cancer_type" className="text-sm font-medium">Cancer Type</Label>
                      <Input
                        id="cancer_type"
                        value={currentData.cancer_type || ''}
                        onChange={(e) => updateTempField('cancer_type', e.target.value)}
                        placeholder="e.g., Breast, Lung"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="cancer_diagnosis_year" className="text-sm font-medium">Diagnosis Year</Label>
                      <Input
                        id="cancer_diagnosis_year"
                        type="number"
                        value={currentData.cancer_diagnosis_year || ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === '' || raw === null || raw === undefined) {
                            updateTempField('cancer_diagnosis_year', null);
                            return;
                          }
                          const parsed = /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN;
                          updateTempField('cancer_diagnosis_year', Number.isNaN(parsed) ? null : parsed);
                        }}
                        placeholder="2020"
                        className="mt-1"
                      />
                    </div>
                  </div>
                )}
                {currentData.chronic_illness && (
                  <div className="p-3 mt-3 bg-rose-50 rounded">
                    <Label htmlFor="chronic_illness_type" className="text-sm font-medium">Chronic Illness Type</Label>
                    <Input
                      id="chronic_illness_type"
                      value={currentData.chronic_illness_type || ''}
                      onChange={(e) => updateTempField('chronic_illness_type', e.target.value)}
                      placeholder="e.g., Diabetes, Heart Disease"
                      className="mt-1"
                    />
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap gap-2">
                  {currentData.cancer_survivor && <Badge className="bg-rose-100 text-rose-800">Cancer Survivor</Badge>}
                  {currentData.chronic_illness && <Badge className="bg-rose-100 text-rose-800">Chronic Illness</Badge>}
                  {currentData.dialysis_patient && <Badge className="bg-rose-100 text-rose-800">Dialysis Patient</Badge>}
                  {currentData.organ_transplant && <Badge className="bg-rose-100 text-rose-800">Organ Transplant</Badge>}
                  {currentData.hiv_aids && <Badge className="bg-rose-100 text-rose-800">HIV/AIDS</Badge>}
                  {currentData.tbi_survivor && <Badge className="bg-rose-100 text-rose-800">TBI Survivor</Badge>}
                  {currentData.amputee && <Badge className="bg-rose-100 text-rose-800">Amputee</Badge>}
                  {currentData.neurodivergent && <Badge className="bg-rose-100 text-rose-800">Neurodivergent</Badge>}
                  {currentData.visual_impairment && <Badge className="bg-rose-100 text-rose-800">Visual Impairment</Badge>}
                  {currentData.hearing_impairment && <Badge className="bg-rose-100 text-rose-800">Hearing Impairment</Badge>}
                  {currentData.wheelchair_user && <Badge className="bg-rose-100 text-rose-800">Wheelchair User</Badge>}
                  {currentData.substance_recovery && <Badge className="bg-rose-100 text-rose-800">Substance Recovery</Badge>}
                  {currentData.mental_health_condition && <Badge className="bg-rose-100 text-rose-800">Mental Health</Badge>}
                  {currentData.long_covid && <Badge className="bg-rose-100 text-rose-800">Long COVID</Badge>}
                  {currentData.maternal_health && <Badge className="bg-rose-100 text-rose-800">Maternal Health</Badge>}
                  {currentData.hospice_care && <Badge className="bg-rose-100 text-rose-800">Hospice Care</Badge>}
                  {!HEALTH_BADGE_KEYS.some(k => currentData[k] === true) && (
                    <p className="text-sm text-slate-500 italic">No health conditions recorded. Click edit to add.</p>
                  )}
                </div>
                {(currentData.cancer_type || currentData.cancer_diagnosis_year || currentData.chronic_illness_type) && (
                  <div className="mt-3 pt-3 border-t space-y-2">
                    {currentData.cancer_type && (
                      <div>
                        <div className="text-sm font-medium text-slate-700 mb-1">Cancer Type</div>
                        <div className="text-slate-600">{currentData.cancer_type}</div>
                      </div>
                    )}
                    {currentData.cancer_diagnosis_year && (
                      <div>
                        <div className="text-sm font-medium text-slate-700 mb-1">Diagnosis Year</div>
                        <div className="text-slate-600">{currentData.cancer_diagnosis_year}</div>
                      </div>
                    )}
                    {currentData.chronic_illness_type && (
                      <div>
                        <div className="text-sm font-medium text-slate-700 mb-1">Chronic Illness Type</div>
                        <div className="text-slate-600">{currentData.chronic_illness_type}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Demographics & Background - EDITABLE */}
      {isIndividual && (
        <Card className="border-amber-200">
          <CardHeader className="bg-amber-50 flex flex-row items-center justify-between">
            <CardTitle className="text-amber-900">Demographics & Background</CardTitle>
            {editingSection !== 'demographics' ? (
              <Button variant="ghost" size="sm" onClick={() => startEditing('demographics')} disabled={isUpdating}>
                <Edit className="w-4 h-4" />
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={isUpdating}>
                  <X className="w-4 h-4" />
                </Button>
                <Button variant="default" size="sm" onClick={saveSection} disabled={isUpdating}>
                  <Save className="w-4 h-4" />
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="pt-4">
            {editingSection === 'demographics' ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'african_american', label: 'African American / Black' },
                    { id: 'hispanic_latino', label: 'Hispanic / Latino' },
                    { id: 'asian_american', label: 'Asian American' },
                    { id: 'native_american', label: 'Native American' },
                    { id: 'lgbtq', label: 'LGBTQ+' },
                    { id: 'new_immigrant', label: 'New Immigrant' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={currentData[item.id] === true}
                        onCheckedChange={(checked) => updateTempField(item.id, checked === true)}
                      />
                      <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                    </div>
                  ))}
                </div>
                {currentData.native_american && (
                  <div className="p-3 mt-3 bg-amber-50 rounded">
                    <Label htmlFor="tribal_affiliation" className="text-sm font-medium">Tribal Affiliation</Label>
                    <Input
                      id="tribal_affiliation"
                      value={currentData.tribal_affiliation || ''}
                      onChange={(e) => updateTempField('tribal_affiliation', e.target.value)}
                      placeholder="Name of tribe"
                      className="mt-1"
                    />
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap gap-2">
                  {currentData.african_american && <Badge className="bg-amber-100 text-amber-800">African American / Black</Badge>}
                  {currentData.hispanic_latino && <Badge className="bg-amber-100 text-amber-800">Hispanic / Latino</Badge>}
                  {currentData.asian_american && <Badge className="bg-amber-100 text-amber-800">Asian American</Badge>}
                  {currentData.native_american && <Badge className="bg-amber-100 text-amber-800">Native American</Badge>}
                  {currentData.lgbtq && <Badge className="bg-amber-100 text-amber-800">LGBTQ+</Badge>}
                  {currentData.new_immigrant && <Badge className="bg-amber-100 text-amber-800">New Immigrant</Badge>}
                  {!DEMOGRAPHICS_BADGE_KEYS.some(k => currentData[k] === true) && (
                    <p className="text-sm text-slate-500 italic">No demographics recorded. Click edit to add.</p>
                  )}
                </div>
                {currentData.tribal_affiliation && (
                  <div className="mt-3 pt-3 border-t">
                    <div className="text-sm font-medium text-slate-700 mb-1">Tribal Affiliation</div>
                    <div className="text-slate-600">{currentData.tribal_affiliation}</div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Family & Life - EDITABLE */}
      {isIndividual && (
        <Card className="border-blue-200">
          <CardHeader className="bg-blue-50 flex flex-row items-center justify-between">
            <CardTitle className="text-blue-900">Family & Life Situation</CardTitle>
            {editingSection !== 'family' ? (
              <Button variant="ghost" size="sm" onClick={() => startEditing('family')} disabled={isUpdating}>
                <Edit className="w-4 h-4" />
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={isUpdating}>
                  <X className="w-4 h-4" />
                </Button>
                <Button variant="default" size="sm" onClick={saveSection} disabled={isUpdating}>
                  <Save className="w-4 h-4" />
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="pt-4">
            {editingSection === 'family' ? (
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: 'single_parent', label: 'Single Parent' },
                  { id: 'foster_youth', label: 'Foster Youth' },
                  { id: 'homeless', label: 'Homeless/Housing Insecure' },
                  { id: 'low_income', label: 'Low Income' },
                  { id: 'refugee', label: 'Refugee' },
                  { id: 'formerly_incarcerated', label: 'Formerly Incarcerated / Returning Citizen' },
                  { id: 'caregiver', label: 'Family Caregiver' },
                  { id: 'orphan', label: 'Orphan' },
                  { id: 'adopted', label: 'Adopted' },
                  { id: 'widow_widower', label: 'Widow/Widower' },
                  { id: 'grandparent_raising_grandchildren', label: 'Grandparent Raising Grandchildren' },
                  { id: 'first_time_parent', label: 'First-Time Parent' },
                  { id: 'domestic_violence_survivor', label: 'Domestic Violence Survivor' },
                  { id: 'trafficking_survivor', label: 'Trafficking Survivor' },
                  { id: 'disaster_survivor', label: 'Disaster Survivor' },
                  { id: 'minor_child', label: 'Minor Child' },
                  { id: 'young_adult', label: 'Young Adult (18-24)' },
                  { id: 'foster_parent', label: 'Foster Parent' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={currentData[item.id] === true || (item.id === 'formerly_incarcerated' && currentData.returning_citizen === true)}
                      onCheckedChange={(checked) => {
                        const isChecked = checked === true;
                        updateTempField(item.id, isChecked);
                        // Sync returning_citizen with formerly_incarcerated
                        if (item.id === 'formerly_incarcerated') {
                          updateTempField('returning_citizen', isChecked);
                        }
                      }}
                    />
                    <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {currentData.single_parent && <Badge className="bg-blue-100 text-blue-800">Single Parent</Badge>}
                {currentData.foster_youth && <Badge className="bg-blue-100 text-blue-800">Foster Youth</Badge>}
                {currentData.homeless && <Badge className="bg-blue-100 text-blue-800">Homeless/Housing Insecure</Badge>}
                {currentData.low_income && <Badge className="bg-blue-100 text-blue-800">Low Income</Badge>}
                {currentData.refugee && <Badge className="bg-blue-100 text-blue-800">Refugee</Badge>}
                {(currentData.formerly_incarcerated || currentData.returning_citizen) && <Badge className="bg-blue-100 text-blue-800">Formerly Incarcerated / Returning Citizen</Badge>}
                {currentData.caregiver && <Badge className="bg-blue-100 text-blue-800">Family Caregiver</Badge>}
                {currentData.orphan && <Badge className="bg-blue-100 text-blue-800">Orphan</Badge>}
                {currentData.adopted && <Badge className="bg-blue-100 text-blue-800">Adopted</Badge>}
                {currentData.widow_widower && <Badge className="bg-blue-100 text-blue-800">Widow/Widower</Badge>}
                {currentData.grandparent_raising_grandchildren && <Badge className="bg-blue-100 text-blue-800">Grandparent Raising Grandchildren</Badge>}
                {currentData.first_time_parent && <Badge className="bg-blue-100 text-blue-800">First-Time Parent</Badge>}
                {currentData.domestic_violence_survivor && <Badge className="bg-blue-100 text-blue-800">Domestic Violence Survivor</Badge>}
                {currentData.trafficking_survivor && <Badge className="bg-blue-100 text-blue-800">Trafficking Survivor</Badge>}
                {currentData.disaster_survivor && <Badge className="bg-blue-100 text-blue-800">Disaster Survivor</Badge>}
                {currentData.minor_child && <Badge className="bg-blue-100 text-blue-800">Minor Child</Badge>}
                {currentData.young_adult && <Badge className="bg-blue-100 text-blue-800">Young Adult (18-24)</Badge>}
                {currentData.foster_parent && <Badge className="bg-blue-100 text-blue-800">Foster Parent</Badge>}
                {!FAMILY_KEYS.some(k => currentData[k] === true) && (
                  <p className="text-sm text-slate-500 italic">No family/life situation recorded. Click edit to add.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Military Status */}
      {(organization.veteran || organization.active_duty_military || organization.national_guard || organization.disabled_veteran || organization.military_spouse || organization.military_dependent || organization.gold_star_family) && (
        <Card className="border-indigo-200">
          <CardHeader className="bg-indigo-50">
            <CardTitle className="text-indigo-900">Military Service</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-2">
              {organization.veteran && <Badge className="bg-indigo-100 text-indigo-800">Veteran</Badge>}
              {organization.active_duty_military && <Badge className="bg-indigo-100 text-indigo-800">Active Duty</Badge>}
              {organization.national_guard && <Badge className="bg-indigo-100 text-indigo-800">National Guard/Reserve</Badge>}
              {organization.disabled_veteran && <Badge className="bg-indigo-100 text-indigo-800">Disabled Veteran</Badge>}
              {organization.military_spouse && <Badge className="bg-indigo-100 text-indigo-800">Military Spouse</Badge>}
              {organization.military_dependent && <Badge className="bg-indigo-100 text-indigo-800">Military Dependent</Badge>}
              {organization.gold_star_family && <Badge className="bg-indigo-100 text-indigo-800">Gold Star Family</Badge>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Occupation & Work */}
      {isIndividual && (organization.healthcare_worker || organization.ems_worker || organization.educator || organization.firefighter || organization.law_enforcement || organization.public_servant || organization.clergy || organization.missionary || organization.nonprofit_employee || organization.small_business_owner || organization.minority_owned_business || organization.women_owned_business || organization.union_member || organization.farmer || organization.truck_driver || organization.unemployed || organization.displaced_worker || organization.job_retraining || organization.healthcare_worker_type) && (
        <Card className="border-purple-200">
          <CardHeader className="bg-purple-50">
            <CardTitle className="text-purple-900">Occupation & Work</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-2">
              {organization.healthcare_worker && <Badge className="bg-purple-100 text-purple-800">Healthcare Worker</Badge>}
              {organization.ems_worker && <Badge className="bg-purple-100 text-purple-800">EMS Worker</Badge>}
              {organization.educator && <Badge className="bg-purple-100 text-purple-800">Educator</Badge>}
              {organization.firefighter && <Badge className="bg-purple-100 text-purple-800">Firefighter</Badge>}
              {organization.law_enforcement && <Badge className="bg-purple-100 text-purple-800">Law Enforcement</Badge>}
              {organization.public_servant && <Badge className="bg-purple-100 text-purple-800">Public Servant</Badge>}
              {organization.clergy && <Badge className="bg-purple-100 text-purple-800">Clergy</Badge>}
              {organization.missionary && <Badge className="bg-purple-100 text-purple-800">Missionary</Badge>}
              {organization.nonprofit_employee && <Badge className="bg-purple-100 text-purple-800">Nonprofit Employee</Badge>}
              {organization.small_business_owner && <Badge className="bg-purple-100 text-purple-800">Small Business Owner</Badge>}
              {organization.minority_owned_business && <Badge className="bg-purple-100 text-purple-800">Minority-Owned Business</Badge>}
              {organization.women_owned_business && <Badge className="bg-purple-100 text-purple-800">Women-Owned Business</Badge>}
              {organization.union_member && <Badge className="bg-purple-100 text-purple-800">Union Member</Badge>}
              {organization.farmer && <Badge className="bg-purple-100 text-purple-800">Farmer</Badge>}
              {organization.truck_driver && <Badge className="bg-purple-100 text-purple-800">Truck Driver</Badge>}
              {organization.unemployed && <Badge className="bg-purple-100 text-purple-800">Unemployed</Badge>}
              {organization.displaced_worker && <Badge className="bg-purple-100 text-purple-800">Displaced Worker</Badge>}
              {organization.job_retraining && <Badge className="bg-purple-100 text-purple-800">Job Retraining</Badge>}
            </div>
            {organization.healthcare_worker_type && (
              <div className="mt-3 pt-3 border-t">
                <div className="text-sm font-medium text-slate-700 mb-1">Healthcare Worker Type</div>
                <div className="text-slate-600">{organization.healthcare_worker_type}</div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Education & Student Status */}
      {(organization.ged_graduate || organization.returning_adult_student || organization.stem_student || organization.recent_graduate || organization.pell_eligible || organization.fafsa_completed || organization.student_with_dependents || organization.homeschool_family || organization.private_school_student || organization.charter_school_student || organization.virtual_academy_student || organization.parent_led_education || organization.homeschool_coop_member || organization.esa_eligible || organization.education_choice_participant) && (
        <Card className="border-yellow-200">
          <CardHeader className="bg-yellow-50">
            <CardTitle className="text-yellow-900">Education & Student Status</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-2">
              {organization.ged_graduate && <Badge className="bg-yellow-100 text-yellow-800">GED Graduate</Badge>}
              {organization.returning_adult_student && <Badge className="bg-yellow-100 text-yellow-800">Returning Adult Student</Badge>}
              {organization.stem_student && <Badge className="bg-yellow-100 text-yellow-800">STEM Student</Badge>}
              {organization.recent_graduate && <Badge className="bg-yellow-100 text-yellow-800">Recent Graduate</Badge>}
              {organization.pell_eligible && <Badge className="bg-yellow-100 text-yellow-800">Pell Eligible</Badge>}
              {organization.fafsa_completed && <Badge className="bg-yellow-100 text-yellow-800">FAFSA Completed</Badge>}
              {organization.student_with_dependents && <Badge className="bg-yellow-100 text-yellow-800">Student with Dependents</Badge>}
              {organization.homeschool_family && <Badge className="bg-yellow-100 text-yellow-800">Homeschool Family</Badge>}
              {organization.private_school_student && <Badge className="bg-yellow-100 text-yellow-800">Private School</Badge>}
              {organization.charter_school_student && <Badge className="bg-yellow-100 text-yellow-800">Charter School</Badge>}
              {organization.virtual_academy_student && <Badge className="bg-yellow-100 text-yellow-800">Virtual Academy</Badge>}
              {organization.parent_led_education && <Badge className="bg-yellow-100 text-yellow-800">Parent-Led Education</Badge>}
              {organization.homeschool_coop_member && <Badge className="bg-yellow-100 text-yellow-800">Homeschool Co-op</Badge>}
              {organization.esa_eligible && <Badge className="bg-yellow-100 text-yellow-800">ESA Eligible</Badge>}
              {organization.education_choice_participant && <Badge className="bg-yellow-100 text-yellow-800">Education Choice Program</Badge>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Financial & Housing Status */}
      {isIndividual && (organization.uninsured || organization.underemployed || organization.medical_debt || organization.education_debt || organization.bankruptcy || organization.first_time_homebuyer) && (
        <Card className="border-orange-200">
          <CardHeader className="bg-orange-50">
            <CardTitle className="text-orange-900">Financial & Housing Status</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-2">
              {organization.uninsured && <Badge className="bg-orange-100 text-orange-800">Uninsured</Badge>}
              {organization.underemployed && <Badge className="bg-orange-100 text-orange-800">Underemployed</Badge>}
              {organization.medical_debt && <Badge className="bg-orange-100 text-orange-800">Medical Debt</Badge>}
              {organization.education_debt && <Badge className="bg-orange-100 text-orange-800">Education Debt</Badge>}
              {organization.bankruptcy && <Badge className="bg-orange-100 text-orange-800">Bankruptcy</Badge>}
              {organization.first_time_homebuyer && <Badge className="bg-orange-100 text-orange-800">First-Time Homebuyer</Badge>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pro Bono Status */}
      {organization.pro_bono && (
        <Card className="border-emerald-200 bg-emerald-50/30">
          <CardHeader className="bg-emerald-50">
            <CardTitle className="text-emerald-900 flex items-center gap-2">
              <Heart className="w-5 h-5" />
              Pro Bono Client
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <p className="text-sm text-emerald-700">
              This client qualifies for pro bono services. All invoices will be generated with 100% discount for tax write-off purposes.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
