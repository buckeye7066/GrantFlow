import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tags, Target, Briefcase, Heart, Sparkles, Loader2, FileText } from 'lucide-react';
import EditableTagList from '../shared/EditableTagList';
import AIFormField from '../shared/AIFormField';
import { useToast } from '@/components/ui/use-toast';
import { validateFieldBindings } from '../dev/profileFieldValidator';
import { useQuery } from '@tanstack/react-query';

// Extracted section components
import ContactSection from './profile-sections/ContactSection';
import KeywordsSection from './profile-sections/KeywordsSection';
import EducationSection from './profile-sections/EducationSection';
import NarrativeSection from './profile-sections/NarrativeSection';
import CheckboxBadgeSection from './profile-sections/CheckboxBadgeSection';
import DemographicsSection from './profile-sections/DemographicsSection';
import FamilyLifeSection from './profile-sections/FamilyLifeSection';
import FinancialSection from './profile-sections/FinancialSection';
import OccupationSection from './profile-sections/OccupationSection';
import GovernmentAssistanceSection from './profile-sections/GovernmentAssistanceSection';
import HealthDisabilitySection from './profile-sections/HealthDisabilitySection';
import MilitarySection from './profile-sections/MilitarySection';
import ReligiousAffiliationSection from './profile-sections/ReligiousAffiliationSection';
import CulturalHeritageSection from './profile-sections/CulturalHeritageSection';
import OrganizationDetailsSection from './profile-sections/OrganizationDetailsSection';
import MinistrySection from './profile-sections/MinistrySection';
import FirearmsSection from './profile-sections/FirearmsSection';
import PoliticalCivicSection from './profile-sections/PoliticalCivicSection';
import GeographicDesignationsSection from './profile-sections/GeographicDesignationsSection';
import ParseFromDocsButton from '../shared/ParseFromDocsButton';

const SHOW_ALL_SECTIONS = true;

