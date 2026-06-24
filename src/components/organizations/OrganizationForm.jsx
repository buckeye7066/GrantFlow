import React, { useState, useEffect } from "react";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { X, Building2, GraduationCap, Heart, Sparkles, ImagePlus, Loader2, Wand2, FileText, DollarSign } from "lucide-react";
import MultiSelectCombobox from "../shared/MultiSelectCombobox";
import AIFormField from "../shared/AIFormField";
import { useToast } from '@/components/ui/use-toast';
import { listBillingTiers } from "@/api/billing";
import FieldHelpTip from "@/components/help/FieldHelpTip";

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

const STUDENT_GRADE_LEVELS = [
  { value: 'high_school_freshman', label: 'High School Freshman' },
  { value: 'high_school_sophomore', label: 'High School Sophomore' },
  { value: 'high_school_junior', label: 'High School Junior' },
  { value: 'high_school_senior', label: 'High School Senior' },
  { value: 'college_freshman', label: 'College Freshman' },
  { value: 'college_sophomore', label: 'College Sophomore' },
  { value: 'college_junior', label: 'College Junior' },
  { value: 'college_senior', label: 'College Senior' },
  { value: 'graduate', label: 'Graduate Student' },
  { value: 'other', label: 'Other' },
];

// Canonical, selectable profile types. `id` is the `applicant_type` value
// persisted on the profile/organization. These map to the 4 billing client
// categories via shared/profileTypeToClientCategory.js: Organization is
// budget-bucketed (Small/Mid/Large), everything else bills as Individual.
const PROFILE_TYPE_CARDS = [
  { id: 'organization',     label: 'Organization',  description: 'Nonprofit, business, or school', icon: Building2 },
  { id: 'student',          label: 'Student',       description: 'High school, college, graduate', icon: GraduationCap },
  { id: 'homeschool_family', label: 'Homeschool',   description: 'Family educating at home',        icon: GraduationCap },
  { id: 'individual_need',  label: 'Individual',    description: 'A single person',                 icon: Heart },
  { id: 'family',           label: 'Family',        description: 'Household with dependents',       icon: Heart },
  { id: 'medical_assistance', label: 'Medical',     description: 'Medical / healthcare assistance', icon: Heart },
  { id: 'other',            label: 'Other',         description: 'None of these fit',               icon: Sparkles },
];

// Canonical applicant_type values that indicate a student.
const STUDENT_APPLICANT_TYPES = ['student', 'high_school_student', 'college_student', 'graduate_student'];

// Map a (possibly legacy) AI-returned applicant_type to the canonical card id.
const normalizeApplicantType = (value) => {
  if (!value || typeof value !== 'string') return value;
  if (STUDENT_APPLICANT_TYPES.includes(value)) return 'student';
  return value;
};

// Safe numeric parsing: returns null when the value is empty/null/undefined or
// not a clean number. `isFloat` controls float vs int parsing.
const toNumberOrNull = (value, isFloat = false) => {
  try {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return isNaN(value) ? null : value;
    const str = String(value).trim();
    if (str === '') return null;
    // Reject strings that aren't a clean number (e.g. '3.8years').
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(str)) return null;
    const parsed = isFloat ? parseFloat(str) : parseInt(str, 10);
    return isNaN(parsed) ? null : parsed;
  } catch (err) {
    // Defensive: never throw out of numeric parsing; log and fall back to null.
    console.error('toNumberOrNull failed for value:', value, err);
    return null;
  }
};

