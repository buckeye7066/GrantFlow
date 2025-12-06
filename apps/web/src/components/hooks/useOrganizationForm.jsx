import { useState, useEffect, useMemo, useCallback, useReducer } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Form state reducer for complex organization data
 * Provides clearer update patterns and better debugging
 */
function formReducer(state, action) {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    
    case 'SET_FIELDS':
      return { ...state, ...action.fields };
    
    case 'TOGGLE_BOOLEAN':
      return { ...state, [action.field]: !state[action.field] };
    
    case 'SET_ARRAY':
      return { ...state, [action.field]: action.values };
    
    case 'MERGE_AI_DATA':
      // Mark AI-extracted fields for UI highlighting
      const aiFields = Object.keys(action.data);
      return {
        ...state,
        ...action.data,
        _aiExtractedFields: aiFields, // Track which fields were AI-generated
      };
    
    case 'RESET':
      return action.initialState;
    
    default:
      return state;
  }
}

/**
 * Initialize form data from organization and contact methods
 * Memoized to prevent unnecessary recalculations
 */
function initializeFormData(org, contactMethods) {
  const defaultData = {
    profile_image_url: "",
    applicant_type: "organization",
    name: "",
    ein: "",
    nonprofit_type: "",
    student_grade_levels: [],
    gpa: null,
    act_score: null,
    sat_score: null,
    intended_major: "",
    financial_need_level: "",
    assistance_categories: [],
    mission: "",
    keywords: [],
    focus_areas: [],
    primary_goal: "",
    target_population: "",
    geographic_focus: "",
    funding_amount_needed: "",
    timeline: "",
    past_experience: "",
    unique_qualities: "",
    collaboration_partners: "",
    sustainability_plan: "",
    barriers_faced: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    website: "",
    uei: "",
    sam_registered: false,
    faith_based: false,
    rural: false,
    minority_serving: false,
    veteran: false,
    first_generation: false,
    program_areas: [],
    populations_served: [],
    service_geography: [],
    annual_budget: null,
    staff_count: null,
    indirect_rate: null,
    extracurricular_activities: [],
    achievements: [],
    community_service_hours: null,
    special_circumstances: "",
    email: [],
    phone: [],
    date_of_birth: "",
    age: null,
    immigration_status: "",
    household_income: null,
    household_size: null,
    cancer_survivor: false,
    cancer_type: "",
    cancer_diagnosis_year: null,
    permanent_resident: false,
    single_parent: false,
    foster_youth: false,
    homeless: false,
    low_income: false,
    lgbtq: false,
    refugee: false,
    formerly_incarcerated: false,
    caregiver: false,
    orphan: false,
    adopted: false,
    native_american: false,
    military_dependent: false,
    chronic_illness: false,
    tribal_affiliation: "",
    chronic_illness_type: "",
    medicaid_enrolled: false,
    medicare_recipient: false,
    ssi_recipient: false,
    ssdi_recipient: false,
    snap_recipient: false,
    tanf_recipient: false,
    section8_housing: false,
    public_housing_resident: false,
    medicaid_waiver_program: "",
    tenncare_id: "",
    dialysis_patient: false,
    organ_transplant: false,
    hiv_aids: false,
    tbi_survivor: false,
    amputee: false,
    neurodivergent: false,
    visual_impairment: false,
    hearing_impairment: false,
    wheelchair_user: false,
    substance_recovery: false,
    mental_health_condition: false,
    long_covid: false,
    maternal_health: false,
    hospice_care: false,
    african_american: false,
    hispanic_latino: false,
    asian_american: false,
    new_immigrant: false,
    widow_widower: false,
    grandparent_raising_grandchildren: false,
    first_time_parent: false,
    domestic_violence_survivor: false,
    trafficking_survivor: false,
    disaster_survivor: false,
    returning_citizen: false,
    minor_child: false,
    young_adult: false,
    foster_parent: false,
    active_duty_military: false,
    national_guard: false,
    disabled_veteran: false,
    military_spouse: false,
    gold_star_family: false,
    healthcare_worker: false,
    healthcare_worker_type: "",
    ems_worker: false,
    educator: false,
    firefighter: false,
    law_enforcement: false,
    public_servant: false,
    clergy: false,
    missionary: false,
    nonprofit_employee: false,
    small_business_owner: false,
    minority_owned_business: false,
    women_owned_business: false,
    union_member: false,
    farmer: false,
    truck_driver: false,
    unemployed: false,
    displaced_worker: false,
    job_retraining: false,
    ged_graduate: false,
    returning_adult_student: false,
    stem_student: false,
    recent_graduate: false,
    pell_eligible: false,
    fafsa_completed: false,
    student_with_dependents: false,
    homeschool_family: false,
    private_school_student: false,
    charter_school_student: false,
    virtual_academy_student: false,
    parent_led_education: false,
    homeschool_coop_member: false,
    esa_eligible: false,
    education_choice_participant: false,
    current_college: "",
    target_colleges: [],
    uninsured: false,
    underemployed: false,
    medical_debt: false,
    education_debt: false,
    bankruptcy: false,
    first_time_homebuyer: false,
    rural_resident: false,
    appalachian_region: false,
    urban_underserved: false,
    qct: false,
    opportunity_zone: false,
    ej_area: false,
    persistent_poverty_county: false,
    tribal_land: false,
    us_territory: false,
    fema_disaster_area: false,
    business_affected_covid: false,
    fqhc: false,
    community_action_agency: false,
    cdc_org: false,
    housing_authority: false,
    workforce_board: false,
    veterans_service_org: false,
    volunteer_fire_ems: false,
    research_institute: false,
    cooperative: false,
    cdfi_partner: false,
    msi_institution: false,
    rural_health_clinic: false,
    environmental_org: false,
    labor_union_org: false,
    agricultural_extension: false,
    business_8a: false,
    sdvosb: false,
    hubzone: false,
    dbe: false,
    mbe: false,
    wbe: false,
    sbe: false,
    pro_bono: false,
    _aiExtractedFields: [], // Track AI-extracted fields
  };

  const emails = (contactMethods || []).filter(c => c.type === 'email').map(c => c.value);
  const phones = (contactMethods || []).filter(c => c.type === 'phone').map(c => c.value);

  const initialData = { ...defaultData, ...org };

  // Helper to ensure arrays
  const ensureArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
    return [];
  };

  // Handle array fields
  const arrayFields = [
    'keywords', 'focus_areas', 'program_areas', 'populations_served',
    'service_geography', 'extracurricular_activities', 'achievements',
    'assistance_categories', 'student_grade_levels', 'target_colleges'
  ];

  arrayFields.forEach(field => {
    initialData[field] = ensureArray(initialData[field]);
  });

  // Handle deprecated fields
  if (initialData.student_grade_level && initialData.student_grade_levels.length === 0) {
    initialData.student_grade_levels = [initialData.student_grade_level];
  }
  if (initialData.organization_type && !initialData.nonprofit_type) {
    initialData.nonprofit_type = initialData.organization_type;
  }

  // Ensure numeric types
  const numericFields = {
    gpa: 'float',
    act_score: 'int',
    sat_score: 'int',
    annual_budget: 'float',
    staff_count: 'int',
    indirect_rate: 'float',
    community_service_hours: 'int',
    age: 'int',
    household_income: 'float',
    household_size: 'int',
    cancer_diagnosis_year: 'int',
  };

  Object.entries(numericFields).forEach(([field, type]) => {
    const value = initialData[field];
    if (value === null || value === "" || isNaN(parseFloat(value))) {
      initialData[field] = null;
    } else {
      initialData[field] = type === 'int' ? parseInt(value, 10) : parseFloat(value);
    }
  });

  return {
    ...initialData,
    email: emails,
    phone: phones,
    _aiExtractedFields: [],
  };
}