export default function OrganizationProfileDetails({ organization, contactMethods = [], onUpdate, isUpdating, taxonomyItems = [], scrollToSection }) {
  const org = organization || {};
  const [editingSection, setEditingSection] = useState(null);
  const [tempData, setTempData] = useState({});
  const [originalOnEdit, setOriginalOnEdit] = useState(null);
  const [isGeneratingKeywords, setIsGeneratingKeywords] = useState(false);
  const [isGeneratingFocusAreas, setIsGeneratingFocusAreas] = useState(false);
  const [isGeneratingProgramAreas, setIsGeneratingProgramAreas] = useState(false);
  const [isParsingField, setIsParsingField] = useState(null);
  const { toast } = useToast();

  const { data: documents = [] } = useQuery({
    queryKey: ['documents', 'profile-details', org.id],
    queryFn: async () => {
      if (!org.id) {
        console.error('[OrganizationProfileDetails] ❌ NO ORGANIZATION ID - cannot fetch documents');
        return [];
      }
      const docs = await base44.entities.Document.filter({ organization_id: org.id });
      const validDocs = docs.filter(d => d.organization_id === org.id);
      const invalidCount = docs.length - validDocs.length;

      console.log('[OrganizationProfileDetails] DOCUMENT ISOLATION CHECK:', {
        organizationId: org.id,
        organizationName: org.name,
        documentsFound: docs.length,
        validDocuments: validDocs.length,
        invalidDocuments: invalidCount
      });

      if (invalidCount > 0) {
        console.error('[OrganizationProfileDetails] ❌ PHI VIOLATION: Found documents from other profiles!');
      }
      return validDocs;
    },
    enabled: !!org.id,
    staleTime: 0,
  });

  const buildProfileContext = () => {
    const parts = [];
    if (org.name) parts.push(`Name: ${org.name}`);
    if (org.applicant_type) parts.push(`Type: ${org.applicant_type.replace(/_/g, ' ')}`);
    if (org.mission) parts.push(`Mission/Bio: ${org.mission}`);
    if (org.primary_goal) parts.push(`Goals: ${org.primary_goal}`);
    if (org.special_circumstances) parts.push(`Special Circumstances: ${org.special_circumstances}`);
    if (org.barriers_faced) parts.push(`Challenges: ${org.barriers_faced}`);
    if (org.health_conditions?.length) parts.push(`Health Conditions: ${org.health_conditions.join(', ')}`);
    if (org.disabilities?.length) parts.push(`Disabilities: ${org.disabilities.join(', ')}`);
    if (org.chronic_illness_type) parts.push(`Chronic Illness: ${org.chronic_illness_type}`);
    if (org.rare_disease_type) parts.push(`Rare Disease: ${org.rare_disease_type}`);
    if (org.neurodivergent) parts.push('Neurodivergent: Yes');
    if (org.mental_health_condition) parts.push('Mental Health Condition: Yes');
    if (org.cancer_survivor) parts.push(`Cancer Survivor: ${org.cancer_type || 'Yes'}`);
    if (org.veteran) parts.push('Veteran: Yes');
    if (org.disabled_veteran) parts.push('Disabled Veteran: Yes');
    if (org.foster_youth) parts.push('Foster Youth: Yes');
    if (org.single_parent) parts.push('Single Parent: Yes');
    if (org.homeless) parts.push('Homeless: Yes');
    if (org.first_generation) parts.push('First Generation Student: Yes');
    if (org.low_income) parts.push('Low Income: Yes');
    if (org.intended_major) parts.push(`Intended Major: ${org.intended_major}`);
    if (org.current_college) parts.push(`College: ${org.current_college}`);
    if (org.geographic_focus) parts.push(`Geographic Focus: ${org.geographic_focus}`);
    if (org.target_population) parts.push(`Target Population: ${org.target_population}`);
    if (org.state) parts.push(`State: ${org.state}`);
    if (org.city) parts.push(`City: ${org.city}`);
    return parts.join('\n');
  };

  // STRICT PROFILE ISOLATION + robust LLM guard/validation
  const handleParseFromDocuments = async (fieldName, fieldLabel) => {
    if (!org.id) {
      console.error('[OrganizationProfileDetails] ❌ Cannot parse: No organization ID');
      toast({ variant: 'destructive', title: 'Error', description: 'Profile not loaded properly.' });
      return;
    }
    if (!documents.length) {
      toast({ variant: 'destructive', title: 'No Documents', description: 'Upload documents first to parse information.' });
      return;
    }

    setIsParsingField(fieldName);
    try {
      const profileDocs = documents.filter(d => d.organization_id === org.id);
      if (profileDocs.length === 0) {
        toast({ variant: 'destructive', title: 'No Documents', description: 'No documents found for this profile.' });
        return;
      }

      const docContents = profileDocs
        .filter(d => d.harvested_data || d.description)
        .map(d => d.harvested_data || d.description)
        .join('\n\n');

      if (!docContents.trim()) {
        toast({ variant: 'destructive', title: 'No Content', description: 'Documents have not been processed yet. Upload and process documents first.' });
        return;
      }

      const isArrayField = ['keywords', 'focus_areas', 'program_areas'].includes(fieldName);

      const isolationHeader = `SECURITY DIRECTIVE - PHI/HIPAA COMPLIANCE:
- Organization ID: ${org.id}
- Organization Name: ${org.name}
- Extract information ONLY from the documents provided below
- Do NOT use cached data, external knowledge, or information from other profiles
`;

      let extractionPrompt = '';
      if (fieldName === 'keywords') {
        extractionPrompt = isolationHeader + `Extract SPECIFIC keywords and phrases DIRECTLY from the document text below.

CRITICAL RULES:
1. Extract the EXACT words, phrases, products, services, and terms mentioned in the document
2. Include specific items like: equipment names, service types, therapy types, business activities, renovation items, supplies needed
3. DO NOT generate generic keywords - only use words/phrases that appear in or are directly described in the document

DOCUMENT CONTENTS:
${docContents}

Return an array of 10-20 specific keywords/phrases extracted directly from this document.`;
      } else if (fieldName === 'focus_areas') {
        extractionPrompt = isolationHeader + `Extract the SPECIFIC focus areas, interests, and service categories DIRECTLY mentioned in this document.

DOCUMENT CONTENTS:
${docContents}

Return an array of focus areas extracted from the document.`;
      } else if (fieldName === 'program_areas') {
        extractionPrompt = isolationHeader + `Extract the SPECIFIC programs, services, and activities DIRECTLY mentioned in this document.

DOCUMENT CONTENTS:
${docContents}

Return an array of program areas extracted from the document.`;
      } else {
        extractionPrompt = isolationHeader + `Extract ${fieldLabel} from this document. Only include information that is actually in the document.

DOCUMENT CONTENTS (for ${org.name} ONLY):
${docContents}`;
      }

      // Guard integration availability
      const invokeLLM = base44?.integrations?.Core?.InvokeLLM;
      if (!invokeLLM) {
        throw new Error('AI extraction service unavailable. Please try again later.');
      }

      const response = await invokeLLM({
        prompt: extractionPrompt,
        response_json_schema: {
          type: 'object',
          properties: isArrayField
            ? { [fieldName]: { type: 'array', items: { type: 'string' } } }
            : { [fieldName]: { type: 'string' } },
          required: [fieldName],
        },
      });

      // Strict type validation
      const value = response?.[fieldName];
      if (isArrayField) {
        if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string')) {
          handleUpdate({ id: org.id, data: { [fieldName]: value } });
          toast({ title: `✨ Parsed ${fieldLabel}`, description: `Found ${value.length} items from documents.` });
        } else {
          toast({ variant: 'destructive', title: 'No Data Found', description: `Could not find ${fieldLabel.toLowerCase()} in the documents.` });
        }
      } else {
        if (typeof value === 'string' && value.trim()) {
          handleUpdate({ id: org.id, data: { [fieldName]: value.trim() } });
          toast({ title: `✨ Parsed ${fieldLabel}` });
        } else {
          toast({ variant: 'destructive', title: 'No Data Found', description: `Could not find ${fieldLabel.toLowerCase()} in the documents.` });
        }
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Parse Failed', description: error?.message || 'Unknown error' });
    } finally {
      setIsParsingField(null);
    }
  };

  useEffect(() => {
    if (org && org.id) {
      validateFieldBindings('Organization', org);
    }
  }, [org?.id]);

  // Handle scrollToSection - trigger edit mode for the specified section
  useEffect(() => {
    if (!scrollToSection) return;
    
    console.log('[OrganizationProfileDetails] scrollToSection changed to:', scrollToSection);
    
    // Map section names to their startEditing data
    const sectionEditData = {
      'geographic': {
        rural_resident: org.rural_resident || false,
        frontier_county: org.frontier_county || false,
        appalachian_region: org.appalachian_region || false,
        urban_underserved: org.urban_underserved || false,
        qct: org.qct || false,
        opportunity_zone: org.opportunity_zone || false,
        ej_area: org.ej_area || false,
        persistent_poverty_county: org.persistent_poverty_county || false,
        tribal_land: org.tribal_land || false,
        us_territory: org.us_territory || false,
        fema_disaster_area: org.fema_disaster_area || false,
        promise_zone: org.promise_zone || false,
        choice_neighborhood: org.choice_neighborhood || false,
        delta_regional_authority: org.delta_regional_authority || false,
        northern_border_commission: org.northern_border_commission || false,
        denali_commission: org.denali_commission || false,
        colonias: org.colonias || false,
        nmtc_eligible: org.nmtc_eligible || false,
        brownfield_site: org.brownfield_site || false,
        broadband_unserved: org.broadband_unserved || false,
        wui_risk: org.wui_risk || false,
        floodplain: org.floodplain || false,
        mua_status: org.mua_status || false,
        ruca_code: org.ruca_code || '',
        hpsa_score: org.hpsa_score || '',
        crs_score: org.crs_score || '',
        percent_ami: org.percent_ami || '',
        distance_to_services: org.distance_to_services || '',
        broadband_speed: org.broadband_speed || ''
      },
      'narrative': {
        mission: org.mission || '',
        primary_goal: org.primary_goal || '',
        target_population: org.target_population || '',
        geographic_focus: org.geographic_focus || '',
        funding_amount_needed: org.funding_amount_needed || '',
        timeline: org.timeline || '',
        past_experience: org.past_experience || '',
        unique_qualities: org.unique_qualities || '',
        collaboration_partners: org.collaboration_partners || '',
        sustainability_plan: org.sustainability_plan || '',
        barriers_faced: org.barriers_faced || '',
        special_circumstances: org.special_circumstances || ''
      },
      'contact': {
        email: org.email || '',
        phone: org.phone || '',
        website: org.website || '',
        address: org.address || '',
        city: org.city || '',
        state: org.state || '',
        zip: org.zip || ''
      },
      'demographics': {
        date_of_birth: org.date_of_birth || '',
        age: org.age || '',
        race_ethnicity: org.race_ethnicity || [],
        immigration_status: org.immigration_status || ''
      },
      'education': {
        current_college: org.current_college || '',
        intended_major: org.intended_major || '',
        gpa: org.gpa || '',
        sat_score: org.sat_score || '',
        act_score: org.act_score || '',
        first_generation: org.first_generation || false,
        grade_levels: org.grade_levels || [],
        education_types: org.education_types || []
      },
      'health': {
        health_conditions: org.health_conditions || [],
        disabilities: org.disabilities || [],
        rare_disease: org.rare_disease || false,
        rare_disease_type: org.rare_disease_type || ''
      },
      'financial': {
        household_income: org.household_income || '',
        low_income: org.low_income || false,
        financial_challenges: org.financial_challenges || []
      },
      'military': {
        veteran: org.veteran || false,
        active_duty_military: org.active_duty_military || false,
        disabled_veteran: org.disabled_veteran || false,
        military_spouse: org.military_spouse || false,
        military_branch: org.military_branch || ''
      }
    };
    
    if (sectionEditData[scrollToSection]) {
      console.log('[OrganizationProfileDetails] Starting edit mode for section:', scrollToSection);
      startEditing(scrollToSection, sectionEditData[scrollToSection]);
      
      // Also scroll to the section element
      setTimeout(() => {
        const sectionId = `${scrollToSection}-section`;
        const element = document.getElementById(sectionId);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    }
  }, [scrollToSection]);

  // Section editing handlers
  const startEditing = (sectionName, data) => {
    setEditingSection(sectionName);
    setTempData(data);
    setOriginalOnEdit(data);
  };

  const cancelEditing = () => {
    setEditingSection(null);
    setTempData({});
    setOriginalOnEdit(null);
  };

  const handleUpdate = ({ id, data }) => {
    if (onUpdate) {
      onUpdate({ id, data });
    }
    cancelEditing();
  };

  const updateTempData = (field, value) => {
    setTempData(prev => ({ ...prev, [field]: value }));
  };

  // AI suggestion handlers
  const handleSuggestKeywords = async () => {
    const invokeLLM = base44?.integrations?.Core?.InvokeLLM;
    if (!invokeLLM) {
      toast({ variant: 'destructive', title: 'Error', description: 'AI service unavailable.' });
      return;
    }

    setIsGeneratingKeywords(true);
    try {
      const context = buildProfileContext();
      const response = await invokeLLM({
        prompt: `Based on this profile, suggest 10-15 specific search keywords that would help find relevant grants, scholarships, or funding opportunities:\n\n${context}\n\nReturn keywords that are specific to this person/organization's situation, needs, and goals.`,
        response_json_schema: {
          type: 'object',
          properties: {
            keywords: { type: 'array', items: { type: 'string' } }
          },
          required: ['keywords']
        }
      });

      if (response?.keywords?.length) {
        const existing = org.keywords || [];
        const merged = [...new Set([...existing, ...response.keywords])];
        handleUpdate({ id: org.id, data: { keywords: merged } });
        toast({ title: '✨ Keywords Generated', description: `Added ${response.keywords.length} suggested keywords.` });
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to generate keywords.' });
    } finally {
      setIsGeneratingKeywords(false);
    }
  };

  const handleSuggestFocusAreas = async () => {
    const invokeLLM = base44?.integrations?.Core?.InvokeLLM;
    if (!invokeLLM) {
      toast({ variant: 'destructive', title: 'Error', description: 'AI service unavailable.' });
      return;
    }

    setIsGeneratingFocusAreas(true);
    try {
      const context = buildProfileContext();
      const response = await invokeLLM({
        prompt: `Based on this profile, suggest 5-10 focus areas that represent their primary interests and needs:\n\n${context}`,
        response_json_schema: {
          type: 'object',
          properties: {
            focus_areas: { type: 'array', items: { type: 'string' } }
          },
          required: ['focus_areas']
        }
      });

      if (response?.focus_areas?.length) {
        const existing = org.focus_areas || [];
        const merged = [...new Set([...existing, ...response.focus_areas])];
        handleUpdate({ id: org.id, data: { focus_areas: merged } });
        toast({ title: '✨ Focus Areas Generated', description: `Added ${response.focus_areas.length} suggested focus areas.` });
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to generate focus areas.' });
    } finally {
      setIsGeneratingFocusAreas(false);
    }
  };

  const handleSuggestProgramAreas = async () => {
    const invokeLLM = base44?.integrations?.Core?.InvokeLLM;
    if (!invokeLLM) {
      toast({ variant: 'destructive', title: 'Error', description: 'AI service unavailable.' });
      return;
    }

    setIsGeneratingProgramAreas(true);
    try {
      const context = buildProfileContext();
      const response = await invokeLLM({
        prompt: `Based on this profile, suggest 5-10 program areas or service categories that are relevant:\n\n${context}`,
        response_json_schema: {
          type: 'object',
          properties: {
            program_areas: { type: 'array', items: { type: 'string' } }
          },
          required: ['program_areas']
        }
      });

      if (response?.program_areas?.length) {
        const existing = org.program_areas || [];
        const merged = [...new Set([...existing, ...response.program_areas])];
        handleUpdate({ id: org.id, data: { program_areas: merged } });
        toast({ title: '✨ Program Areas Generated', description: `Added ${response.program_areas.length} suggested program areas.` });
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to generate program areas.' });
    } finally {
      setIsGeneratingProgramAreas(false);
    }
  };

  // Determine which sections to show based on applicant type
  const applicantType = org.applicant_type || 'organization';
  const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(applicantType);
  const isIndividual = ['individual_need', 'medical_assistance', 'family', 'homeschool_family'].includes(applicantType);
  const isOrganization = applicantType === 'organization' || (!isStudent && !isIndividual);

  return (
    <div className="space-y-6">
      {/* Contact Information */}
      <ContactSection
        org={org}
        contactMethods={contactMethods}
        isEditing={editingSection === 'contact'}
        tempData={tempData}
        onStartEdit={() => startEditing('contact', {
          email: org.email || '',
          phone: org.phone || '',
          website: org.website || '',
          address: org.address || '',
          city: org.city || '',
          state: org.state || '',
          zip: org.zip || ''
        })}
        onCancel={cancelEditing}
        onSave={() => handleUpdate({ id: org.id, data: tempData })}
        onUpdateTemp={updateTempData}
        isUpdating={isUpdating}
        scrollToSection={scrollToSection}
      />

      {/* Mission / Goals / Narrative */}
      <NarrativeSection
        org={org}
        isEditing={editingSection === 'narrative'}
        tempData={tempData}
        onStartEdit={() => startEditing('narrative', {
          mission: org.mission || '',
          primary_goal: org.primary_goal || '',
          target_population: org.target_population || '',
          geographic_focus: org.geographic_focus || '',
          funding_amount_needed: org.funding_amount_needed || '',
          timeline: org.timeline || '',
          past_experience: org.past_experience || '',
          unique_qualities: org.unique_qualities || '',
          collaboration_partners: org.collaboration_partners || '',
          sustainability_plan: org.sustainability_plan || '',
          barriers_faced: org.barriers_faced || '',
          special_circumstances: org.special_circumstances || ''
        })}
        onCancel={cancelEditing}
        onSave={() => handleUpdate({ id: org.id, data: tempData })}
        onUpdateTemp={updateTempData}
        isUpdating={isUpdating}
        scrollToSection={scrollToSection}
      />

      {/* Keywords Section */}
      <Card id="keywords-section">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Tags className="w-5 h-5 text-blue-600" />
              Keywords
            </CardTitle>
            <div className="flex gap-2">
              <ParseFromDocsButton
                organizationId={org.id}
                sectionName="Keywords"
                fieldsToExtract={[{ field: 'keywords', type: 'array', label: 'Keywords' }]}
                onUpdate={handleUpdate}
                disabled={isUpdating}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleSuggestKeywords}
                disabled={isGeneratingKeywords}
              >
                {isGeneratingKeywords ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4 mr-2" />
                )}
                AI Suggest
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <EditableTagList
            tags={org.keywords || []}
            onUpdate={(keywords) => handleUpdate({ id: org.id, data: { keywords } })}
            placeholder="Add keywords for grant matching..."
          />
        </CardContent>
      </Card>

      {/* Focus Areas Section */}
      <Card id="focus-areas-section">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Target className="w-5 h-5 text-purple-600" />
              Focus Areas
            </CardTitle>
            <div className="flex gap-2">
              <ParseFromDocsButton
                organizationId={org.id}
                sectionName="Focus Areas"
                fieldsToExtract={[{ field: 'focus_areas', type: 'array', label: 'Focus Areas' }]}
                onUpdate={handleUpdate}
                disabled={isUpdating}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleSuggestFocusAreas}
                disabled={isGeneratingFocusAreas}
              >
                {isGeneratingFocusAreas ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4 mr-2" />
                )}
                AI Suggest
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <EditableTagList
            tags={org.focus_areas || []}
            onUpdate={(focus_areas) => handleUpdate({ id: org.id, data: { focus_areas } })}
            placeholder="Add focus areas..."
          />
        </CardContent>
      </Card>

      {/* Program Areas Section */}
      <Card id="program-areas-section">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-green-600" />
              Program Areas
            </CardTitle>
            <div className="flex gap-2">
              <ParseFromDocsButton
                organizationId={org.id}
                sectionName="Program Areas"
                fieldsToExtract={[{ field: 'program_areas', type: 'array', label: 'Program Areas' }]}
                onUpdate={handleUpdate}
                disabled={isUpdating}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleSuggestProgramAreas}
                disabled={isGeneratingProgramAreas}
              >
                {isGeneratingProgramAreas ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4 mr-2" />
                )}
                AI Suggest
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <EditableTagList
            tags={org.program_areas || []}
            onUpdate={(program_areas) => handleUpdate({ id: org.id, data: { program_areas } })}
            placeholder="Add program areas..."
          />
        </CardContent>
      </Card>

      {/* Demographics Section */}
      {(SHOW_ALL_SECTIONS || isStudent || isIndividual) && (
        <DemographicsSection
          organization={org}
          isEditing={editingSection === 'demographics'}
          tempData={tempData}
          onStartEdit={() => startEditing('demographics', {
            african_american: org.african_american || false,
            hispanic_latino: org.hispanic_latino || false,
            asian_american: org.asian_american || false,
            pacific_islander: org.pacific_islander || false,
            native_american: org.native_american || false,
            middle_eastern: org.middle_eastern || false,
            white_caucasian: org.white_caucasian || false,
            multiracial: org.multiracial || false,
            appalachian_white: org.appalachian_white || false,
            jewish_heritage: org.jewish_heritage || false,
            irish_heritage: org.irish_heritage || false,
            italian_heritage: org.italian_heritage || false,
            polish_heritage: org.polish_heritage || false,
            greek_heritage: org.greek_heritage || false,
            armenian_heritage: org.armenian_heritage || false,
            cajun_creole_heritage: org.cajun_creole_heritage || false,
            lgbtq: org.lgbtq || false,
            good_credit_score: org.good_credit_score || false,
            new_immigrant: org.new_immigrant || false,
            lep: org.lep || false,
            minor_child: org.minor_child || false,
            young_adult: org.young_adult || false,
            senior_55_plus: org.senior_55_plus || false,
            senior_62_plus: org.senior_62_plus || false,
            senior_65_plus: org.senior_65_plus || false,
            tribal_affiliation: org.tribal_affiliation || '',
            immigration_status: org.immigration_status || ''
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateField={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Education Section */}
      {(SHOW_ALL_SECTIONS || isStudent) && (
        <EducationSection
          organization={org}
          isEditing={editingSection === 'education'}
          tempData={tempData}
          onStartEdit={() => startEditing('education', {
            current_college: org.current_college || '',
            intended_major: org.intended_major || '',
            gpa: org.gpa || '',
            sat_score: org.sat_score || '',
            act_score: org.act_score || '',
            first_generation: org.first_generation || false,
            grade_levels: org.grade_levels || [],
            education_types: org.education_types || []
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Family Life Section */}
      {(SHOW_ALL_SECTIONS || isIndividual) && (
        <FamilyLifeSection
          organization={org}
          isEditing={editingSection === 'family'}
          tempData={tempData}
          onStartEdit={() => startEditing('family', {
            household_size: org.household_size || '',
            single_parent: org.single_parent || false,
            foster_youth: org.foster_youth || false,
            caregiver: org.caregiver || false
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Financial Section */}
      {(SHOW_ALL_SECTIONS || isIndividual || isStudent) && (
        <FinancialSection
          organization={org}
          isEditing={editingSection === 'financial'}
          tempData={tempData}
          onStartEdit={() => startEditing('financial', {
            household_income: org.household_income || '',
            low_income: org.low_income || false,
            financial_challenges: org.financial_challenges || []
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Occupation Section */}
      {(SHOW_ALL_SECTIONS || isIndividual) && (
        <OccupationSection
          organization={org}
          isEditing={editingSection === 'occupation'}
          tempData={tempData}
          onStartEdit={() => startEditing('occupation', {
            unemployed: org.unemployed || false,
            small_business_owner: org.small_business_owner || false,
            women_owned_business: org.women_owned_business || false
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Government Assistance Section */}
      {(SHOW_ALL_SECTIONS || isIndividual) && (
        <GovernmentAssistanceSection
          organization={org}
          isEditing={editingSection === 'government'}
          tempData={tempData}
          onStartEdit={() => startEditing('government', {
            government_assistance: org.government_assistance || [],
            medicaid_enrolled: org.medicaid_enrolled || false,
            medicare_recipient: org.medicare_recipient || false,
            snap_recipient: org.snap_recipient || false,
            ssi_recipient: org.ssi_recipient || false,
            ssdi_recipient: org.ssdi_recipient || false
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Health & Disability Section */}
      {(SHOW_ALL_SECTIONS || isIndividual) && (
        <HealthDisabilitySection
          organization={org}
          isEditing={editingSection === 'health'}
          tempData={tempData}
          onStartEdit={() => startEditing('health', {
            health_conditions: org.health_conditions || [],
            disabilities: org.disabilities || [],
            rare_disease: org.rare_disease || false,
            rare_disease_type: org.rare_disease_type || ''
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Military Section */}
      {(SHOW_ALL_SECTIONS || isIndividual) && (
        <MilitarySection
          organization={org}
          isEditing={editingSection === 'military'}
          tempData={tempData}
          onStartEdit={() => startEditing('military', {
            veteran: org.veteran || false,
            active_duty_military: org.active_duty_military || false,
            disabled_veteran: org.disabled_veteran || false,
            military_spouse: org.military_spouse || false,
            military_branch: org.military_branch || ''
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Religious Affiliation Section */}
      {SHOW_ALL_SECTIONS && (
        <ReligiousAffiliationSection
          organization={org}
          isEditing={editingSection === 'religious'}
          tempData={tempData}
          onStartEdit={() => startEditing('religious', {
            religious_affiliation_christian: org.religious_affiliation_christian || false,
            religious_affiliation_catholic: org.religious_affiliation_catholic || false,
            religious_affiliation_baptist: org.religious_affiliation_baptist || false,
            religious_affiliation_pentecostal: org.religious_affiliation_pentecostal || false,
            religious_affiliation_methodist: org.religious_affiliation_methodist || false,
            religious_affiliation_lutheran: org.religious_affiliation_lutheran || false,
            religious_affiliation_presbyterian: org.religious_affiliation_presbyterian || false,
            religious_affiliation_nondenominational: org.religious_affiliation_nondenominational || false,
            religious_affiliation_jewish: org.religious_affiliation_jewish || false,
            religious_affiliation_muslim: org.religious_affiliation_muslim || false,
            religious_affiliation_buddhist: org.religious_affiliation_buddhist || false,
            religious_affiliation_hindu: org.religious_affiliation_hindu || false,
            religious_affiliation_sikh: org.religious_affiliation_sikh || false,
            religious_affiliation_other: org.religious_affiliation_other || ''
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Cultural Heritage Section */}
      {SHOW_ALL_SECTIONS && (
        <CulturalHeritageSection
          organization={org}
          isEditing={editingSection === 'cultural'}
          tempData={tempData}
          onStartEdit={() => startEditing('cultural', {
            jewish_heritage: org.jewish_heritage || false,
            irish_heritage: org.irish_heritage || false,
            italian_heritage: org.italian_heritage || false,
            polish_heritage: org.polish_heritage || false,
            greek_heritage: org.greek_heritage || false,
            armenian_heritage: org.armenian_heritage || false,
            cajun_creole_heritage: org.cajun_creole_heritage || false,
            pacific_islander: org.pacific_islander || false,
            middle_eastern: org.middle_eastern || false,
            white_caucasian: org.white_caucasian || false,
            multiracial: org.multiracial || false,
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateField={updateTempData}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Organization Details Section */}
      {(SHOW_ALL_SECTIONS || isOrganization) && (
        <OrganizationDetailsSection
          organization={org}
          taxonomyItems={taxonomyItems}
          isEditing={editingSection === 'org_details'}
          tempData={tempData}
          onStartEdit={() => startEditing('org_details', {
            ein: org.ein || '',
            uei: org.uei || '',
            nonprofit_type: org.nonprofit_type || '',
            annual_budget: org.annual_budget || '',
            staff_count: org.staff_count || ''
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateField={updateTempData}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Ministry Section */}
      {SHOW_ALL_SECTIONS && (
        <MinistrySection
          org={org}
          isEditing={editingSection === 'ministry'}
          tempData={tempData}
          onStartEdit={() => startEditing('ministry', {
            denominational_affiliation: org.denominational_affiliation || '',
            ordained_clergy: org.ordained_clergy || false,
            years_in_ministry: org.years_in_ministry || '',
            active_ministries: org.active_ministries || []
          })}
          onCancel={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Firearms Section */}
      {SHOW_ALL_SECTIONS && (
        <FirearmsSection
          organization={org}
          isEditing={editingSection === 'firearms'}
          tempData={tempData}
          onStartEdit={() => startEditing('firearms', {
            gun_owner: org.gun_owner || false,
            concealed_carry_permit: org.concealed_carry_permit || false,
            nra_member: org.nra_member || false,
            nra_certified_instructor: org.nra_certified_instructor || false,
            firearms_safety_instructor: org.firearms_safety_instructor || false,
            second_amendment_advocate: org.second_amendment_advocate || false,
            firearms_industry: org.firearms_industry || false,
            competitive_shooter: org.competitive_shooter || false,
            hunter: org.hunter || false,
            hunting_license_state: org.hunting_license_state || ''
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateField={updateTempData}
          onUpdateTemp={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Political/Civic Section */}
      {SHOW_ALL_SECTIONS && (
        <PoliticalCivicSection
          org={org}
          isEditing={editingSection === 'political'}
          tempData={tempData}
          onStartEdit={() => startEditing('political', {
            elected_official: org.elected_official || false,
            political_party_affiliation: org.political_party_affiliation || '',
            civic_engagement_level: org.civic_engagement_level || ''
          })}
          onCancel={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateTemp={updateTempData}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}

      {/* Geographic Designations Section */}
      {SHOW_ALL_SECTIONS && (
        <GeographicDesignationsSection
          organization={org}
          isEditing={editingSection === 'geographic'}
          tempData={tempData}
          onStartEdit={() => startEditing('geographic', {
            rural_resident: org.rural_resident || false,
            frontier_county: org.frontier_county || false,
            appalachian_region: org.appalachian_region || false,
            urban_underserved: org.urban_underserved || false,
            qct: org.qct || false,
            opportunity_zone: org.opportunity_zone || false,
            ej_area: org.ej_area || false,
            persistent_poverty_county: org.persistent_poverty_county || false,
            tribal_land: org.tribal_land || false,
            us_territory: org.us_territory || false,
            fema_disaster_area: org.fema_disaster_area || false,
            promise_zone: org.promise_zone || false,
            choice_neighborhood: org.choice_neighborhood || false,
            delta_regional_authority: org.delta_regional_authority || false,
            northern_border_commission: org.northern_border_commission || false,
            denali_commission: org.denali_commission || false,
            colonias: org.colonias || false,
            nmtc_eligible: org.nmtc_eligible || false,
            brownfield_site: org.brownfield_site || false,
            broadband_unserved: org.broadband_unserved || false,
            wui_risk: org.wui_risk || false,
            floodplain: org.floodplain || false,
            mua_status: org.mua_status || false,
            ruca_code: org.ruca_code || '',
            hpsa_score: org.hpsa_score || null,
            crs_score: org.crs_score || null,
            percent_ami: org.percent_ami || null,
            distance_to_services: org.distance_to_services || null,
            broadband_speed: org.broadband_speed || null
          })}
          onCancelEdit={cancelEditing}
          onSave={() => handleUpdate({ id: org.id, data: tempData })}
          onUpdateField={updateTempData}
          onUpdate={handleUpdate}
          isUpdating={isUpdating}
          scrollToSection={scrollToSection}
        />
      )}
    </div>
  );
}