// Normalize/validate a website value. Returns a normalized URL string when the
// value can be made into a valid http(s) URL, or null when it is empty/invalid.
const normalizeWebsite = (value) => {
  if (!value || typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate === '') return null;

  // If no scheme is present, default to https://
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = 'https://' + candidate.replace(/^\/+/, '');
  }

  try {
    const url = new URL(candidate);
    // Only allow http/https schemes.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Reject scheme-only or missing host (e.g. 'http://').
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const initializeFormData = (org, contactMethods) => {
  const defaultData = {
    profile_image_url: "",
    applicant_type: "organization",
    name: "",
    organization_type: "", // This field corresponds to 'nonprofit_type' in the outline's formData.
    ein: "",
    nonprofit_type: "", // Keeping this as well, mapping org_type to this for consistency with outline
    org_subtype: "", // Organization sub-type: nonprofit | business | school (drives billing client category)
    student_grade_levels: [],
    student_grade_level: "", // Old single select, now should be array
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
    // New individual assistance fields
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
    refugee: false, // This is distinct from immigration_status refugee for UI checkbox
    formerly_incarcerated: false,
    caregiver: false,
    orphan: false,
    adopted: false,
    native_american: false,
    military_dependent: false,
    chronic_illness: false,
    tribal_affiliation: "",
    chronic_illness_type: "",
    // Government Assistance Programs
    medicaid_enrolled: false,
    medicare_recipient: false,
    ssi_recipient: false,
    ssdi_recipient: false,
    snap_recipient: false,
    tanf_recipient: false,
    section8_housing: false,
    public_housing_resident: false, // New field
    medicaid_waiver_program: "",
    tenncare_id: "",
    // Health & Medical Conditions
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
    long_covid: false, // New field
    maternal_health: false, // New field
    hospice_care: false, // New field
    // Demographics & Background
    african_american: false,
    hispanic_latino: false,
    asian_american: false,
    new_immigrant: false, // New field
    // Family & Life Situation
    widow_widower: false,
    grandparent_raising_grandchildren: false,
    first_time_parent: false,
    domestic_violence_survivor: false,
    trafficking_survivor: false,
    disaster_survivor: false,
    returning_citizen: false, // New field
    minor_child: false, // New field
    young_adult: false, // New field
    foster_parent: false, // New field
    // Military Status
    active_duty_military: false,
    national_guard: false,
    disabled_veteran: false,
    military_spouse: false,
    gold_star_family: false,
    // Occupation & Work
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
    // New Student-specific fields
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
    current_college: "", // NEW
    target_colleges: [], // NEW
    // New Financial & Housing Status
    uninsured: false,
    underemployed: false,
    medical_debt: false,
    education_debt: false,
    bankruptcy: false,
    first_time_homebuyer: false,
    // New Geographic & Economic Factors
    rural_resident: false,
    appalachian_region: false,
    urban_underserved: false,
    qct: false, // Qualified Census Tract
    opportunity_zone: false,
    ej_area: false, // Environmental Justice Area
    persistent_poverty_county: false,
    tribal_land: false,
    us_territory: false,
    fema_disaster_area: false,
    // New Special Organization Classifications
    business_affected_covid: false,
    fqhc: false, // Federally Qualified Health Center
    community_action_agency: false,
    cdc_org: false, // Community Development Corporation
    housing_authority: false,
    workforce_board: false,
    veterans_service_org: false,
    volunteer_fire_ems: false,
    research_institute: false,
    cooperative: false,
    cdfi_partner: false, // Community Development Financial Institution
    msi_institution: false, // Minority Serving Institution
    rural_health_clinic: false,
    environmental_org: false,
    labor_union_org: false,
    agricultural_extension: false,
    business_8a: false, // 8(a) Business Development Program
    sdvosb: false, // Service-Disabled Veteran-Owned Small Business
    hubzone: false, // Historically Underutilized Business Zone
    dbe: false, // Disadvantaged Business Enterprise
    mbe: false, // Minority Business Enterprise
    wbe: false, // Women Business Enterprise
    sbe: false, // Small Business Enterprise
    // New Pro Bono field
    pro_bono: false,
    // Billing and discount fields
    tier_id: null,
    custom_monthly_cents: null,
    discount_type: "none",
    discount_percent: 0,
  };

  const emails = (contactMethods || []).filter(c => c.type === 'email').map(c => c.value);
  const phones = (contactMethods || []).filter(c => c.type === 'phone').map(c => c.value);

  // Spread org last so any extra/unanticipated fields from org are preserved.
  const initialData = { ...defaultData, ...(org || {}) };

  // Helper to safely produce a FRESH array copy from a value that may be an
  // array (aliased from org), a comma-separated string, or empty. Always
  // returns a brand-new array so we never mutate the caller-owned org object.
  const toFreshArray = (value) => {
    if (Array.isArray(value)) return [...value];
    if (typeof value === 'string' && value.trim()) {
      return value.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
  };

  // Handle fields that might come as comma-separated strings or need array conversion.
  // Each is a fresh copy to avoid mutating org-owned arrays.
  initialData.keywords = toFreshArray(initialData.keywords);
  initialData.focus_areas = toFreshArray(initialData.focus_areas);
  initialData.program_areas = toFreshArray(initialData.program_areas);
  initialData.populations_served = toFreshArray(initialData.populations_served);
  initialData.service_geography = toFreshArray(initialData.service_geography);
  initialData.extracurricular_activities = toFreshArray(initialData.extracurricular_activities);
  initialData.achievements = toFreshArray(initialData.achievements);
  initialData.assistance_categories = toFreshArray(initialData.assistance_categories);
  initialData.student_grade_levels = toFreshArray(initialData.student_grade_levels);
  initialData.target_colleges = toFreshArray(initialData.target_colleges); // NEW

  // Normalize applicant_type to the canonical card vocabulary (e.g. legacy
  // 'high_school_student' -> 'student'), so the card UI and isStudent share one set.
  if (initialData.applicant_type) {
    initialData.applicant_type = normalizeApplicantType(initialData.applicant_type);
  }

  // Convert old single student_grade_level to array if new array is empty.
  // student_grade_levels is now a fresh array, so push is safe.
  if (typeof initialData.student_grade_level === 'string' && initialData.student_grade_level.trim() && initialData.student_grade_levels.length === 0) {
    initialData.student_grade_levels.push(initialData.student_grade_level.trim());
  }
  delete initialData.student_grade_level; // Remove old single field

  // Convert old single assistance_category to array if new array is empty.
  // assistance_categories is now a fresh array, so push is safe.
  if (typeof initialData.assistance_category === 'string' && initialData.assistance_category.trim() && initialData.assistance_categories.length === 0) {
      initialData.assistance_categories.push(initialData.assistance_category.trim());
  }
  delete initialData.assistance_category; // Remove old field

  // Map organization_type to nonprofit_type for consistency with outline's formData
  if (initialData.organization_type) {
    // Always prefer the more specific nonprofit_type if both exist; otherwise use organization_type
    if (!initialData.nonprofit_type) {
      initialData.nonprofit_type = initialData.organization_type;
    }
  }
  delete initialData.organization_type; // Remove old field after migration

  // Seed the Organization sub-type selector from the persisted nonprofit_type
  // when it is one of the canonical billing sub-types, so editing shows it.
  if (!initialData.org_subtype && ['nonprofit', 'business', 'school'].includes(initialData.nonprofit_type)) {
    initialData.org_subtype = initialData.nonprofit_type;
  }

  // Defensively coerce any numeric-like fields. Start with the explicitly known
  // numeric fields, then also coerce any extra (unanticipated) org field whose
  // name ends with a common numeric suffix so legacy numeric columns don't pass
  // through as raw strings.
  const KNOWN_FLOAT_FIELDS = ['gpa', 'annual_budget', 'indirect_rate', 'household_income'];
  const KNOWN_INT_FIELDS = ['act_score', 'sat_score', 'staff_count', 'community_service_hours', 'age', 'household_size', 'cancer_diagnosis_year'];

  KNOWN_FLOAT_FIELDS.forEach((f) => { initialData[f] = toNumberOrNull(initialData[f], true); });
  KNOWN_INT_FIELDS.forEach((f) => { initialData[f] = toNumberOrNull(initialData[f], false); });

  return {
    ...initialData,
    email: emails,
    phone: phones,
  };
};

export default function OrganizationForm({ organization, onSubmit, onCancel, onSuccess, isSubmitting }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);
  const [aiInputText, setAiInputText] = useState("");
  const [isHarvesting, setIsHarvesting] = useState(false);

  const { data: contactMethods = [], isLoading: isLoadingContacts } = useQuery({
    queryKey: ['contactMethods', organization?.id],
    queryFn: () => organization?.id ? client.entities.ContactMethod.filter({ organization_id: organization.id }) : [],
    // Align enabled with the queryFn guard so we only fetch for persisted orgs.
    enabled: !!organization?.id,
    initialData: [], // Provide initialData to avoid undefined before fetch
  });

  // Initialize formData using a function for lazy state initialization
  const [formData, setFormData] = useState(() => initializeFormData(organization, contactMethods));

  // Update formData when organization or contactMethods change
  const prevOrgIdRef = React.useRef(organization?.id);
  const prevLoadingRef = React.useRef(isLoadingContacts);
  // Track whether contacts have been applied for the current org id, so cached
  // (already-loaded) contacts get applied on first non-empty availability even
  // when justFinishedLoading never fires.
  const contactsAppliedForOrgRef = React.useRef(null);

  useEffect(() => {
    const orgChanged = organization?.id !== prevOrgIdRef.current;
    const justFinishedLoading = prevLoadingRef.current === true && isLoadingContacts === false;
    prevOrgIdRef.current = organization?.id;
    prevLoadingRef.current = isLoadingContacts;

    if (orgChanged) {
      // New org identity -> reset application tracking.
      contactsAppliedForOrgRef.current = null;
    }

    // First non-empty availability of contacts for this org that hasn't been applied yet.
    const contactsBecameAvailable =
      !isLoadingContacts &&
      Array.isArray(contactMethods) &&
      contactMethods.length > 0 &&
      contactsAppliedForOrgRef.current !== organization?.id;

    // Only reset the entire form when the org identity changes, contacts finish
    // loading for the first time, or cached contacts become available without a
    // loading transition. Do NOT reset on every contactMethods reference change
    // to avoid overwriting in-progress edits.
    if ((orgChanged || justFinishedLoading || contactsBecameAvailable) && !isLoadingContacts) {
      setFormData(initializeFormData(organization, contactMethods));
      if (Array.isArray(contactMethods) && contactMethods.length > 0) {
        contactsAppliedForOrgRef.current = organization?.id;
      }
    }
  }, [organization, contactMethods, isLoadingContacts]);

  const { data: taxonomyItems = [] } = useQuery({
    queryKey: ['taxonomy'],
    queryFn: () => client.entities.Taxonomy.filter({ active: true }),
    staleTime: 5 * 60 * 1000, // taxonomy rarely changes; avoid redundant refetches
  });

  const { data: billingTiers = [], isLoading: isLoadingTiers } = useQuery({
    queryKey: ['billingTiers'],
    queryFn: listBillingTiers,
    staleTime: 5 * 60 * 1000, // billing tiers rarely change; avoid redundant refetches
  });

  const assistanceOptions = taxonomyItems
    .filter(item => item.group === 'individual_assistance')
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map(item => ({ value: item.slug, label: item.label }));

  const orgTypeOptions = taxonomyItems
    .filter(item => item.group === 'organization_type')
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map(item => ({ value: item.slug, label: item.label }));

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    const finalValue = type === 'checkbox' ? checked : value;

    setFormData(prev => ({
      ...prev,
      [name]: finalValue
    }));
  };

  // Normalize the website on blur so typing/editing mid-string isn't mangled.
  // Validate full URL shape and flag invalid input rather than only prepending.
  const handleWebsiteBlur = (e) => {
    const value = e.target.value;
    if (!value || !value.trim()) return;
    const normalized = normalizeWebsite(value);
    if (normalized) {
      if (normalized !== value) {
        setFormData(prev => ({ ...prev, website: normalized }));
      }
    } else {
      toast({
        title: "Invalid Website",
        description: "Please enter a valid website URL (e.g. https://www.example.com).",
        variant: "destructive",
      });
    }
  };

  const handleSelectChange = (name, value) => {
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleArrayChange = (name, values) => {
    setFormData(prev => ({ ...prev, [name]: values }));
  };

  const handleImageUpload = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // Validate file type — only accept image uploads.
      // image/jpg is not a real MIME type (browsers emit image/jpeg).
      const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      // Explicitly reject empty/unknown file.type rather than letting it through.
      if (!file.type || !file.type.startsWith('image/') || !allowedTypes.includes(file.type.toLowerCase())) {
          toast({
              title: "Invalid File Type",
              description: "Please upload an image file (PNG, JPG, GIF, or WebP).",
              variant: "destructive",
          });
          e.target.value = "";
          return;
      }

      setIsUploading(true);
      try {
          const result = await client.integrations.Core.UploadFile({ file });
          // Validate the upload response shape before using it.
          if (!result || typeof result !== 'object' || typeof result.file_url !== 'string' || !result.file_url) {
              throw new Error("Upload did not return a valid file URL.");
          }
          const file_url = result.file_url;
          setFormData(prev => ({ ...prev, profile_image_url: file_url }));
      } catch (error) {
          console.error("Image upload failed:", error);
          toast({
              title: "Image Upload Failed",
              description: (error && error.message) ? error.message : "There was an error uploading your image. Please try again.",
              variant: "destructive",
          });
      } finally {
          setIsUploading(false);
      }
  };

  const handleAIHarvest = async () => {
    if (!aiInputText.trim()) {
      toast({
        title: "No Text Provided",
        description: "Please enter information about the profile first.",
        variant: "destructive",
      });
      return;
    }

    setIsHarvesting(true);
    try {
      const prompt = `Extract structured profile information from the following text. Return a JSON object with any fields you can identify.

TEXT:
${aiInputText}

Extract the following fields if present:
- name: Full name of person or organization
- applicant_type: Determine if this is "organization", "high_school_student", "college_student", "graduate_student", "individual_need", "medical_assistance", "family", or "other"
- mission: Mission statement or personal bio
- ein: EIN/Tax ID if mentioned
- nonprofit_type: Type of nonprofit (501c3, etc.)
- gpa: GPA if mentioned (number)
- act_score: ACT score if mentioned (number)
- sat_score: SAT score if mentioned (number)
- intended_major: Field of study
- financial_need_level: "low", "moderate", "high", or "critical"
- assistance_categories: Array of assistance types needed
- primary_goal: Main goals
- target_population: Who they serve or unique identity
- geographic_focus: Location/geography
- funding_amount_needed: Funding needs
- timeline: When funding needed
- past_experience: Past achievements/experience
- unique_qualities: What makes them unique
- collaboration_partners: Partners/supporters
- sustainability_plan: Future plans
- barriers_faced: Challenges/barriers
- address: Street address
- city: City
- state: State (2-letter code)
- zip: ZIP code
- website: Website URL
- email: Array of email addresses
- phone: Array of phone numbers
- keywords: Array of relevant keywords
- focus_areas: Array of focus areas
- annual_budget: Budget amount (number)
- staff_count: Number of staff (number)
- community_service_hours: Service hours (number)
- special_circumstances: Special circumstances
- extracurricular_activities: Array of activities
- achievements: Array of achievements
- student_grade_levels: Array of grade levels
- current_college: Current college or university name
- target_colleges: Array of colleges the student is interested in or applying to
- date_of_birth: Date of birth (YYYY-MM-DD)
- age: Age (number)
- immigration_status: Immigration status
- household_income: Annual household income (number)
- household_size: Household size (number)
- cancer_survivor: Is the individual a cancer survivor? (boolean)
- cancer_type: Type of cancer
- cancer_diagnosis_year: Year of cancer diagnosis (number)
- permanent_resident: Is the individual a Green Card Holder? (boolean)
- single_parent: Is the individual a single parent? (boolean)
- foster_youth: Is the individual foster youth? (boolean)
- homeless: Is the individual homeless or housing insecure? (boolean)
- low_income: Is the individual low income? (boolean)
- lgbtq: Is the individual LGBTQ+? (boolean)
- refugee: Is the individual a refugee/asylum seeker? (boolean)
- formerly_incarcerated: Is the individual formerly incarcerated? (boolean)
- caregiver: Is the individual a family caregiver? (boolean)
- orphan: Is the individual an orphan? (boolean)
- adopted: Is the individual adopted? (boolean)
- native_american: Is the individual Native American? (boolean)
- military_dependent: Is the individual a military dependent? (boolean)
- chronic_illness: Is the individual a chronic illness? (boolean)
- tribal_affiliation: Tribal affiliation (if Native American)
- chronic_illness_type: Type of chronic illness
- medicaid_enrolled: Is the individual enrolled in Medicaid? (boolean)
- medicare_recipient: Is the individual a Medicare recipient? (boolean)
- ssi_recipient: Is the individual an SSI (Supplemental Security Income) recipient? (boolean)
- ssdi_recipient: Is the individual an SSDI (Social Security Disability) recipient? (boolean)
- snap_recipient: Is the individual a SNAP (Food Stamps) recipient? (boolean)
- tanf_recipient: Is the individual a TANF (Temporary Assistance) recipient? (boolean)
- section8_housing: Does the individual receive Section 8 Housing assistance? (boolean)
- public_housing_resident: Is the individual a Public Housing Resident? (boolean)
- medicaid_waiver_program: Medicaid waiver program (e.g., ECF CHOICES, Katie Beckett, Self-Determination, Family Support, Other)
- tenncare_id: TennCare ID number (if applicable)
- dialysis_patient: Is the individual a dialysis patient? (boolean)
- organ_transplant: Is the individual an organ transplant recipient? (boolean)
- hiv_aids: Does the individual have HIV/AIDS? (boolean)
- tbi_survivor: Is the individual a Traumatic Brain Injury (TBI) survivor? (boolean)
- amputee: Is the individual an amputee? (boolean)
- neurodivergent: Is the individual neurodivergent (Autism, ADHD, etc.)? (boolean)
- visual_impairment: Does the individual have a visual impairment? (boolean)
- hearing_impairment: Does the individual have a hearing impairment? (boolean)
- wheelchair_user: Is the individual a wheelchair user? (boolean)
- substance_recovery: Is the individual a substance recovery participant? (boolean)
- mental_health_condition: Does the individual have a mental health condition? (boolean)
- long_covid: Does the individual suffer from Long COVID? (boolean)
- maternal_health: Is the individual experiencing maternal health issues? (boolean)
- hospice_care: Is the individual receiving hospice care? (boolean)
- african_american: Is the individual African American / Black? (boolean)
- hispanic_latino: Is the individual Hispanic / Latino? (boolean)
- asian_american: Is the individual Asian American? (boolean)
- new_immigrant: Is the individual a New Immigrant (within the last 5 years)? (boolean)
- widow_widower: Is the individual a widow/widower? (boolean)
- grandparent_raising_grandchildren: Is the individual a grandparent raising grandchildren? (boolean)
- first_time_parent: Is the individual a first-time parent? (boolean)
- domestic_violence_survivor: Is the individual a domestic violence survivor? (boolean)
- trafficking_survivor: Is the individual a human trafficking survivor? (boolean)
- disaster_survivor: Is the individual a disaster survivor? (boolean)
- returning_citizen: Is the individual a returning citizen (formerly incarcerated)? (boolean)
- minor_child: Is the individual a minor child (under 18)? (boolean)
- young_adult: Is the individual a young adult (18-24)? (boolean)
- foster_parent: Is the individual a foster parent? (boolean)
- active_duty_military: Is the individual active duty military? (boolean)
- national_guard: Is the individual National Guard / Reserve? (boolean)
- disabled_veteran: Is the individual a disabled veteran? (boolean)
- military_spouse: Is the individual a military spouse? (boolean)
- gold_star_family: Is the individual a Gold Star family member? (boolean)
- healthcare_worker: Is the individual a healthcare worker? (boolean)
- healthcare_worker_type: Type of healthcare worker (e.g., Nurse, Doctor, Medical Assistant)
- ems_worker: Is the individual an EMS worker / first responder? (boolean)
- educator: Is the individual a teacher / educator? (boolean)
- firefighter: Is the individual a firefighter? (boolean)
- law_enforcement: Is the individual a law enforcement officer? (boolean)
- public_servant: Is the individual a public servant / government employee? (boolean)
- clergy: Is the individual clergy / minister / religious worker? (boolean)
- missionary: Is the individual a missionary / evangelist? (boolean)
- nonprofit_employee: Is the individual a nonprofit employee? (boolean)
- small_business_owner: Is the individual a small business owner? (boolean)
- minority_owned_business: Is the individual minority-owned business? (boolean)
- women_owned_business: Is the individual women-owned business? (boolean)
- union_member: Is the individual a union member? (boolean)
- farmer: Is the individual a farmer / agricultural worker? (boolean)
- truck_driver: Is the individual a truck driver / transportation worker? (boolean)
- unemployed: Is the individual currently unemployed? (boolean)
- displaced_worker: Is the individual a displaced worker? (boolean)
- job_retraining: Is the individual a job retraining participant? (boolean)
- ged_graduate: Is the individual a GED graduate? (boolean)
- returning_adult_student: Is the individual a returning adult student? (boolean)
- stem_student: Is the individual a STEM student? (boolean)
- recent_graduate: Is the individual a recent graduate? (boolean)
- pell_eligible: Is the individual Pell Grant eligible? (boolean)
- fafsa_completed: Has the individual completed FAFSA? (boolean)
- student_with_dependents: Is the individual a student with dependents? (boolean)
- homeschool_family: Is the individual part of a homeschool family? (boolean)
- private_school_student: Is the individual a private school student? (boolean)
- charter_school_student: Is the individual a charter school student? (boolean)
- virtual_academy_student: Is the individual a virtual academy student? (boolean)
- parent_led_education: Is the individual involved in parent-led education? (boolean)
- homeschool_coop_member: Is the individual a homeschool cooperative member? (boolean)
- esa_eligible: Is the individual ESA (Education Savings Account) eligible? (boolean)
- education_choice_participant: Is the individual an education choice program participant? (boolean)
- uninsured: Is the individual uninsured? (boolean)
- underemployed: Is the individual underemployed? (boolean)
- medical_debt: Does the individual have medical debt? (boolean)
- education_debt: Does the individual have education debt? (boolean)
- bankruptcy: Has the individual filed for bankruptcy? (boolean)
- first_time_homebuyer: Is the individual a first-time homebuyer? (boolean)
- rural_resident: Is the individual a rural resident? (boolean)
- appalachian_region: Does the individual reside in the Appalachian Region? (boolean)
- urban_underserved: Does the individual reside in an urban underserved area? (boolean)
- qct: Is the organization/individual located in a Qualified Census Tract (QCT)? (boolean)
- opportunity_zone: Is the organization/individual located in an Opportunity Zone? (boolean)
- ej_area: Is the organization/individual located in an Environmental Justice Area (EJ Area)? (boolean)
- persistent_poverty_county: Is the organization/individual located in a Persistent Poverty County? (boolean)
- tribal_land: Is the organization/individual located on Tribal Land? (boolean)
- us_territory: Is the organization/individual located in a U.S. Territory? (boolean)
- fema_disaster_area: Is the organization/individual located in a FEMA Disaster Area? (boolean)
- business_affected_covid: Was the business affected by COVID-19? (boolean)
- fqhc: Is the organization a Federally Qualified Health Center (FQHC)? (boolean)
- community_action_agency: Is the organization a Community Action Agency? (boolean)
- cdc_org: Is the organization a Community Development Corporation (CDC)? (boolean)
- housing_authority: Is the organization a Housing Authority? (boolean)
- workforce_board: Is the organization a Workforce Development Board? (boolean)
- veterans_service_org: Is the organization a Veterans Service Organization? (boolean)
- volunteer_fire_ems: Is the organization a Volunteer Fire/EMS Department? (boolean)
- research_institute: Is the organization a Research Institute? (boolean)
- cooperative: Is the organization a Cooperative? (boolean)
- cdfi_partner: Is the organization a Community Development Financial Institution (CDFI) Partner? (boolean)
- msi_institution: Is the organization a Minority Serving Institution (MSI)? (boolean)
- rural_health_clinic: Is the organization a Rural Health Clinic? (boolean)
- environmental_org: Is the organization an Environmental Organization? (boolean)
- labor_union_org: Is the organization an Labor Union Organization? (boolean)
- agricultural_extension: Is the organization an Agricultural Extension? (boolean)
- business_8a: Is the organization certified 8(a) Business Development Program? (boolean)
- sdvosb: Is the organization a Service-Disabled Veteran-Owned Small Business (SDVOSB)? (boolean)
- hubzone: Is the organization a Historically Underutilized Business Zone (HUBZone) business? (boolean)
- dbe: Is the organization a Disadvantaged Business Enterprise (DBE)? (boolean)
- mbe: Is the organization a Minority Business Enterprise (MBE)? (boolean)
- wbe: Is the organization a Women Business Enterprise (WBE)? (boolean)
- sbe: Is the organization a Small Business Enterprise (SBE)? (boolean)
- pro_bono: Is this a pro bono client? (boolean)

Return ONLY valid JSON. Do not include fields that aren't present in the text.`;

      const response = await client.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            applicant_type: { type: "string" },
            mission: { type: "string" },
            ein: { type: "string" },
            nonprofit_type: { type: "string" },
            gpa: { type: "number" },
            act_score: { type: "number" },
            sat_score: { type: "number" },
            intended_major: { type: "string" },
            financial_need_level: { type: "string" },
            assistance_categories: { type: "array", items: { type: "string" } },
            primary_goal: { type: "string" },
            target_population: { type: "string" },
            geographic_focus: { type: "string" },
            funding_amount_needed: { type: "string" },
            timeline: { type: "string" },
            past_experience: { type: "string" },
            unique_qualities: { type: "string" },
            collaboration_partners: { type: "string" },
            sustainability_plan: { type: "string" },
            barriers_faced: { type: "string" },
            address: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" },
            website: { type: "string" },
            email: { type: "array", items: { type: "string" } },
            phone: { type: "array", items: { type: "string" } },
            keywords: { type: "array", items: { type: "string" } },
            focus_areas: { type: "array", items: { type: "string" } },
            annual_budget: { type: "number" },
            staff_count: { type: "number" },
            community_service_hours: { type: "number" },
            special_circumstances: { type: "string" },
            extracurricular_activities: { type: "array", items: { type: "string" } },
            achievements: { type: "array", items: { type: "string" } },
            student_grade_levels: { type: "array", items: { type: "string" } },
            current_college: { type: "string" },
            target_colleges: { type: "array", items: { type: "string" } },
            date_of_birth: { type: "string", format: "date" },
            age: { type: "number" },
            immigration_status: { type: "string" },
            household_income: { type: "number" },
            household_size: { type: "number" },
            cancer_survivor: { type: "boolean" },
            cancer_type: { type: "string" },
            cancer_diagnosis_year: { type: "number" },
            permanent_resident: { type: "boolean" },
            single_parent: { type: "boolean" },
            foster_youth: { type: "boolean" },
            homeless: { type: "boolean" },
            low_income: { type: "boolean" },
            lgbtq: { type: "boolean" },
            refugee: { type: "boolean" },
            formerly_incarcerated: { type: "boolean" },
            caregiver: { type: "boolean" },
            orphan: { type: "boolean" },
            adopted: { type: "boolean" },
            native_american: { type: "boolean" },
            military_dependent: { type: "boolean" },
            chronic_illness: { type: "boolean" },
            tribal_affiliation: { type: "string" },
            chronic_illness_type: { type: "string" },
            medicaid_enrolled: { type: "boolean" },
            medicare_recipient: { type: "boolean" },
            ssi_recipient: { type: "boolean" },
            ssdi_recipient: { type: "boolean" },
            snap_recipient: { type: "boolean" },
            tanf_recipient: { type: "boolean" },
            section8_housing: { type: "boolean" },
            public_housing_resident: { type: "boolean" },
            medicaid_waiver_program: { type: "string" },
            tenncare_id: { type: "string" },
            dialysis_patient: { type: "boolean" },
            organ_transplant: { type: "boolean" },
            hiv_aids: { type: "boolean" },
            tbi_survivor: { type: "boolean" },
            amputee: { type: "boolean" },
            neurodivergent: { type: "boolean" },
            visual_impairment: { type: "boolean" },
            hearing_impairment: { type: "boolean" },
            wheelchair_user: { type: "boolean" },
            substance_recovery: { type: "boolean" },
            mental_health_condition: { type: "boolean" },
            long_covid: { type: "boolean" },
            maternal_health: { type: "boolean" },
            hospice_care: { type: "boolean" },
            african_american: { type: "boolean" },
            hispanic_latino: { type: "boolean" },
            asian_american: { type: "boolean" },
            new_immigrant: { type: "boolean" },
            widow_widower: { type: "boolean" },
            grandparent_raising_grandchildren: { type: "boolean" },
            first_time_parent: { type: "boolean" },
            domestic_violence_survivor: { type: "boolean" },
            trafficking_survivor: { type: "boolean" },
            disaster_survivor: { type: "boolean" },
            returning_citizen: { type: "boolean" },
            minor_child: { type: "boolean" },
            young_adult: { type: "boolean" },
            foster_parent: { type: "boolean" },
            active_duty_military: { type: "boolean" },
            national_guard: { type: "boolean" },
            disabled_veteran: { type: "boolean" },
            military_spouse: { type: "boolean" },
            gold_star_family: { type: "boolean" },
            healthcare_worker: { type: "boolean" },
            healthcare_worker_type: { type: "string" },
            ems_worker: { type: "boolean" },
            educator: { type: "boolean" },
            firefighter: { type: "boolean" },
            law_enforcement: { type: "boolean" },
            public_servant: { type: "boolean" },
            clergy: { type: "boolean" },
            missionary: { type: "boolean" },
            nonprofit_employee: { type: "boolean" },
            small_business_owner: { type: "boolean" },
            minority_owned_business: { type: "boolean" },
            women_owned_business: { type: "boolean" },
            union_member: { type: "boolean" },
            farmer: { type: "boolean" },
            truck_driver: { type: "boolean" },
            unemployed: { type: "boolean" },
            displaced_worker: { type: "boolean" },
            job_retraining: { type: "boolean" },
            ged_graduate: { type: "boolean" },
            returning_adult_student: { type: "boolean" },
            stem_student: { type: "boolean" },
            recent_graduate: { type: "boolean" },
            pell_eligible: { type: "boolean" },
            fafsa_completed: { type: "boolean" },
            student_with_dependents: { type: "boolean" },
            homeschool_family: { type: "boolean" },
            private_school_student: { type: "boolean" },
            charter_school_student: { type: "boolean" },
            virtual_academy_student: { type: "boolean" },
            parent_led_education: { type: "boolean" },
            homeschool_coop_member: { type: "boolean" },
            esa_eligible: { type: "boolean" },
            education_choice_participant: { type: "boolean" },
            uninsured: { type: "boolean" },
            underemployed: { type: "boolean" },
            medical_debt: { type: "boolean" },
            education_debt: { type: "boolean" },
            bankruptcy: { type: "boolean" },
            first_time_homebuyer: { type: "boolean" },
            rural_resident: { type: "boolean" },
            appalachian_region: { type: "boolean" },
            urban_underserved: { type: "boolean" },
            qct: { type: "boolean" },
            opportunity_zone: { type: "boolean" },
            ej_area: { type: "boolean" },
            persistent_poverty_county: { type: "boolean" },
            tribal_land: { type: "boolean" },
            us_territory: { type: "boolean" },
            fema_disaster_area: { type: "boolean" },
            business_affected_covid: { type: "boolean" },
            fqhc: { type: "boolean" },
            community_action_agency: { type: "boolean" },
            cdc_org: { type: "boolean" },
            housing_authority: { type: "boolean" },
            workforce_board: { type: "boolean" },
            veterans_service_org: { type: "boolean" },
            volunteer_fire_ems: { type: "boolean" },
            research_institute: { type: "boolean" },
            cooperative: { type: "boolean" },
            cdfi_partner: { type: "boolean" },
            msi_institution: { type: "boolean" },
            rural_health_clinic: { type: "boolean" },
            environmental_org: { type: "boolean" },
            labor_union_org: { type: "boolean" },
            agricultural_extension: { type: "boolean" },
            business_8a: { type: "boolean" },
            sdvosb: { type: "boolean" },
            hubzone: { type: "boolean" },
            dbe: { type: "boolean" },
            mbe: { type: "boolean" },
            wbe: { type: "boolean" },
            sbe: { type: "boolean" },
            pro_bono: { type: "boolean" },
          }
        }
      });

      if (response && typeof response === 'object') {
        // Update formData with extracted values, preserving existing values not overwritten by AI
        // Coerce numeric and array fields from LLM response before merging
        const NUMERIC_FIELDS = [
          'gpa', 'act_score', 'sat_score', 'community_service_hours',
          'annual_budget', 'staff_count', 'indirect_rate',
          'age', 'household_income', 'household_size', 'cancer_diagnosis_year',
          'discount_percent', 'custom_monthly_cents'
        ];
        const FLOAT_FIELDS = ['gpa', 'indirect_rate', 'annual_budget', 'household_income'];
        const ARRAY_FIELDS = [
          'keywords', 'focus_areas', 'program_areas', 'populations_served',
          'service_geography', 'extracurricular_activities', 'achievements',
          'assistance_categories', 'student_grade_levels', 'target_colleges',
          'email', 'phone'
        ];
        const coercedResponse = { ...response };

        // applicant_type normalization already happens in initializeFormData on
        // load; here we normalize the AI-returned value once before merge.
        if (coercedResponse.applicant_type) {
          coercedResponse.applicant_type = normalizeApplicantType(coercedResponse.applicant_type);
        }

        // Track fields the AI returned as a non-empty value but which failed
        // numeric coercion, so we can surface them to the user instead of
        // silently discarding them.
        const droppedNumericFields = [];

        NUMERIC_FIELDS.forEach(field => {
          if (coercedResponse[field] !== undefined && coercedResponse[field] !== null) {
            const original = coercedResponse[field];
            const parsed = toNumberOrNull(coercedResponse[field], FLOAT_FIELDS.includes(field));
            if (parsed === null && !(typeof original === 'string' && original.trim() === '')) {
              droppedNumericFields.push(field);
            }
            coercedResponse[field] = parsed;
          }
        });
        ARRAY_FIELDS.forEach(field => {
          if (coercedResponse[field] !== undefined) {
            if (Array.isArray(coercedResponse[field])) return;
            if (typeof coercedResponse[field] === 'string' && coercedResponse[field].trim()) {
              coercedResponse[field] = coercedResponse[field].split(',').map(s => s.trim()).filter(Boolean);
            } else {
              coercedResponse[field] = [];
            }
          }
        });

        // Build a merge object that skips empty/null values so the AI cannot clobber
        // existing user-entered data with blanks.
        const mergeData = {};
        Object.keys(coercedResponse).forEach(key => {
          const value = coercedResponse[key];
          if (value === null || value === undefined) return;
          if (typeof value === 'string' && value.trim() === '') return;
          if (Array.isArray(value) && value.length === 0) return;
          mergeData[key] = value;
        });

        setFormData(prev => ({
          ...prev,
          ...mergeData
        }));

        if (droppedNumericFields.length > 0) {
          console.warn('AI harvest: dropped malformed numeric fields:', droppedNumericFields);
        }

        toast({
          title: "✨ Profile Data Extracted!",
          description: droppedNumericFields.length > 0
            ? `AI populated the form. Note: some numeric fields could not be parsed and were skipped: ${droppedNumericFields.join(', ')}.`
            : "AI has populated the form with extracted information. Review and adjust as needed.",
        });

        setAiInputText(""); // Clear the input after successful harvest
      } else {
        throw new Error("Invalid response from AI");
      }
    } catch (error) {
      console.error("AI harvest failed:", error);
      toast({
        title: "Extraction Failed",
        description: "Could not extract information. Please try again or fill manually. Error: " + (error.message || "Unknown error"),
        variant: "destructive",
      });
    } finally {
      setIsHarvesting(false);
    }
  };

  // AI suggestion for keywords
  const handleSuggestKeywords = async () => {
    setIsHarvesting(true);
    try {
      const contextInfo = `
Profile: ${formData.name}
Type: ${formData.applicant_type}
${formData.mission ? `Mission: ${formData.mission}` : ''}
${formData.primary_goal ? `Goal: ${formData.primary_goal}` : ''}
${formData.target_population ? `Population: ${formData.target_population}` : ''}
${formData.nonprofit_type ? `Organization Type: ${formData.nonprofit_type}` : ''}
${formData.intended_major ? `Major: ${formData.intended_major}` : ''}
${formData.assistance_categories ? `Assistance: ${formData.assistance_categories.join(', ')}` : ''}
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

      if (response?.keywords && Array.isArray(response.keywords)) {
        handleArrayChange('keywords', response.keywords);
        toast({
          title: "✨ Keywords Generated!",
          description: `Added ${response.keywords.length} keywords to your profile.`,
        });
      }
    } catch (error) {
      console.error('Failed to generate keywords:', error);
      toast({
        title: "Generation Failed",
        description: "Could not generate keywords. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsHarvesting(false);
    }
  };

  // AI suggestion for focus areas
  const handleSuggestFocusAreas = async () => {
    setIsHarvesting(true);
    try {
      const contextInfo = `
Profile: ${formData.name}
Type: ${formData.applicant_type}
${formData.mission ? `Mission: ${formData.mission}` : ''}
${formData.primary_goal ? `Goal: ${formData.primary_goal}` : ''}
${formData.program_areas ? `Programs: ${formData.program_areas.join(', ')}` : ''}
${formData.intended_major ? `Major: ${formData.intended_major}` : ''}
${formData.keywords ? `Keywords: ${formData.keywords.join(', ')}` : ''}
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

      if (response?.focus_areas && Array.isArray(response.focus_areas)) {
        handleArrayChange('focus_areas', response.focus_areas);
        toast({
          title: "✨ Focus Areas Generated!",
          description: `Added ${response.focus_areas.length} focus areas to your profile.`,
        });
      }
    } catch (error) {
      console.error('Failed to generate focus areas:', error);
      toast({
        title: "Generation Failed",
        description: "Could not generate focus areas. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsHarvesting(false);
    }
  };

  const handleSubmitForm = async (e) => {
    e.preventDefault();
    let cleanedData = { ...formData };

    // Normalize website before submit (handles cases where the field was never blurred).
    if (cleanedData.website && cleanedData.website.trim()) {
      const normalizedWebsite = normalizeWebsite(cleanedData.website);
      if (normalizedWebsite) {
        cleanedData.website = normalizedWebsite;
      } else {
        toast({
          title: "Invalid Website",
          description: "Please enter a valid website URL before saving.",
          variant: "destructive",
        });
        return;
      }
    }

    // Ensure numbers are converted correctly or set to null if invalid/empty.
    // toNumberOrNull is now exception-safe internally.
    const FLOAT_NUMERIC_FIELDS = ['gpa', 'indirect_rate', 'annual_budget', 'household_income'];
    const numericFields = [
      'gpa', 'act_score', 'sat_score', 'community_service_hours',
      'annual_budget', 'staff_count', 'indirect_rate',
      'age', 'household_income', 'household_size', 'cancer_diagnosis_year'
    ];
    numericFields.forEach(field => {
      cleanedData[field] = toNumberOrNull(cleanedData[field], FLOAT_NUMERIC_FIELDS.includes(field));
    });

    // Remove old organization_type field from payload if it was mapped to nonprofit_type
    delete cleanedData.organization_type;

    // The Organization sub-type (nonprofit | business | school) is what the
    // shared billing mapper reads to pick the org client category. We persist
    // it via the existing `nonprofit_type` column (no new DB column needed):
    // seed nonprofit_type from org_subtype when the user picked one. org_subtype
    // itself is UI-only state, so drop it from the payload.
    if (cleanedData.applicant_type === 'organization' && cleanedData.org_subtype) {
      cleanedData.nonprofit_type = cleanedData.nonprofit_type || cleanedData.org_subtype;
    }
    delete cleanedData.org_subtype;

    try {
        const { email, phone, ...coreOrgData } = cleanedData; // Destructure emails and phones before submitting core data

        const savedOrganization = await onSubmit(coreOrgData);

        // Validate the response immediately before any destructuring/use.
        if (!savedOrganization || typeof savedOrganization !== 'object' || !savedOrganization.id) {
            throw new Error("Failed to save organization or receive an ID back.");
        }

        const orgId = savedOrganization.id;
        const existingContacts = await client.entities.ContactMethod.filter({ organization_id: orgId });

        // Build the desired set of contacts (deduped by type+value).
        const desiredContacts = [];
        const seenDesired = new Set();
        const pushDesired = (type, rawVal) => {
            const value = (rawVal || '').trim();
            if (!value) return;
            const key = `${type}::${value}`;
            if (seenDesired.has(key)) return;
            seenDesired.add(key);
            desiredContacts.push({ organization_id: orgId, type, value });
        };
        (email || []).forEach(v => pushDesired('email', v));
        (phone || []).forEach(v => pushDesired('phone', v));

        // Build a lookup of existing contacts by type+value.
        const existingByKey = new Map();
        (existingContacts || []).forEach(c => {
            const key = `${c.type}::${(c.value || '').trim()}`;
            existingByKey.set(key, c);
        });
        const desiredKeys = new Set(desiredContacts.map(c => `${c.type}::${c.value}`));

        // Only create contacts that don't already exist (avoids duplicates).
        const contactsToCreate = desiredContacts.filter(c => !existingByKey.has(`${c.type}::${c.value}`));
        // Only delete existing contacts that are no longer desired.
        const contactsToDelete = (existingContacts || []).filter(c => {
            const key = `${c.type}::${(c.value || '').trim()}`;
            return !desiredKeys.has(key);
        });

        // Create the new contacts FIRST so a create failure does not leave the org
        // with zero contacts. Track created ids so we can attempt cleanup on a
        // subsequent failure (best-effort rollback).
        let createdContacts = [];
        if (contactsToCreate.length > 0) {
            createdContacts = await client.entities.ContactMethod.bulkCreate(contactsToCreate);
        }

        // Delete removed contacts using allSettled so one failure doesn't abort
        // the rest. Report individual delete failures explicitly.
        if (contactsToDelete.length > 0) {
            const deleteResults = await Promise.allSettled(
                contactsToDelete.map(contact => client.entities.ContactMethod.delete(contact.id))
            );
            const failedDeletes = deleteResults.filter(r => r.status === 'rejected');
            if (failedDeletes.length > 0) {
                console.error('Some contact deletions failed:', failedDeletes.map(f => f.reason));
                toast({
                    title: "Contact Cleanup Warning",
                    description: `Saved successfully, but ${failedDeletes.length} old contact(s) could not be removed. They may appear duplicated.`,
                    variant: "destructive",
                });
            }
        }

        // Note: createdContacts is intentionally retained for potential future
        // rollback logic; referenced here to avoid unused-variable lint issues.
        void createdContacts;

        queryClient.invalidateQueries({ queryKey: ['organizations'] });
        queryClient.invalidateQueries({ queryKey: ['contactMethods'] });
        queryClient.invalidateQueries({ queryKey: ['contactMethods', orgId] });

        toast({
            title: "Profile Saved!",
            description: "Your profile has been successfully updated.",
            variant: "success",
        });

        // Prefer a dedicated success/close handler; fall back to onCancel only if
        // no onSuccess prop is provided, to preserve existing close behavior.
        if (typeof onSuccess === 'function') {
            onSuccess(savedOrganization);
        } else if (typeof onCancel === 'function') {
            onCancel();
        }

    } catch (error) {
        console.error("Error during form submission process:", error);
        toast({
            title: "Submission Failed",
            description: error.message || "There was an error saving your profile. Please try again.",
            variant: "destructive",
        });
    }
  };

  const isOrganization = formData.applicant_type === 'organization';
  const isStudent = STUDENT_APPLICANT_TYPES.includes(formData.applicant_type);
  const isIndividualAssistance = ['individual_need', 'medical_assistance', 'family', 'homeschool_family'].includes(formData.applicant_type);
  const isIndividual = isStudent || isIndividualAssistance || formData.applicant_type === 'other';

  // Dynamic labels based on applicant type
  const getLabel = (orgLabel, individualLabel) => isIndividual ? individualLabel : orgLabel;
  const getPlaceholder = (orgPlaceholder, individualPlaceholder) => isIndividual ? individualPlaceholder : orgPlaceholder;

  if (organization && organization.id && isLoadingContacts) {
      return <div className="flex justify-center items-center p-8"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }

  return (
    <form onSubmit={handleSubmitForm} className="space-y-6">
      {/* AI PROFILE BUILDER */}
      {!organization && (
        <Card className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wand2 className="w-5 h-5 text-purple-600" />
              AI Profile Builder
            </CardTitle>
            <CardDescription>
              Paste or describe the person/organization, and AI will automatically extract and populate the profile fields below.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-input">
                Describe the Profile (paste bio, website text, resume, etc.)
              </Label>
              <Textarea
                id="ai-input"
                value={aiInputText}
                onChange={(e) => setAiInputText(e.target.value)}
                placeholder="Example: John Smith is a high school senior from Nashville, TN with a 3.8 GPA who wants to study forensic science. He's interested in scholarships for STEM students and has 200 hours of community service..."
                rows={6}
                className="font-mono text-sm"
              />
            </div>
            <Button
              type="button"
              onClick={handleAIHarvest}
              disabled={isHarvesting || !aiInputText.trim()}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
            >
              {isHarvesting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Extracting Information...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Extract & Populate Profile
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* PROFILE TYPE AND IMAGE */}
      <Card className="mb-6 shadow-lg border-0">
        <CardHeader className="border-b border-slate-100">
          <CardTitle>
            {organization ? 'Edit Profile' : 'Add New Profile'}
          </CardTitle>
          <p className="text-sm text-slate-600 mt-2">
            Create a profile for an organization, student, or individual seeking funding. Only name is required.
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <div className="flex items-center gap-6">
            <div className="relative">
                <Label htmlFor="profile-image-upload">
                    {formData.profile_image_url ? (
                        <img src={formData.profile_image_url} alt="Profile" className="w-24 h-24 rounded-full object-cover border-2 cursor-pointer hover:opacity-80 transition-opacity" />
                    ) : (
                        <div className="w-24 h-24 rounded-full bg-slate-100 flex items-center justify-center border-2 border-dashed cursor-pointer hover:bg-slate-200 transition-colors">
                            <ImagePlus className="w-8 h-8 text-slate-400" />
                        </div>
                    )}
                </Label>
                <Input id="profile-image-upload" type="file" className="hidden" onChange={handleImageUpload} accept="image/*" disabled={isUploading} />
                {isUploading && <div className="absolute inset-0 bg-white bg-opacity-70 flex items-center justify-center rounded-full"><Loader2 className="w-6 h-6 animate-spin" /></div>}
            </div>
            <div className="flex-1">
                <Label className="text-base font-semibold mb-2 block">Profile Picture</Label>
                <p className="text-sm text-slate-500">Click the image to upload a new one. Recommended size: 400x400px.</p>
            </div>
          </div>
          <Card className="bg-slate-50 border-slate-200 mt-6">
            <CardContent className="p-4">
              <Label className="text-base font-semibold mb-3 block">Profile Type *</Label>
              {/* Canonical profile types — aligned with the billing client
                  categories. Individuals / Students / Families / Homeschool /
                  Medical all bill as the Individual tier; Organization is
                  budget-bucketed (Small / Mid / Large) via its annual budget. */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {PROFILE_TYPE_CARDS.map((card) => {
                  const active = card.id === 'organization'
                    ? isOrganization
                    : card.id === 'student'
                      ? isStudent
                      : formData.applicant_type === card.id;
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => handleSelectChange('applicant_type', card.id)}
                      className={`p-4 rounded-lg border-2 transition-all text-center ${
                        active
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-slate-200 bg-white hover:border-blue-300'
                      }`}
                    >
                      <Icon className={`w-6 h-6 mx-auto mb-2 ${active ? 'text-blue-600' : 'text-slate-400'}`} />
                      <p className="font-semibold text-sm">{card.label}</p>
                      <p className="text-xs text-slate-600 mt-1">{card.description}</p>
                    </button>
                  );
                })}
              </div>

              {/* Organization sub-type — drives nothing in billing on its own,
                  but records whether the org is a Nonprofit / Business / School.
                  The Small/Mid/Large billing band comes from Annual Budget. */}
              {isOrganization && (
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="org_subtype">Organization Sub-Type</Label>
                    <Select
                      value={formData.org_subtype || ''}
                      onValueChange={(value) => handleSelectChange('org_subtype', value)}
                    >
                      <SelectTrigger id="org_subtype">
                        <SelectValue placeholder="Nonprofit, Business, or School" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="nonprofit">Nonprofit</SelectItem>
                        <SelectItem value="business">Business</SelectItem>
                        <SelectItem value="school">School</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Your billing band (Small / Mid / Large) is set by your Annual Budget below.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            Basic Information
          </CardTitle>
          <CardDescription>
            {isIndividual ? 'Your personal information and background' : 'Core details about your organization'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Pro Bono Checkbox - Prominent placement */}
          <div className="p-4 bg-emerald-50 border-2 border-emerald-200 rounded-lg">
            <div className="flex items-center space-x-3">
              <Checkbox
                id="pro_bono"
                name="pro_bono"
                checked={formData.pro_bono}
                onCheckedChange={(checked) => handleChange({ target: { name: 'pro_bono', type: 'checkbox', checked } })}
              />
              <div className="flex-1">
                <Label htmlFor="pro_bono" className="text-base font-semibold text-emerald-900 cursor-pointer">
                  Pro Bono Client
                </Label>
                <p className="text-sm text-emerald-700 mt-1">
                  Check this box for pro bono work. Time and invoices will still be tracked for tax write-off purposes, but invoices will have 100% discount applied (balance due: $0).
                </p>
              </div>
            </div>
          </div>

          {/* Billing & Discount Configuration */}
          <Card className="border-blue-200 bg-blue-50/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <DollarSign className="w-5 h-5 text-blue-600" />
                Billing & Discount Configuration
              </CardTitle>
              <CardDescription className="text-xs">
                Configure billing tier and apply discounts for this profile
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="tier_id">Billing Tier</Label>
                  <Select
                    value={formData.tier_id || "__none__"}
                    onValueChange={(value) => handleSelectChange('tier_id', value === '__none__' ? null : value)}
                  >
                    <SelectTrigger id="tier_id">
                      <SelectValue placeholder={isLoadingTiers ? "Loading tiers..." : "Select billing tier"} />
                    </SelectTrigger>
                    <SelectContent>
                      {/* Radix forbids value=""; sentinel maps back to null (no tier). */}
                      <SelectItem value="__none__">No tier selected</SelectItem>
                      {billingTiers.map((tier) => (
                        <SelectItem key={tier.id} value={tier.id}>
                          <div className="flex flex-col items-start">
                            <span className="font-medium">{tier.name}</span>
                            <span className="text-xs text-slate-500">
                              ${((tier.base_monthly_cents || 0) / 100).toFixed(2)}/month
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="custom_monthly_cents">Custom Monthly Rate (optional)</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-500">$</span>
                    <Input
                      id="custom_monthly_cents"
                      name="custom_monthly_cents"
                      type="number"
                      step="0.01"
                      value={formData.custom_monthly_cents ? (formData.custom_monthly_cents / 100).toFixed(2) : ""}
                      onChange={(e) => {
                        const dollars = parseFloat(e.target.value) || 0;
                        const cents = Math.round(dollars * 100);
                        handleSelectChange('custom_monthly_cents', cents || null);
                      }}
                      placeholder="Override tier rate"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="discount_type">Discount Type</Label>
                  <Select
                    value={formData.discount_type || "none"}
                    onValueChange={(value) => handleSelectChange('discount_type', value)}
                  >
                    <SelectTrigger id="discount_type">
                      <SelectValue placeholder="Select discount type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No Discount</SelectItem>
                      <SelectItem value="percentage">Percentage Discount</SelectItem>
                      <SelectItem value="fixed_amount">Fixed Amount Discount</SelectItem>
                      <SelectItem value="ministry_discount">Ministry/Nonprofit Discount</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="discount_percent">
                    {formData.discount_type === "percentage" ? "Discount Percentage" : "Discount Value"}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="discount_percent"
                      name="discount_percent"
                      type="number"
                      min="0"
                      max={formData.discount_type === "percentage" ? "100" : undefined}
                      step={formData.discount_type === "percentage" ? "1" : "0.01"}
                      value={formData.discount_percent || ""}
                      onChange={handleChange}
                      placeholder="0"
                      disabled={formData.discount_type === "none"}
                    />
                    {formData.discount_type === "percentage" && (
                      <span className="text-sm text-slate-500">%</span>
                    )}
                    {formData.discount_type === "fixed_amount" && (
                      <span className="text-sm text-slate-500">USD</span>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">{getLabel('Organization Name', 'Your Full Name')} *</Label>
              <Input
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                placeholder={getPlaceholder('Organization legal name', 'Your full name')}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="website">
                Website {isOrganization && '*'}
                {!isOrganization && <span className="text-slate-500 font-normal ml-1">(Optional)</span>}
              </Label>
              <Input
                  id="website"
                  name="website"
                  type={isOrganization ? "url" : "text"}
                  value={formData.website}
                  onChange={handleChange}
                  onBlur={handleWebsiteBlur}
                  placeholder={isOrganization ? "https://www.example.com" : "Optional - leave blank if none"}
                  required={isOrganization}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Email Addresses</Label>
                 <MultiSelectCombobox
                    options={[]} // No predefined options, allow custom
                    selected={formData.email || []}
                    onSelectedChange={(values) => handleArrayChange('email', values)}
                    placeholder="add-email@example.com"
                    allowCustom
                  />
              </div>
              <div className="space-y-2">
                <Label>Phone Numbers</Label>
                <MultiSelectCombobox
                    options={[]} // No predefined options, allow custom
                    selected={formData.phone || []}
                    onSelectedChange={(values) => handleArrayChange('phone', values)}
                    placeholder="(XXX) XXX-XXXX"
                    allowCustom
                  />
              </div>
          </div>

          <div className="space-y-4 pt-6 border-t">
              <h3 className="text-lg font-semibold text-slate-800">Address</h3>
              <div>
                  <Label htmlFor="address">Street Address</Label>
                  <Input id="address" name="address" value={formData.address} onChange={handleChange} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                      <Label htmlFor="city">City</Label>
                      <Input id="city" name="city" value={formData.city} onChange={handleChange} />
                  </div>
                  <div>
                      <Label htmlFor="state">State</Label>
                      <Select name="state" value={formData.state || ""} onValueChange={(value) => handleSelectChange('state', value)}>
                          <SelectTrigger><SelectValue placeholder="Select State" /></SelectTrigger>
                          <SelectContent>
                              {US_STATES.map(state => <SelectItem key={state} value={state}>{state}</SelectItem>)}
                          </SelectContent>
                      </Select>
                  </div>
                  <div>
                      <Label htmlFor="zip">ZIP / Postal Code</Label>
                      <Input id="zip" name="zip" value={formData.zip} onChange={handleChange} />
                  </div>
              </div>
          </div>

          {isOrganization && (
            <div className="space-y-4 pt-6 border-t">
              <h3 className="text-lg font-semibold text-slate-800">Organization Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="ein" className="flex items-center gap-1">
                    EIN
                    <FieldHelpTip id="organization.ein" />
                  </Label>
                  <Input id="ein" name="ein" value={formData.ein} onChange={handleChange} />
                </div>
                <div>
                  <Label htmlFor="uei" className="flex items-center gap-1">
                    UEI Number
                    <FieldHelpTip id="organization.uei" />
                  </Label>
                  <Input id="uei" name="uei" value={formData.uei} onChange={handleChange} />
                </div>
                <div>
                  <Label>Nonprofit Type</Label>
                  <MultiSelectCombobox
                    options={orgTypeOptions}
                    selected={formData.nonprofit_type ? [formData.nonprofit_type] : []}
                    onSelectedChange={(values) => handleArrayChange('nonprofit_type', values[0] || '')}
                    placeholder="Select organization type..."
                    singleSelect
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label>Annual Budget</Label>
                  <Input type="number" name="annual_budget" value={formData.annual_budget || ""} onChange={handleChange} />
                </div>
                <div>
                  <Label>Staff Count</Label>
                  <Input type="number" name="staff_count" value={formData.staff_count || ""} onChange={handleChange} />
                </div>
                <div>
                  <Label>Indirect Rate (%)</Label>
                  <Input type="number" step="0.01" name="indirect_rate" value={formData.indirect_rate || ""} onChange={handleChange} />
                </div>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-4 pt-2">
                <div className="flex items-center space-x-2">
                  <Checkbox id="sam_registered" name="sam_registered" checked={formData.sam_registered} onCheckedChange={(checked) => handleChange({ target: { name: 'sam_registered', type: 'checkbox', checked } })} />
                  <Label htmlFor="sam_registered">SAM.gov Registered</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="faith_based" name="faith_based" checked={formData.faith_based} onCheckedChange={(checked) => handleChange({ target: { name: 'faith_based', type: 'checkbox', checked } })} />
                  <Label htmlFor="faith_based">Faith-Based</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="rural" name="rural" checked={formData.rural} onCheckedChange={(checked) => handleChange({ target: { name: 'rural', type: 'checkbox', checked } })} />
                  <Label htmlFor="rural">Serves Rural Area</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="minority_serving" name="minority_serving" checked={formData.minority_serving} onCheckedChange={(checked) => handleChange({ target: { name: 'minority_serving', type: 'checkbox', checked } })} />
                  <Label htmlFor="minority_serving">Minority-Serving</Label>
                </div>
              </div>
            </div>
          )}

          {/* Student-Specific Fields */}
          {isStudent && (
            <div className="space-y-4 pt-6 border-t">
              <h3 className="text-lg font-semibold text-slate-800">Student Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>Grade Level(s) *</Label>
                  <MultiSelectCombobox
                    options={STUDENT_GRADE_LEVELS}
                    selected={formData.student_grade_levels || []}
                    onSelectedChange={(values) => handleArrayChange('student_grade_levels', values)}
                    placeholder="Select grade level(s)"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Select all grade levels that apply (e.g., if you're a high school senior applying for college, select both)
                  </p>
                </div>

                {/* College Information for all students */}
                <div>
                  <Label htmlFor="current_college">Current College/University</Label>
                  <Input
                    id="current_college"
                    name="current_college"
                    value={formData.current_college || ''}
                    onChange={handleChange}
                    placeholder="e.g., University of Tennessee"
                  />
                  <p className="text-xs text-slate-500 mt-1">The college you currently attend (if any)</p>
                </div>

                <div>
                  <Label>Interested/Target Colleges</Label>
                  <MultiSelectCombobox
                    options={[]}
                    selected={formData.target_colleges || []}
                    onSelectedChange={(values) => handleArrayChange('target_colleges', values)}
                    placeholder="Add colleges you're interested in or applying to..."
                    allowCustom
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    List all colleges/universities you're interested in, applying to, or considering. We'll search for school-specific scholarships.
                  </p>
                </div>

                <div>
                  <Label htmlFor="intended_major">Intended Major/Field of Study</Label>
                  <Input
                    id="intended_major"
                    name="intended_major"
                    value={formData.intended_major || ''}
                    onChange={handleChange}
                    placeholder="e.g., Computer Science"
                  />
                </div>
              </div>

              {/* ... keep existing code (GPA, ACT, SAT, etc.) */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div><Label>GPA</Label><Input type="number" step="0.01" name="gpa" value={formData.gpa || ""} onChange={handleChange} /></div>
                <div><Label>ACT Score</Label><Input type="number" name="act_score" value={formData.act_score || ""} onChange={handleChange} /></div>
                <div><Label>SAT Score</Label><Input type="number" name="sat_score" value={formData.sat_score || ""} onChange={handleChange} /></div>
                <div><Label>Service Hours</Label><Input type="number" name="community_service_hours" value={formData.community_service_hours || ""} onChange={handleChange} /></div>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-4 pt-2">
                <div className="flex items-center space-x-2">
                  <Checkbox id="first_generation" name="first_generation" checked={formData.first_generation} onCheckedChange={(checked) => handleChange({ target: { name: 'first_generation', type: 'checkbox', checked } })} />
                  <Label htmlFor="first_generation">First-Generation Student</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="veteran" name="veteran" checked={formData.veteran} onCheckedChange={(checked) => handleChange({ target: { name: 'veteran', type: 'checkbox', checked } })} />
                  <Label htmlFor="veteran">Veteran</Label>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* COMPREHENSIVE DETAILS - NOW AVAILABLE FOR ALL PROFILE TYPES */}
      {isIndividual && (
        <div className="space-y-4 pt-6 border-t mt-6">
          <div className="bg-gradient-to-r from-blue-50 to-purple-50 border-2 border-blue-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-blue-900 font-medium">
              <strong>✨ Comprehensive Profile Information</strong>
            </p>
            <p className="text-xs text-blue-700 mt-1">
              The sections below help us find the best funding matches for you. Complete only what's relevant to your situation.
            </p>
          </div>

          {/* Personal Information Section */}
          <Card className="border-slate-200">
            <CardHeader className="bg-slate-50">
              <CardTitle className="text-base">Personal Information</CardTitle>
              <CardDescription className="text-xs">Age, household, and immigration status</CardDescription>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="date_of_birth">Date of Birth</Label>
                  <Input
                    id="date_of_birth"
                    name="date_of_birth"
                    type="date"
                    value={formData.date_of_birth || ""}
                    onChange={handleChange}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Used to auto-detect senior citizen eligibility (65+)
                  </p>
                </div>

                <div>
                  <Label htmlFor="age">Age (if DOB not provided)</Label>
                  <Input
                    id="age"
                    name="age"
                    type="number"
                    value={formData.age || ""}
                    onChange={handleChange}
                    placeholder="Enter age"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="immigration_status">Immigration Status</Label>
                  <Select name="immigration_status" value={formData.immigration_status} onValueChange={(value) => handleSelectChange('immigration_status', value)}>
                    <SelectTrigger><SelectValue placeholder="Select status..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="us_citizen">U.S. Citizen</SelectItem>
                      <SelectItem value="permanent_resident">Permanent Resident (Green Card)</SelectItem>
                      <SelectItem value="refugee">Refugee</SelectItem>
                      <SelectItem value="asylee">Asylee</SelectItem>
                      <SelectItem value="daca">DACA Recipient</SelectItem>
                      <SelectItem value="visa_holder">Visa Holder</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="household_size">Household Size</Label>
                  <Input
                    id="household_size"
                    name="household_size"
                    type="number"
                    value={formData.household_size || ""}
                    onChange={handleChange}
                    placeholder="4"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="household_income">Annual Household Income (Optional)</Label>
                <Input
                  id="household_income"
                  name="household_income"
                  type="number"
                  value={formData.household_income || ""}
                  onChange={handleChange}
                  placeholder="50000"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Only needed if required by a specific funding source
                </p>
              </div>

              {assistanceOptions.length > 0 && (
                <div>
                  <Label>Assistance Categories</Label>
                  <MultiSelectCombobox
                    options={assistanceOptions}
                    selected={formData.assistance_categories || []}
                    onSelectedChange={(values) => handleArrayChange('assistance_categories', values)}
                    placeholder="Select assistance types..."
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Government Assistance Programs */}
          <Card className="border-green-200">
            <CardHeader className="bg-green-50">
              <CardTitle className="text-base text-green-900">Government Assistance Programs</CardTitle>
              <CardDescription className="text-xs">Check all programs you currently receive</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="medicaid_enrolled" name="medicaid_enrolled" checked={formData.medicaid_enrolled} onCheckedChange={(checked) => handleChange({ target: { name: 'medicaid_enrolled', type: 'checkbox', checked } })} />
                  <Label htmlFor="medicaid_enrolled">Medicaid</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="medicare_recipient" name="medicare_recipient" checked={formData.medicare_recipient} onCheckedChange={(checked) => handleChange({ target: { name: 'medicare_recipient', type: 'checkbox', checked } })} />
                  <Label htmlFor="medicare_recipient">Medicare</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="ssi_recipient" name="ssi_recipient" checked={formData.ssi_recipient} onCheckedChange={(checked) => handleChange({ target: { name: 'ssi_recipient', type: 'checkbox', checked } })} />
                  <Label htmlFor="ssi_recipient">SSI (Supplemental Security Income)</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="ssdi_recipient" name="ssdi_recipient" checked={formData.ssdi_recipient} onCheckedChange={(checked) => handleChange({ target: { name: 'ssdi_recipient', type: 'checkbox', checked } })} />
                  <Label htmlFor="ssdi_recipient">SSDI (Social Security Disability)</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="snap_recipient" name="snap_recipient" checked={formData.snap_recipient} onCheckedChange={(checked) => handleChange({ target: { name: 'snap_recipient', type: 'checkbox', checked } })} />
                  <Label htmlFor="snap_recipient">SNAP (Food Stamps)</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="tanf_recipient" name="tanf_recipient" checked={formData.tanf_recipient} onCheckedChange={(checked) => handleChange({ target: { name: 'tanf_recipient', type: 'checkbox', checked } })} />
                  <Label htmlFor="tanf_recipient">TANF (Temporary Assistance)</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="section8_housing" name="section8_housing" checked={formData.section8_housing} onCheckedChange={(checked) => handleChange({ target: { name: 'section8_housing', type: 'checkbox', checked } })} />
                  <Label htmlFor="section8_housing">Section 8 Housing</Label>
                </div>

                {/* New field */}
                <div className="flex items-center space-x-2">
                  <Checkbox id="public_housing_resident" name="public_housing_resident" checked={formData.public_housing_resident} onCheckedChange={(checked) => handleChange({ target: { name: 'public_housing_resident', type: 'checkbox', checked } })} />
                  <Label htmlFor="public_housing_resident">Public Housing Resident</Label>
                </div>
              </div>

              {formData.medicaid_enrolled && (
                <div className="mt-4 space-y-3 pt-4 border-t">
                  <div>
                    <Label htmlFor="medicaid_waiver_program">Medicaid Waiver Program</Label>
                    <Select name="medicaid_waiver_program" value={formData.medicaid_waiver_program} onValueChange={(value) => handleSelectChange('medicaid_waiver_program', value)}>
                      <SelectTrigger><SelectValue placeholder="Select waiver program..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="ecf_choices">ECF CHOICES (TN)</SelectItem>
                        <SelectItem value="katie_beckett">Katie Beckett</SelectItem>
                        <SelectItem value="self_determination">Self-Determination</SelectItem>
                        <SelectItem value="family_support">Family Support</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="tenncare_id">TennCare ID (if applicable)</Label>
                    <Input
                      id="tenncare_id"
                      name="tenncare_id"
                      value={formData.tenncare_id || ""}
                      onChange={handleChange}
                      placeholder="TennCare ID number"
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Health & Medical Conditions */}
          <Card className="border-rose-200">
            <CardHeader className="bg-rose-50">
              <CardTitle className="text-base text-rose-900">Health & Medical Conditions</CardTitle>
              <CardDescription className="text-xs">Check all conditions that apply</CardDescription>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              {/* Cancer Survivor */}
              <div className="space-y-2 p-3 bg-white rounded border border-rose-200">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="cancer_survivor"
                    name="cancer_survivor"
                    checked={formData.cancer_survivor}
                    onCheckedChange={(checked) => handleChange({ target: { name: 'cancer_survivor', type: 'checkbox', checked } })}
                  />
                  <Label htmlFor="cancer_survivor" className="font-semibold">Cancer Survivor</Label>
                </div>

                {formData.cancer_survivor && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 ml-6">
                    <div>
                      <Label htmlFor="cancer_type">Type of Cancer</Label>
                      <Input
                        id="cancer_type"
                        name="cancer_type"
                        value={formData.cancer_type || ""}
                        onChange={handleChange}
                        placeholder="e.g., Breast, Lung, Leukemia"
                      />
                    </div>
                    <div>
                      <Label htmlFor="cancer_diagnosis_year">Year of Diagnosis</Label>
                      <Input
                        id="cancer_diagnosis_year"
                        name="cancer_diagnosis_year"
                        type="number"
                        value={formData.cancer_diagnosis_year || ""}
                        onChange={handleChange}
                        placeholder="2020"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Chronic Illness */}
              <div className="space-y-2 p-3 bg-white rounded border border-rose-200">
                <div className="flex items-center space-x-2">
                  <Checkbox id="chronic_illness" name="chronic_illness" checked={formData.chronic_illness} onCheckedChange={(checked) => handleChange({ target: { name: 'chronic_illness', type: 'checkbox', checked } })} />
                  <Label htmlFor="chronic_illness" className="font-semibold">Chronic Illness</Label>
                </div>

                {formData.chronic_illness && (
                  <div className="mt-3 ml-6">
                    <Label htmlFor="chronic_illness_type">Type of Chronic Illness</Label>
                    <Input
                      id="chronic_illness_type"
                      name="chronic_illness_type"
                      value={formData.chronic_illness_type || ""}
                      onChange={handleChange}
                      placeholder="e.g., Diabetes, Heart Disease, Asthma"
                    />
                  </div>
                )}
              </div>

              {/* Other Health Conditions */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="dialysis_patient" name="dialysis_patient" checked={formData.dialysis_patient} onCheckedChange={(checked) => handleChange({ target: { name: 'dialysis_patient', type: 'checkbox', checked } })} />
                  <Label htmlFor="dialysis_patient">Dialysis Patient</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="organ_transplant" name="organ_transplant" checked={formData.organ_transplant} onCheckedChange={(checked) => handleChange({ target: { name: 'organ_transplant', type: 'checkbox', checked } })} />
                  <Label htmlFor="organ_transplant">Organ Transplant Recipient</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="hiv_aids" name="hiv_aids" checked={formData.hiv_aids} onCheckedChange={(checked) => handleChange({ target: { name: 'hiv_aids', type: 'checkbox', checked } })} />
                  <Label htmlFor="hiv_aids">HIV/AIDS</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="tbi_survivor" name="tbi_survivor" checked={formData.tbi_survivor} onCheckedChange={(checked) => handleChange({ target: { name: 'tbi_survivor', type: 'checkbox', checked } })} />
                  <Label htmlFor="tbi_survivor">Traumatic Brain Injury (TBI)</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="amputee" name="amputee" checked={formData.amputee} onCheckedChange={(checked) => handleChange({ target: { name: 'amputee', type: 'checkbox', checked } })} />
                  <Label htmlFor="amputee">Amputee</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="neurodivergent" name="neurodivergent" checked={formData.neurodivergent} onCheckedChange={(checked) => handleChange({ target: { name: 'neurodivergent', type: 'checkbox', checked } })} />
                  <Label htmlFor="neurodivergent">Neurodivergent (Autism, ADHD, etc.)</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="visual_impairment" name="visual_impairment" checked={formData.visual_impairment} onCheckedChange={(checked) => handleChange({ target: { name: 'visual_impairment', type: 'checkbox', checked } })} />
                  <Label htmlFor="visual_impairment">Visual Impairment</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="hearing_impairment" name="hearing_impairment" checked={formData.hearing_impairment} onCheckedChange={(checked) => handleChange({ target: { name: 'hearing_impairment', type: 'checkbox', checked } })} />
                  <Label htmlFor="hearing_impairment">Hearing Impairment</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="wheelchair_user" name="wheelchair_user" checked={formData.wheelchair_user} onCheckedChange={(checked) => handleChange({ target: { name: 'wheelchair_user', type: 'checkbox', checked } })} />
                  <Label htmlFor="wheelchair_user">Wheelchair User</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="substance_recovery" name="substance_recovery" checked={formData.substance_recovery} onCheckedChange={(checked) => handleChange({ target: { name: 'substance_recovery', type: 'checkbox', checked } })} />
                  <Label htmlFor="substance_recovery">Substance Recovery Participant</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="mental_health_condition" name="mental_health_condition" checked={formData.mental_health_condition} onCheckedChange={(checked) => handleChange({ target: { name: 'mental_health_condition', type: 'checkbox', checked } })} />
                  <Label htmlFor="mental_health_condition">Mental Health Condition</Label>
                </div>

                {/* New health fields */}
                <div className="flex items-center space-x-2">
                  <Checkbox id="long_covid" name="long_covid" checked={formData.long_covid} onCheckedChange={(checked) => handleChange({ target: { name: 'long_covid', type: 'checkbox', checked } })} />
                  <Label htmlFor="long_covid">Long COVID</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="maternal_health" name="maternal_health" checked={formData.maternal_health} onCheckedChange={(checked) => handleChange({ target: { name: 'maternal_health', type: 'checkbox', checked } })} />
                  <Label htmlFor="maternal_health">Maternal Health Issues</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="hospice_care" name="hospice_care" checked={formData.hospice_care} onCheckedChange={(checked) => handleChange({ target: { name: 'hospice_care', type: 'checkbox', checked } })} />
                  <Label htmlFor="hospice_care">Hospice Care</Label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Demographics & Background */}
          <Card className="border-amber-200">
            <CardHeader className="bg-amber-50">
              <CardTitle className="text-base text-amber-900">Demographics & Background</CardTitle>
              <CardDescription className="text-xs">Check all that apply</CardDescription>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="african_american" name="african_american" checked={formData.african_american} onCheckedChange={(checked) => handleChange({ target: { name: 'african_american', type: 'checkbox', checked } })} />
                  <Label htmlFor="african_american">African American / Black</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="hispanic_latino" name="hispanic_latino" checked={formData.hispanic_latino} onCheckedChange={(checked) => handleChange({ target: { name: 'hispanic_latino', type: 'checkbox', checked } })} />
                  <Label htmlFor="hispanic_latino">Hispanic / Latino</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="asian_american" name="asian_american" checked={formData.asian_american} onCheckedChange={(checked) => handleChange({ target: { name: 'asian_american', type: 'checkbox', checked } })} />
                  <Label htmlFor="asian_american">Asian American</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="lgbtq" name="lgbtq" checked={formData.lgbtq} onCheckedChange={(checked) => handleChange({ target: { name: 'lgbtq', type: 'checkbox', checked } })} />
                  <Label htmlFor="lgbtq">LGBTQ+</Label>
                </div>

                {/* New demographics field */}
                <div className="flex items-center space-x-2">
                  <Checkbox id="new_immigrant" name="new_immigrant" checked={formData.new_immigrant} onCheckedChange={(checked) => handleChange({ target: { name: 'new_immigrant', type: 'checkbox', checked } })} />
                  <Label htmlFor="new_immigrant">New Immigrant (within 5 years)</Label>
                </div>
              </div>

              {/* Native American with tribal affiliation */}
              <div className="space-y-2 p-3 bg-white rounded border border-amber-200 mt-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="native_american" name="native_american" checked={formData.native_american} onCheckedChange={(checked) => handleChange({ target: { name: 'native_american', type: 'checkbox', checked } })} />
                  <Label htmlFor="native_american">Native American / Alaska Native</Label>
                </div>

                {formData.native_american && (
                  <div className="mt-3 ml-6">
                    <Label htmlFor="tribal_affiliation">Tribal Affiliation</Label>
                    <Input
                      id="tribal_affiliation"
                      name="tribal_affiliation"
                      value={formData.tribal_affiliation || ""}
                      onChange={handleChange}
                      placeholder="Name of tribe"
                    />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Family & Life Situation */}
          <Card className="border-blue-200">
            <CardHeader className="bg-blue-50">
              <CardTitle className="text-base text-blue-900">Family & Life Situation</CardTitle>
              <CardDescription className="text-xs">Check all that apply</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="permanent_resident" name="permanent_resident" checked={formData.permanent_resident} onCheckedChange={(checked) => handleChange({ target: { name: 'permanent_resident', type: 'checkbox', checked } })} />
                  <Label htmlFor="permanent_resident">Green Card Holder</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="single_parent" name="single_parent" checked={formData.single_parent} onCheckedChange={(checked) => handleChange({ target: { name: 'single_parent', type: 'checkbox', checked } })} />
                  <Label htmlFor="single_parent">Single Parent</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="foster_youth" name="foster_youth" checked={formData.foster_youth} onCheckedChange={(checked) => handleChange({ target: { name: 'foster_youth', type: 'checkbox', checked } })} />
                  <Label htmlFor="foster_youth">Foster Youth / Former Foster Care</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="homeless" name="homeless" checked={formData.homeless} onCheckedChange={(checked) => handleChange({ target: { name: 'homeless', type: 'checkbox', checked } })} />
                  <Label htmlFor="homeless">Homeless/Housing Insecure</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="low_income" name="low_income" checked={formData.low_income} onCheckedChange={(checked) => handleChange({ target: { name: 'low_income', type: 'checkbox', checked } })} />
                  <Label htmlFor="low_income">Low Income</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="refugee" name="refugee" checked={formData.refugee} onCheckedChange={(checked) => handleChange({ target: { name: 'refugee', type: 'checkbox', checked } })} />
                  <Label htmlFor="refugee">Refugee/Asylum Seeker</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="formerly_incarcerated" name="formerly_incarcerated" checked={formData.formerly_incarcerated} onCheckedChange={(checked) => handleChange({ target: { name: 'formerly_incarcerated', type: 'checkbox', checked } })} />
                  <Label htmlFor="formerly_incarcerated">Formerly Incarcerated</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="caregiver" name="caregiver" checked={formData.caregiver} onCheckedChange={(checked) => handleChange({ target: { name: 'caregiver', type: 'checkbox', checked } })} />
                  <Label htmlFor="caregiver">Family Caregiver</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="orphan" name="orphan" checked={formData.orphan} onCheckedChange={(checked) => handleChange({ target: { name: 'orphan', type: 'checkbox', checked } })} />
                  <Label htmlFor="orphan">Orphan</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="adopted" name="adopted" checked={formData.adopted} onCheckedChange={(checked) => handleChange({ target: { name: 'adopted', type: 'checkbox', checked } })} />
                  <Label htmlFor="adopted">Adopted</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="widow_widower" name="widow_widower" checked={formData.widow_widower} onCheckedChange={(checked) => handleChange({ target: { name: 'widow_widower', type: 'checkbox', checked } })} />
                  <Label htmlFor="widow_widower">Widow / Widower</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="grandparent_raising_grandchildren" name="grandparent_raising_grandchildren" checked={formData.grandparent_raising_grandchildren} onCheckedChange={(checked) => handleChange({ target: { name: 'grandparent_raising_grandchildren', type: 'checkbox', checked } })} />
                  <Label htmlFor="grandparent_raising_grandchildren">Grandparent Raising Grandchildren</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="first_time_parent" name="first_time_parent" checked={formData.first_time_parent} onCheckedChange={(checked) => handleChange({ target: { name: 'first_time_parent', type: 'checkbox', checked } })} />
                  <Label htmlFor="first_time_parent">First-Time Parent</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="domestic_violence_survivor" name="domestic_violence_survivor" checked={formData.domestic_violence_survivor} onCheckedChange={(checked) => handleChange({ target: { name: 'domestic_violence_survivor', type: 'checkbox', checked } })} />
                  <Label htmlFor="domestic_violence_survivor">Domestic Violence Survivor</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="trafficking_survivor" name="trafficking_survivor" checked={formData.trafficking_survivor} onCheckedChange={(checked) => handleChange({ target: { name: 'trafficking_survivor', type: 'checkbox', checked } })} />
                  <Label htmlFor="trafficking_survivor">Human Trafficking Survivor</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="disaster_survivor" name="disaster_survivor" checked={formData.disaster_survivor} onCheckedChange={(checked) => handleChange({ target: { name: 'disaster_survivor', type: 'checkbox', checked } })} />
                  <Label htmlFor="disaster_survivor">Disaster Survivor</Label>
                </div>

                {/* New Family & Life fields */}
                <div className="flex items-center space-x-2">
                  <Checkbox id="returning_citizen" name="returning_citizen" checked={formData.returning_citizen} onCheckedChange={(checked) => handleChange({ target: { name: 'returning_citizen', type: 'checkbox', checked } })} />
                  <Label htmlFor="returning_citizen">Returning Citizen (formerly incarcerated)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="minor_child" name="minor_child" checked={formData.minor_child} onCheckedChange={(checked) => handleChange({ target: { name: 'minor_child', type: 'checkbox', checked } })} />
                  <Label htmlFor="minor_child">Minor Child (under 18)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="young_adult" name="young_adult" checked={formData.young_adult} onCheckedChange={(checked) => handleChange({ target: { name: 'young_adult', type: 'checkbox', checked } })} />
                  <Label htmlFor="young_adult">Young Adult (18-24)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="foster_parent" name="foster_parent" checked={formData.foster_parent} onCheckedChange={(checked) => handleChange({ target: { name: 'foster_parent', type: 'checkbox', checked } })} />
                  <Label htmlFor="foster_parent">Foster Parent</Label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Military Status */}
          <Card className="border-indigo-200">
            <CardHeader className="bg-indigo-50">
              <CardTitle className="text-base text-indigo-900">Military Service</CardTitle>
              <CardDescription className="text-xs">Check all that apply</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="veteran" name="veteran" checked={formData.veteran} onCheckedChange={(checked) => handleChange({ target: { name: 'veteran', type: 'checkbox', checked } })} />
                  <Label htmlFor="veteran">Veteran</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="active_duty_military" name="active_duty_military" checked={formData.active_duty_military} onCheckedChange={(checked) => handleChange({ target: { name: 'active_duty_military', type: 'checkbox', checked } })} />
                  <Label htmlFor="active_duty_military">Active Duty Military</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="national_guard" name="national_guard" checked={formData.national_guard} onCheckedChange={(checked) => handleChange({ target: { name: 'national_guard', type: 'checkbox', checked } })} />
                  <Label htmlFor="national_guard">National Guard / Reserve</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="disabled_veteran" name="disabled_veteran" checked={formData.disabled_veteran} onCheckedChange={(checked) => handleChange({ target: { name: 'disabled_veteran', type: 'checkbox', checked } })} />
                  <Label htmlFor="disabled_veteran">Disabled Veteran</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="military_spouse" name="military_spouse" checked={formData.military_spouse} onCheckedChange={(checked) => handleChange({ target: { name: 'military_spouse', type: 'checkbox', checked } })} />
                  <Label htmlFor="military_spouse">Military Spouse</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="military_dependent" name="military_dependent" checked={formData.military_dependent} onCheckedChange={(checked) => handleChange({ target: { name: 'military_dependent', type: 'checkbox', checked } })} />
                  <Label htmlFor="military_dependent">Military Dependent</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="gold_star_family" name="gold_star_family" checked={formData.gold_star_family} onCheckedChange={(checked) => handleChange({ target: { name: 'gold_star_family', type: 'checkbox', checked } })} />
                  <Label htmlFor="gold_star_family">Gold Star Family Member</Label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Occupation & Work */}
          <Card className="border-purple-200">
            <CardHeader className="bg-purple-50">
              <CardTitle className="text-base text-purple-900">Occupation & Work</CardTitle>
              <CardDescription className="text-xs">Check all that apply</CardDescription>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              {/* Healthcare Worker */}
              <div className="space-y-2 p-3 bg-white rounded border border-purple-200">
                <div className="flex items-center space-x-2">
                  <Checkbox id="healthcare_worker" name="healthcare_worker" checked={formData.healthcare_worker} onCheckedChange={(checked) => handleChange({ target: { name: 'healthcare_worker', type: 'checkbox', checked } })} />
                  <Label htmlFor="healthcare_worker" className="font-semibold">Healthcare Worker</Label>
                </div>

                {formData.healthcare_worker && (
                  <div className="mt-3 ml-6">
                    <Label htmlFor="healthcare_worker_type">Type of Healthcare Worker</Label>
                    <Input
                      id="healthcare_worker_type"
                      name="healthcare_worker_type"
                      value={formData.healthcare_worker_type || ""}
                      onChange={handleChange}
                      placeholder="e.g., Nurse, Doctor, Medical Assistant"
                    />
                  </div>
                )}
              </div>

              {/* Other Occupations */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="ems_worker" name="ems_worker" checked={formData.ems_worker} onCheckedChange={(checked) => handleChange({ target: { name: 'ems_worker', type: 'checkbox', checked } })} />
                  <Label htmlFor="ems_worker">EMS Worker / First Responder</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="educator" name="educator" checked={formData.educator} onCheckedChange={(checked) => handleChange({ target: { name: 'educator', type: 'checkbox', checked } })} />
                  <Label htmlFor="educator">Teacher / Educator</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="firefighter" name="firefighter" checked={formData.firefighter} onCheckedChange={(checked) => handleChange({ target: { name: 'firefighter', type: 'checkbox', checked } })} />
                  <Label htmlFor="firefighter">Firefighter</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="law_enforcement" name="law_enforcement" checked={formData.law_enforcement} onCheckedChange={(checked) => handleChange({ target: { name: 'law_enforcement', type: 'checkbox', checked } })} />
                  <Label htmlFor="law_enforcement">Law Enforcement Officer</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="public_servant" name="public_servant" checked={formData.public_servant} onCheckedChange={(checked) => handleChange({ target: { name: 'public_servant', type: 'checkbox', checked } })} />
                  <Label htmlFor="public_servant">Public Servant / Government Employee</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="clergy" name="clergy" checked={formData.clergy} onCheckedChange={(checked) => handleChange({ target: { name: 'clergy', type: 'checkbox', checked } })} />
                  <Label htmlFor="clergy">Clergy / Minister / Religious Worker</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="missionary" name="missionary" checked={formData.missionary} onCheckedChange={(checked) => handleChange({ target: { name: 'missionary', type: 'checkbox', checked } })} />
                  <Label htmlFor="missionary">Missionary / Evangelist</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="nonprofit_employee" name="nonprofit_employee" checked={formData.nonprofit_employee} onCheckedChange={(checked) => handleChange({ target: { name: 'nonprofit_employee', type: 'checkbox', checked } })} />
                  <Label htmlFor="nonprofit_employee">Nonprofit Employee</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="small_business_owner" name="small_business_owner" checked={formData.small_business_owner} onCheckedChange={(checked) => handleChange({ target: { name: 'small_business_owner', type: 'checkbox', checked } })} />
                  <Label htmlFor="small_business_owner">Small Business Owner</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="minority_owned_business" name="minority_owned_business" checked={formData.minority_owned_business} onCheckedChange={(checked) => handleChange({ target: { name: 'minority_owned_business', type: 'checkbox', checked } })} />
                  <Label htmlFor="minority_owned_business">Minority-Owned Business</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="women_owned_business" name="women_owned_business" checked={formData.women_owned_business} onCheckedChange={(checked) => handleChange({ target: { name: 'women_owned_business', type: 'checkbox', checked } })} />
                  <Label htmlFor="women_owned_business">Women-Owned Business</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="union_member" name="union_member" checked={formData.union_member} onCheckedChange={(checked) => handleChange({ target: { name: 'union_member', type: 'checkbox', checked } })} />
                  <Label htmlFor="union_member">Union Member</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="farmer" name="farmer" checked={formData.farmer} onCheckedChange={(checked) => handleChange({ target: { name: 'farmer', type: 'checkbox', checked } })} />
                  <Label htmlFor="farmer">Farmer / Agricultural Worker</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="truck_driver" name="truck_driver" checked={formData.truck_driver} onCheckedChange={(checked) => handleChange({ target: { name: 'truck_driver', type: 'checkbox', checked } })} />
                  <Label htmlFor="truck_driver">Truck Driver / Transportation Worker</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="unemployed" name="unemployed" checked={formData.unemployed} onCheckedChange={(checked) => handleChange({ target: { name: 'unemployed', type: 'checkbox', checked } })} />
                  <Label htmlFor="unemployed">Currently Unemployed</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="displaced_worker" name="displaced_worker" checked={formData.displaced_worker} onCheckedChange={(checked) => handleChange({ target: { name: 'displaced_worker', type: 'checkbox', checked } })} />
                  <Label htmlFor="displaced_worker">Displaced Worker</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox id="job_retraining" name="job_retraining" checked={formData.job_retraining} onCheckedChange={(checked) => handleChange({ target: { name: 'job_retraining', type: 'checkbox', checked } })} />
                  <Label htmlFor="job_retraining">Job Retraining Participant</Label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Education & Student Status */}
          <Card className="border-yellow-200">
            <CardHeader className="bg-yellow-50">
              <CardTitle className="text-base text-yellow-900">Education & Student Status</CardTitle>
              <CardDescription className="text-xs">Check all that apply to the student or family</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="ged_graduate" name="ged_graduate" checked={formData.ged_graduate} onCheckedChange={(checked) => handleChange({ target: { name: 'ged_graduate', type: 'checkbox', checked } })} />
                  <Label htmlFor="ged_graduate">GED Graduate</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="returning_adult_student" name="returning_adult_student" checked={formData.returning_adult_student} onCheckedChange={(checked) => handleChange({ target: { name: 'returning_adult_student', type: 'checkbox', checked } })} />
                  <Label htmlFor="returning_adult_student">Returning Adult Student</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="stem_student" name="stem_student" checked={formData.stem_student} onCheckedChange={(checked) => handleChange({ target: { name: 'stem_student', type: 'checkbox', checked } })} />
                  <Label htmlFor="stem_student">STEM Student</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="recent_graduate" name="recent_graduate" checked={formData.recent_graduate} onCheckedChange={(checked) => handleChange({ target: { name: 'recent_graduate', type: 'checkbox', checked } })} />
                  <Label htmlFor="recent_graduate">Recent Graduate (last 2 years)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="pell_eligible" name="pell_eligible" checked={formData.pell_eligible} onCheckedChange={(checked) => handleChange({ target: { name: 'pell_eligible', type: 'checkbox', checked } })} />
                  <Label htmlFor="pell_eligible">Pell Grant Eligible</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="fafsa_completed" name="fafsa_completed" checked={formData.fafsa_completed} onCheckedChange={(checked) => handleChange({ target: { name: 'fafsa_completed', type: 'checkbox', checked } })} />
                  <Label htmlFor="fafsa_completed">FAFSA Completed</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="student_with_dependents" name="student_with_dependents" checked={formData.student_with_dependents} onCheckedChange={(checked) => handleChange({ target: { name: 'student_with_dependents', type: 'checkbox', checked } })} />
                  <Label htmlFor="student_with_dependents">Student with Dependents</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="homeschool_family" name="homeschool_family" checked={formData.homeschool_family} onCheckedChange={(checked) => handleChange({ target: { name: 'homeschool_family', type: 'checkbox', checked } })} />
                  <Label htmlFor="homeschool_family">Homeschool Family</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="private_school_student" name="private_school_student" checked={formData.private_school_student} onCheckedChange={(checked) => handleChange({ target: { name: 'private_school_student', type: 'checkbox', checked } })} />
                  <Label htmlFor="private_school_student">Private School Student</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="charter_school_student" name="charter_school_student" checked={formData.charter_school_student} onCheckedChange={(checked) => handleChange({ target: { name: 'charter_school_student', type: 'checkbox', checked } })} />
                  <Label htmlFor="charter_school_student">Charter School Student</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="virtual_academy_student" name="virtual_academy_student" checked={formData.virtual_academy_student} onCheckedChange={(checked) => handleChange({ target: { name: 'virtual_academy_student', type: 'checkbox', checked } })} />
                  <Label htmlFor="virtual_academy_student">Virtual Academy Student</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="parent_led_education" name="parent_led_education" checked={formData.parent_led_education} onCheckedChange={(checked) => handleChange({ target: { name: 'parent_led_education', type: 'checkbox', checked } })} />
                  <Label htmlFor="parent_led_education">Parent-Led Education</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="homeschool_coop_member" name="homeschool_coop_member" checked={formData.homeschool_coop_member} onCheckedChange={(checked) => handleChange({ target: { name: 'homeschool_coop_member', type: 'checkbox', checked } })} />
                  <Label htmlFor="homeschool_coop_member">Homeschool Cooperative Member</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="esa_eligible" name="esa_eligible" checked={formData.esa_eligible} onCheckedChange={(checked) => handleChange({ target: { name: 'esa_eligible', type: 'checkbox', checked } })} />
                  <Label htmlFor="esa_eligible">ESA Eligible</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="education_choice_participant" name="education_choice_participant" checked={formData.education_choice_participant} onCheckedChange={(checked) => handleChange({ target: { name: 'education_choice_participant', type: 'checkbox', checked } })} />
                  <Label htmlFor="education_choice_participant">Education Choice Program Participant</Label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Financial & Housing Status */}
          <Card className="border-orange-200">
            <CardHeader className="bg-orange-50">
              <CardTitle className="text-base text-orange-900">Financial & Housing Status</CardTitle>
              <CardDescription className="text-xs">Check all that apply</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="uninsured" name="uninsured" checked={formData.uninsured} onCheckedChange={(checked) => handleChange({ target: { name: 'uninsured', type: 'checkbox', checked } })} />
                  <Label htmlFor="uninsured">Uninsured (Health)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="underemployed" name="underemployed" checked={formData.underemployed} onCheckedChange={(checked) => handleChange({ target: { name: 'underemployed', type: 'checkbox', checked } })} />
                  <Label htmlFor="underemployed">Underemployed</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="medical_debt" name="medical_debt" checked={formData.medical_debt} onCheckedChange={(checked) => handleChange({ target: { name: 'medical_debt', type: 'checkbox', checked } })} />
                  <Label htmlFor="medical_debt">Medical Debt</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="education_debt" name="education_debt" checked={formData.education_debt} onCheckedChange={(checked) => handleChange({ target: { name: 'education_debt', type: 'checkbox', checked } })} />
                  <Label htmlFor="education_debt">Education Debt</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="bankruptcy" name="bankruptcy" checked={formData.bankruptcy} onCheckedChange={(checked) => handleChange({ target: { name: 'bankruptcy', type: 'checkbox', checked } })} />
                  <Label htmlFor="bankruptcy">Filed for Bankruptcy</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="first_time_homebuyer" name="first_time_homebuyer" checked={formData.first_time_homebuyer} onCheckedChange={(checked) => handleChange({ target: { name: 'first_time_homebuyer', type: 'checkbox', checked } })} />
                  <Label htmlFor="first_time_homebuyer">First-Time Homebuyer</Label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Geographic & Economic Factors */}
          <Card className="border-teal-200">
            <CardHeader className="bg-teal-50">
              <CardTitle className="text-base text-teal-900">Geographic & Economic Factors</CardTitle>
              <CardDescription className="text-xs">Check all that apply to the applicant's location</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox id="rural_resident" name="rural_resident" checked={formData.rural_resident} onCheckedChange={(checked) => handleChange({ target: { name: 'rural_resident', type: 'checkbox', checked } })} />
                  <Label htmlFor="rural_resident">Rural Resident</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="appalachian_region" name="appalachian_region" checked={formData.appalachian_region} onCheckedChange={(checked) => handleChange({ target: { name: 'appalachian_region', type: 'checkbox', checked } })} />
                  <Label htmlFor="appalachian_region">Appalachian Region</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="urban_underserved" name="urban_underserved" checked={formData.urban_underserved} onCheckedChange={(checked) => handleChange({ target: { name: 'urban_underserved', type: 'checkbox', checked } })} />
                  <Label htmlFor="urban_underserved">Urban Underserved Area</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="qct" name="qct" checked={formData.qct} onCheckedChange={(checked) => handleChange({ target: { name: 'qct', type: 'checkbox', checked } })} />
                  <Label htmlFor="qct">Qualified Census Tract (QCT)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="opportunity_zone" name="opportunity_zone" checked={formData.opportunity_zone} onCheckedChange={(checked) => handleChange({ target: { name: 'opportunity_zone', type: 'checkbox', checked } })} />
                  <Label htmlFor="opportunity_zone">Opportunity Zone</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="ej_area" name="ej_area" checked={formData.ej_area} onCheckedChange={(checked) => handleChange({ target: { name: 'ej_area', type: 'checkbox', checked } })} />
                  <Label htmlFor="ej_area">Environmental Justice Area (EJ)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="persistent_poverty_county" name="persistent_poverty_county" checked={formData.persistent_poverty_county} onCheckedChange={(checked) => handleChange({ target: { name: 'persistent_poverty_county', type: 'checkbox', checked } })} />
                  <Label htmlFor="persistent_poverty_county">Persistent Poverty County</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="tribal_land" name="tribal_land" checked={formData.tribal_land} onCheckedChange={(checked) => handleChange({ target: { name: 'tribal_land', type: 'checkbox', checked } })} />
                  <Label htmlFor="tribal_land">Tribal Land</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="us_territory" name="us_territory" checked={formData.us_territory} onCheckedChange={(checked) => handleChange({ target: { name: 'us_territory', type: 'checkbox', checked } })} />
                  <Label htmlFor="us_territory">U.S. Territory</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox id="fema_disaster_area" name="fema_disaster_area" checked={formData.fema_disaster_area} onCheckedChange={(checked) => handleChange({ target: { name: 'fema_disaster_area', type: 'checkbox', checked } })} />
                  <Label htmlFor="fema_disaster_area">FEMA Declared Disaster Area</Label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Special Organization Classifications (visible if isOrganization is true, but inside isIndividual to follow comprehensive pattern) */}
          {isOrganization && (
            <Card className="border-cyan-200">
              <CardHeader className="bg-cyan-50">
                <CardTitle className="text-base text-cyan-900">Special Organization Classifications</CardTitle>
                <CardDescription className="text-xs">Check all relevant classifications for this organization</CardDescription>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
                  <div className="flex items-center space-x-2">
                    <Checkbox id="business_affected_covid" name="business_affected_covid" checked={formData.business_affected_covid} onCheckedChange={(checked) => handleChange({ target: { name: 'business_affected_covid', type: 'checkbox', checked } })} />
                    <Label htmlFor="business_affected_covid">Business Affected by COVID-19</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="fqhc" name="fqhc" checked={formData.fqhc} onCheckedChange={(checked) => handleChange({ target: { name: 'fqhc', type: 'checkbox', checked } })} />
                    <Label htmlFor="fqhc">Federally Qualified Health Center (FQHC)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="community_action_agency" name="community_action_agency" checked={formData.community_action_agency} onCheckedChange={(checked) => handleChange({ target: { name: 'community_action_agency', type: 'checkbox', checked } })} />
                    <Label htmlFor="community_action_agency">Community Action Agency</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="cdc_org" name="cdc_org" checked={formData.cdc_org} onCheckedChange={(checked) => handleChange({ target: { name: 'cdc_org', type: 'checkbox', checked } })} />
                    <Label htmlFor="cdc_org">Community Development Corporation (CDC)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="housing_authority" name="housing_authority" checked={formData.housing_authority} onCheckedChange={(checked) => handleChange({ target: { name: 'housing_authority', type: 'checkbox', checked } })} />
                    <Label htmlFor="housing_authority">Housing Authority</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="workforce_board" name="workforce_board" checked={formData.workforce_board} onCheckedChange={(checked) => handleChange({ target: { name: 'workforce_board', type: 'checkbox', checked } })} />
                    <Label htmlFor="workforce_board">Workforce Development Board</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="veterans_service_org" name="veterans_service_org" checked={formData.veterans_service_org} onCheckedChange={(checked) => handleChange({ target: { name: 'veterans_service_org', type: 'checkbox', checked } })} />
                    <Label htmlFor="veterans_service_org">Veterans Service Organization</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="volunteer_fire_ems" name="volunteer_fire_ems" checked={formData.volunteer_fire_ems} onCheckedChange={(checked) => handleChange({ target: { name: 'volunteer_fire_ems', type: 'checkbox', checked } })} />
                    <Label htmlFor="volunteer_fire_ems">Volunteer Fire/EMS Dept</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="research_institute" name="research_institute" checked={formData.research_institute} onCheckedChange={(checked) => handleChange({ target: { name: 'research_institute', type: 'checkbox', checked } })} />
                    <Label htmlFor="research_institute">Research Institute</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="cooperative" name="cooperative" checked={formData.cooperative} onCheckedChange={(checked) => handleChange({ target: { name: 'cooperative', type: 'checkbox', checked } })} />
                    <Label htmlFor="cooperative">Cooperative</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="cdfi_partner" name="cdfi_partner" checked={formData.cdfi_partner} onCheckedChange={(checked) => handleChange({ target: { name: 'cdfi_partner', type: 'checkbox', checked } })} />
                    <Label htmlFor="cdfi_partner">CDFI Partner</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="msi_institution" name="msi_institution" checked={formData.msi_institution} onCheckedChange={(checked) => handleChange({ target: { name: 'msi_institution', type: 'checkbox', checked } })} />
                    <Label htmlFor="msi_institution">Minority Serving Institution (MSI)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="rural_health_clinic" name="rural_health_clinic" checked={formData.rural_health_clinic} onCheckedChange={(checked) => handleChange({ target: { name: 'rural_health_clinic', type: 'checkbox', checked } })} />
                    <Label htmlFor="rural_health_clinic">Rural Health Clinic</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="environmental_org" name="environmental_org" checked={formData.environmental_org} onCheckedChange={(checked) => handleChange({ target: { name: 'environmental_org', type: 'checkbox', checked } })} />
                    <Label htmlFor="environmental_org">Environmental Organization</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="labor_union_org" name="labor_union_org" checked={formData.labor_union_org} onCheckedChange={(checked) => handleChange({ target: { name: 'labor_union_org', type: 'checkbox', checked } })} />
                    <Label htmlFor="labor_union_org">Labor Union Organization</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="agricultural_extension" name="agricultural_extension" checked={formData.agricultural_extension} onCheckedChange={(checked) => handleChange({ target: { name: 'agricultural_extension', type: 'checkbox', checked } })} />
                    <Label htmlFor="agricultural_extension">Agricultural Extension</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="business_8a" name="business_8a" checked={formData.business_8a} onCheckedChange={(checked) => handleChange({ target: { name: 'business_8a', type: 'checkbox', checked } })} />
                    <Label htmlFor="business_8a">8(a) Business Development Program</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="sdvosb" name="sdvosb" checked={formData.sdvosb} onCheckedChange={(checked) => handleChange({ target: { name: 'sdvosb', type: 'checkbox', checked } })} />
                    <Label htmlFor="sdvosb">Service-Disabled Veteran-Owned Small Business (SDVOSB)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="hubzone" name="hubzone" checked={formData.hubzone} onCheckedChange={(checked) => handleChange({ target: { name: 'hubzone', type: 'checkbox', checked } })} />
                    <Label htmlFor="hubzone">HUBZone Business</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="dbe" name="dbe" checked={formData.dbe} onCheckedChange={(checked) => handleChange({ target: { name: 'dbe', type: 'checkbox', checked } })} />
                    <Label htmlFor="dbe">Disadvantaged Business Enterprise (DBE)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="mbe" name="mbe" checked={formData.mbe} onCheckedChange={(checked) => handleChange({ target: { name: 'mbe', type: 'checkbox', checked } })} />
                    <Label htmlFor="mbe">Minority Business Enterprise (MBE)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="wbe" name="wbe" checked={formData.wbe} onCheckedChange={(checked) => handleChange({ target: { name: 'wbe', type: 'checkbox', checked } })} />
                    <Label htmlFor="wbe">Women Business Enterprise (WBE)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="sbe" name="sbe" checked={formData.sbe} onCheckedChange={(checked) => handleChange({ target: { name: 'sbe', type: 'checkbox', checked } })} />
                    <Label htmlFor="sbe">Small Business Enterprise (SBE)</Label>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <AIFormField
            label="Special Circumstances"
            name="special_circumstances"
            value={formData.special_circumstances}
            onChange={handleChange}
            placeholder="Describe any special medical conditions, family situations, or other circumstances."
            aiPrompt={`Based on the following profile context, generate a compelling and concise draft for the "special circumstances" section.

PROFILE CONTEXT:
---
${Object.entries(formData)
  .filter(([key, value]) => value && typeof value === 'string' && value.trim() !== '')
  .map(([key, value]) => `- ${key.replace(/_/g, ' ')}: ${value}`)
  .join('\n')}
---

DRAFT for "special circumstances":`}
            organization={formData}
          >
            <Textarea name="special_circumstances" value={formData.special_circumstances} onChange={handleChange} placeholder="Describe any special medical conditions, family situations, or other circumstances." className="h-28" />
          </AIFormField>
        </div>
      )}

      {isStudent && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GraduationCap className="w-5 h-5" />
              Student Activities & Achievements
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Extracurricular Activities</Label>
              <MultiSelectCombobox
                options={[]}
                selected={formData.extracurricular_activities || []}
                onSelectedChange={(values) => handleArrayChange('extracurricular_activities', values)}
                placeholder="Type to add activities (e.g., Soccer, Band, Debate)..."
                allowCustom
              />
            </div>
            <div className="space-y-2">
              <Label>Awards & Achievements</Label>
              <MultiSelectCombobox
                options={[]}
                selected={formData.achievements || []}
                onSelectedChange={(values) => handleArrayChange('achievements', values)}
                placeholder="Type to add achievements..."
                allowCustom
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="community_service_hours">Community Service Hours</Label>
              <Input
                id="community_service_hours"
                name="community_service_hours"
                type="number"
                value={formData.community_service_hours || ""}
                onChange={handleChange}
                placeholder="150"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {isOrganization && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              Organization Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* These fields were duplicated from Basic Info, keeping them for consistency with the outline structure */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="annual_budget">Annual Budget</Label>
                <Input
                  id="annual_budget"
                  name="annual_budget"
                  type="number"
                  value={formData.annual_budget || ""}
                  onChange={handleChange}
                  placeholder="500000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="staff_count">Staff Count</Label>
                <Input
                  id="staff_count"
                  name="staff_count"
                  type="number"
                  value={formData.staff_count || ""}
                  onChange={handleChange}
                  placeholder="12"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="uei" className="flex items-center gap-1">
                UEI (Unique Entity Identifier)
                <FieldHelpTip id="organization.uei" />
              </Label>
              <Input id="uei" name="uei" value={formData.uei} onChange={handleChange} placeholder="SAM.gov UEI" />
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center space-x-2">
                <Checkbox id="sam_registered" name="sam_registered" checked={formData.sam_registered} onCheckedChange={(checked) => handleChange({ target: { name: 'sam_registered', type: 'checkbox', checked } })} />
                <Label htmlFor="sam_registered" className="flex items-center gap-1">
                  SAM.gov Registered
                  <FieldHelpTip id="organization.sam_registered" />
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox id="faith_based" name="faith_based" checked={formData.faith_based} onCheckedChange={(checked) => handleChange({ target: { name: 'faith_based', type: 'checkbox', checked } })} />
                <Label htmlFor="faith_based" className="flex items-center gap-1">
                  Faith-Based
                  <FieldHelpTip id="organization.faith_based" />
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox id="rural" name="rural" checked={formData.rural} onCheckedChange={(checked) => handleChange({ target: { name: 'rural', type: 'checkbox', checked } })} />
                <Label htmlFor="rural">Rural</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox id="minority_serving" name="minority_serving" checked={formData.minority_serving} onCheckedChange={(checked) => handleChange({ target: { name: 'minority_serving', type: 'checkbox', checked } })} />
                <Label htmlFor="minority_serving">Minority-Serving</Label>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Additional Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Keywords</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleSuggestKeywords}
                disabled={isHarvesting || isSubmitting}
                className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
              >
                {isHarvesting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Suggest with AI
                  </>
                )}
              </Button>
            </div>
            <MultiSelectCombobox
              options={[]}
              selected={formData.keywords || []}
              onSelectedChange={(values) => handleArrayChange('keywords', values)}
              placeholder={getPlaceholder(
                'Type keywords for search (e.g., education, healthcare)...',
                'Type keywords (e.g., stem, scholarship, medical)...'
              )}
              allowCustom
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Focus Areas / Interests</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleSuggestFocusAreas}
                disabled={isHarvesting || isSubmitting}
                className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
              >
                {isHarvesting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Suggest with AI
                  </>
                )}
              </Button>
            </div>
            <MultiSelectCombobox
              options={[]}
              selected={formData.focus_areas || []}
              onSelectedChange={(values) => handleArrayChange('focus_areas', values)}
              placeholder={getPlaceholder(
                'Type focus areas (e.g., youth development, mental health)...',
                'Type your interests (e.g., forensic science, community service)...'
              )}
              allowCustom
            />
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox id="veteran" name="veteran" checked={formData.veteran} onCheckedChange={(checked) => handleChange({ target: { name: 'veteran', type: 'checkbox', checked } })} />
            <Label htmlFor="veteran">{getLabel('Veteran-Owned/Led', 'Veteran / Military Family')}</Label>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3 pt-8 border-t">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting} className="bg-blue-600 hover:bg-blue-700">
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            organization ? 'Update Profile' : 'Create Profile'
          )}
        </Button>
      </div>
    </form>
  );
}