/**
 * Main hook for organization form management
 */
export function useOrganizationForm(organization, onSubmit, onCancel) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Fetch contact methods
  const { data: contactMethods = [], isLoading: isLoadingContacts } = useQuery({
    queryKey: ['contactMethods', organization?.id],
    queryFn: () => organization?.id 
      ? base44.entities.ContactMethod.filter({ organization_id: organization.id }) 
      : [],
    enabled: !!organization,
    initialData: [],
  });

  // Use reducer for better state management
  const initialState = useMemo(
    () => initializeFormData(organization, contactMethods),
    [organization, contactMethods]
  );

  const [formData, dispatch] = useReducer(formReducer, initialState);

  // Reset form when organization changes
  useEffect(() => {
    if (!isLoadingContacts) {
      dispatch({ 
        type: 'RESET', 
        initialState: initializeFormData(organization, contactMethods) 
      });
    }
  }, [organization, contactMethods, isLoadingContacts]);

  // Memoized computed properties
  const profileType = useMemo(() => ({
    isOrganization: formData.applicant_type === 'organization',
    isStudent: ['high_school_student', 'college_student', 'graduate_student'].includes(formData.applicant_type),
    isIndividualAssistance: ['individual_need', 'medical_assistance', 'family'].includes(formData.applicant_type),
    isIndividual: ['high_school_student', 'college_student', 'graduate_student', 'individual_need', 'medical_assistance', 'family', 'other'].includes(formData.applicant_type),
  }), [formData.applicant_type]);

  // Action creators
  const setField = useCallback((field, value) => {
    dispatch({ type: 'SET_FIELD', field, value });
  }, []);

  const setFields = useCallback((fields) => {
    dispatch({ type: 'SET_FIELDS', fields });
  }, []);

  const toggleBoolean = useCallback((field) => {
    dispatch({ type: 'TOGGLE_BOOLEAN', field });
  }, []);

  const setArray = useCallback((field, values) => {
    dispatch({ type: 'SET_ARRAY', field, values });
  }, []);

  // Handle form submission
  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();

    // Clean data for submission
    const cleanedData = { ...formData };

    // Remove metadata fields
    delete cleanedData._aiExtractedFields;
    delete cleanedData.email;
    delete cleanedData.phone;
    delete cleanedData.organization_type;
    delete cleanedData.student_grade_level;

    // Ensure numeric fields are properly typed
    const numericFields = [
      'gpa', 'act_score', 'sat_score', 'community_service_hours',
      'annual_budget', 'staff_count', 'indirect_rate',
      'age', 'household_income', 'household_size', 'cancer_diagnosis_year'
    ];
    
    numericFields.forEach(field => {
      const value = cleanedData[field];
      if (value === null || value === "" || isNaN(parseFloat(value))) {
        cleanedData[field] = null;
      } else {
        const isFloat = ['gpa', 'indirect_rate', 'annual_budget', 'household_income'].includes(field);
        cleanedData[field] = isFloat ? parseFloat(value) : parseInt(value, 10);
      }
    });

    try {
      const savedOrganization = await onSubmit(cleanedData);

      if (!savedOrganization || !savedOrganization.id) {
        throw new Error("Failed to save organization or receive an ID back.");
      }

      const orgId = savedOrganization.id;

      // Handle contact methods separately
      const existingContacts = await base44.entities.ContactMethod.filter({ 
        organization_id: orgId 
      });

      // Delete existing contacts
      if (existingContacts.length > 0) {
        await Promise.all(existingContacts.map(contact => 
          base44.entities.ContactMethod.delete(contact.id)
        ));
      }

      // Create new contacts
      const newEmails = (formData.email || []).map(val => ({ 
        organization_id: orgId, 
        type: 'email', 
        value: val.trim() 
      }));
      const newPhones = (formData.phone || []).map(val => ({ 
        organization_id: orgId, 
        type: 'phone', 
        value: val.trim() 
      }));
      const contactsToCreate = [...newEmails, ...newPhones].filter(c => c.value);

      if (contactsToCreate.length > 0) {
        await base44.entities.ContactMethod.bulkCreate(contactsToCreate);
      }

      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['contactMethods'] });
      queryClient.invalidateQueries({ queryKey: ['contactMethods', orgId] });

      toast({
        title: "Profile Saved!",
        description: "Your profile has been successfully updated.",
      });
      
      onCancel();
    } catch (error) {
      console.error("Error during form submission:", error);
      toast({
        title: "Submission Failed",
        description: error.message || "There was an error saving your profile. Please try again.",
        variant: "destructive",
      });
    }
  }, [formData, onSubmit, onCancel, queryClient, toast]);

  return {
    formData,
    profileType,
    isLoadingContacts,
    
    // Actions
    setField,
    setFields,
    toggleBoolean,
    setArray,
    dispatch,
    handleSubmit,
  };
}

export default useOrganizationForm;