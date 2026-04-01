import React, { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { 
  User, GraduationCap, Heart, Briefcase, MapPin, FileText, 
  CheckCircle, ChevronRight, ChevronLeft, Upload, AlertCircle, Mail, Printer 
} from "lucide-react";
import MultiSelectCombobox from "../shared/MultiSelectCombobox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { apiFetch } from "@/api/client";

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

const GRADE_LEVELS = [
  { value: 'high_school_freshman', label: 'High School Freshman (9th)' },
  { value: 'high_school_sophomore', label: 'High School Sophomore (10th)' },
  { value: 'high_school_junior', label: 'High School Junior (11th)' },
  { value: 'high_school_senior', label: 'High School Senior (12th)' },
  { value: 'college_freshman', label: 'College Freshman' },
  { value: 'college_sophomore', label: 'College Sophomore' },
  { value: 'college_junior', label: 'College Junior' },
  { value: 'college_senior', label: 'College Senior' },
  { value: 'graduate', label: 'Graduate Student' },
];

export default function ComprehensiveApplicationForm({ onSubmit, onCancel, isSubmitting, initialData = null }) {
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(0);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const appliedInitialDataRef = useRef(false);

  const [formData, setFormData] = useState(() => ({
    // Basic Info
    name: "",
    date_of_birth: "",
    email: [],
    phone: [],
    address: "",
    city: "",
    state: "",
    zip: "",
    age: null, // Added age field

    // Profile Type
    applicant_type: "",
    
    // Organization Fields
    nonprofit_type: "",
    organization_ein: "",
    organization_uei: "",
    organization_cage_code: "",
    annual_budget: null,
    staff_count: null,
    website: "",
    ntee_code: "",
    evidence_based_program: "",
    sam_gov_registered: false,
    grants_gov_active: false,
    hipaa_compliant: false,
    ferpa_compliant: false,
    faith_based_organization: false,
    serves_rural_area: false,
    liability_insurance: false,
    liability_coverage_limit: "",
    directors_officers_insurance: false,
    workers_comp_insurance: false,
    professional_liability_insurance: false,
    business_501c3_certified: false,
    business_501c4_certified: false,
    minority_owned_certification: false,
    women_owned_certification: false,
    veteran_owned_business: false,
    promise_zone_designation: false,
    opportunity_zone_designation: false,
    
    // Student Fields
    student_grade_levels: [],
    current_college: "",
    target_colleges: [],
    gpa: null,
    act_score: null,
    sat_score: null,
    intended_major: "",
    first_generation: false,
    stem_student: false,
    extracurricular_activities: [],
    achievements: [],
    community_service_hours: null,
    
    // Financial
    household_income: null,
    household_size: null,
    financial_need_level: "",
    low_income: false,
    unemployed: false,
    displaced_worker: false,
    
    // Government Assistance
    medicaid_enrolled: false,
    medicaid_waiver_program: "none",
    medicare_recipient: false,
    ssi_recipient: false,
    ssdi_recipient: false,
    snap_recipient: false,
    tanf_recipient: false,
    section8_housing: false,
    tenncare_id: "",
    
    // Immigration & Citizenship
    immigration_status: "us_citizen",
    permanent_resident: false,
    refugee: false,
    new_immigrant: false,
    
    // Demographics
    african_american: false,
    hispanic_latino: false,
    asian_american: false,
    native_american: false,
    tribal_affiliation: "",
    lgbtq: false,
    
    // Health & Medical
    cancer_survivor: false,
    cancer_type: "",
    cancer_diagnosis_year: null,
    chronic_illness: false,
    chronic_illness_type: "",
    disability_type: [],
    support_needs_level: "",
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
    
    // Family & Life Situation
    single_parent: false,
    foster_youth: false,
    orphan: false,
    adopted: false,
    foster_parent: false,
    caregiver: false,
    widow_widower: false,
    grandparent_raising_grandchildren: false,
    first_time_parent: false,
    homeless: false,
    
    // Trauma & Recovery
    domestic_violence_survivor: false,
    trafficking_survivor: false,
    disaster_survivor: false,
    formerly_incarcerated: false,
    
    // Military
    veteran: false,
    active_duty_military: false,
    national_guard: false,
    disabled_veteran: false,
    military_spouse: false,
    military_dependent: false,
    gold_star_family: false,
    
    // Occupation
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
    is_minority_owned_business_owner: false,
    is_women_owned_business_owner: false,
    union_member: false,
    farmer: false,
    truck_driver: false,
    
    // Education Level
    ged_graduate: false,
    returning_adult_student: false,
    recent_graduate: false,
    job_retraining: false,
    
    // Geographic
    rural_resident: false,
    appalachian_region: false,
    urban_underserved: false,
    
    // Other
    minor_child: false,
    young_adult: false,
    business_affected_covid: false,
    
    // Firearms / Second Amendment
    second_amendment_supporter: false,
    gun_owner: false,
    concealed_carry_permit: false,
    nra_member: false,
    firearm_instructor: false,
    competitive_shooter: false,
    hunting_license: false,
    
    // Political / Civic Engagement
    registered_voter: false,
    political_party: "",
    politically_active: false,
    community_organizer: false,
    advocacy_work: false,
    civic_volunteer: false,
    election_worker: false,
    
    // Profile Narrative
    mission: "",
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
    special_circumstances: "",
    keywords: [],
    focus_areas: [],
    ...(initialData && typeof initialData === "object" ? initialData : {}),
  }));

  useEffect(() => {
    if (appliedInitialDataRef.current) return;
    if (!initialData || typeof initialData !== "object") return;
    setFormData((prev) => ({ ...prev, ...initialData }));
    appliedInitialDataRef.current = true;
  }, [initialData]);

  const steps = [
    { 
      id: 'type', 
      title: 'Profile Type', 
      icon: User,
      description: 'What type of applicant are you?'
    },
    { 
      id: 'basic', 
      title: 'Basic Information', 
      icon: User,
      description: 'Your personal information'
    },
    { 
      id: 'organization', 
      title: 'Organization Details', 
      icon: Briefcase,
      description: 'Organization information',
      show: () => formData.applicant_type === 'organization'
    },
    { 
      id: 'student', 
      title: 'Education', 
      icon: GraduationCap,
      description: 'Academic background',
      show: () => ['high_school_student', 'college_student', 'graduate_student'].includes(formData.applicant_type)
    },
    { 
      id: 'financial', 
      title: 'Financial Situation', 
      icon: Briefcase,
      description: 'Income and financial need'
    },
    { 
      id: 'assistance', 
      title: 'Government Assistance', 
      icon: Heart,
      description: 'Benefits you receive'
    },
    { 
      id: 'health', 
      title: 'Health & Medical', 
      icon: Heart,
      description: 'Health conditions and needs'
    },
    { 
      id: 'demographics', 
      title: 'Demographics', 
      icon: User,
      description: 'Background information'
    },
    { 
      id: 'family', 
      title: 'Family & Life', 
      icon: Heart,
      description: 'Family situation'
    },
    { 
      id: 'military', 
      title: 'Military Status', 
      icon: Briefcase,
      description: 'Military service'
    },
    { 
      id: 'occupation', 
      title: 'Occupation', 
      icon: Briefcase,
      description: 'Your profession'
    },
    { 
      id: 'firearms', 
      title: 'Firearms / 2nd Amendment', 
      icon: Briefcase,
      description: 'Firearms and hunting',
      show: () => formData.applicant_type !== 'organization'
    },
    { 
      id: 'political', 
      title: 'Political / Civic', 
      icon: User,
      description: 'Civic engagement',
      show: () => formData.applicant_type !== 'organization'
    },
    { 
      id: 'location', 
      title: 'Location', 
      icon: MapPin,
      description: 'Where you live'
    },
    { 
      id: 'narrative', 
      title: 'Your Story', 
      icon: FileText,
      description: 'Tell us about yourself'
    },
    { 
      id: 'documents', 
      title: 'Documents', 
      icon: Upload,
      description: 'Upload supporting documents'
    },
    { 
      id: 'review', 
      title: 'Review', 
      icon: CheckCircle,
      description: 'Review and submit'
    }
  ];

  const visibleSteps = steps.filter(step => !step.show || step.show());
  const progress = ((currentStep + 1) / visibleSteps.length) * 100;

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleNext = () => {
    if (currentStep < visibleSteps.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    // Calculate age from date of birth if provided
    let finalData = { ...formData };
    if (finalData.date_of_birth && !finalData.age) {
      const birthDate = new Date(finalData.date_of_birth);
      const today = new Date();
      const age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        finalData.age = age - 1;
      } else {
        finalData.age = age;
      }
    }
    
    onSubmit(finalData);
  };

  const handlePrintPDF = () => {
    window.print();
  };

  const handleEmailApplication = async () => {
    if (!formData.name) {
      toast({
        title: "Name Required",
        description: "Please enter your name before sending the application.",
        variant: "destructive",
      });
      return;
    }

    setIsSendingEmail(true);
    try {
      function computeAge(dateOfBirth) {
  if (!dateOfBirth) return null;
  const birthDate = new Date(dateOfBirth);
  const today = new Date();
  const age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    return age - 1;
  }
  return age;
}

// Inside the component, replace both duplicated blocks with:
const buildFinalData = (data) => ({
  ...data,
  age: data.age ?? computeAge(data.date_of_birth),
});

// handleSubmit becomes:
const handleSubmit = (e) => {
  e.preventDefault();
  onSubmit(buildFinalData(formData));
};

// handleEmailApplication uses:
const finalData = buildFinalData(formData);

      // Send via API - endpoint accepts application data without requiring profile ID
      await apiFetch('/api/profiles/send-application-email', {
        method: 'POST',
        body: JSON.stringify({
          applicationData: finalData
        }),
      });

      toast({
        title: "Application Sent!",
        description: "Your application has been emailed to Dr. John White.",
      });
    } catch (error) {
      console.error('Error sending application:', error);
      toast({
        title: "Failed to Send",
        description: error.message || "There was an error sending your application. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const currentStepData = visibleSteps[currentStep];
  const CurrentIcon = currentStepData.icon;

  const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(formData.applicant_type);

  return (
    <form onSubmit={handleSubmit} className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Progress Bar */}
      <div className="sticky top-0 bg-white z-10 pb-4 border-b">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-2xl font-bold">Comprehensive Application</h2>
          <Badge variant="outline">{currentStep + 1} of {visibleSteps.length}</Badge>
        </div>
        <Progress value={progress} className="h-2" />
        <div className="flex items-center gap-2 mt-3">
          <CurrentIcon className="w-5 h-5 text-blue-600" />
          <div>
            <p className="font-semibold">{currentStepData.title}</p>
            <p className="text-sm text-slate-600">{currentStepData.description}</p>
          </div>
        </div>
      </div>

      {/* Step Content */}
      <Card>
        <CardContent className="p-6 space-y-6">
          {/* STEP: Profile Type */}
          {currentStepData.id === 'type' && (
            <div className="space-y-4">
              <CardTitle>Who are you applying as?</CardTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { value: 'organization', label: 'Organization / Nonprofit', desc: 'Tax-exempt organization' },
                  { value: 'high_school_student', label: 'High School Student', desc: 'Currently in grades 9-12' },
                  { value: 'college_student', label: 'College Student', desc: 'Undergraduate student' },
                  { value: 'graduate_student', label: 'Graduate Student', desc: 'Masters or PhD' },
                  { value: 'individual_need', label: 'Individual', desc: 'Seeking personal assistance' },
                  { value: 'medical_assistance', label: 'Medical Need', desc: 'Medical or health assistance' },
                  { value: 'family', label: 'Family', desc: 'Family seeking assistance' },
                  { value: 'minister', label: 'Minister / Clergy', desc: 'Religious leader or missionary' },
                ].map(type => (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => handleChange('applicant_type', type.value)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      formData.applicant_type === type.value
                        ? 'border-blue-600 bg-blue-50'
                        : 'border-slate-200 hover:border-blue-300'
                    }`}
                  >
                    <p className="font-semibold">{type.label}</p>
                    <p className="text-sm text-slate-600 mt-1">{type.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* STEP: Basic Information */}
          {currentStepData.id === 'basic' && (
            <div className="space-y-4">
              <CardTitle>Basic Information</CardTitle>
              <div>
                <Label htmlFor="name">Full Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                  placeholder="John Doe"
                  required
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="date_of_birth">Date of Birth</Label>
                  <Input
                    id="date_of_birth"
                    type="date"
                    value={formData.date_of_birth}
                    onChange={(e) => handleChange('date_of_birth', e.target.value)}
                  />
                  <p className="text-xs text-slate-500 mt-1">Used to determine age-based eligibility</p>
                </div>
                <div>
                  <Label>Email Address</Label>
                  <MultiSelectCombobox
                    options={[]}
                    selected={formData.email}
                    onSelectedChange={(values) => handleChange('email', values)}
                    placeholder="your@email.com"
                    allowCustom
                  />
                </div>
              </div>
              <div>
                <Label>Phone Number</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.phone}
                  onSelectedChange={(values) => handleChange('phone', values)}
                  placeholder="(555) 123-4567"
                  allowCustom
                />
              </div>
            </div>
          )}

          {/* STEP: Organization Details (Organizations Only) */}
          {currentStepData.id === 'organization' && formData.applicant_type === 'organization' && (
            <div className="space-y-6">
              <CardTitle>Organization Details</CardTitle>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="organization_ein">EIN (Tax ID)</Label>
                  <Input
                    id="organization_ein"
                    value={formData.organization_ein}
                    onChange={(e) => handleChange('organization_ein', e.target.value)}
                    placeholder="12-3456789"
                  />
                </div>
                <div>
                  <Label htmlFor="organization_uei">UEI Number</Label>
                  <Input
                    id="organization_uei"
                    value={formData.organization_uei}
                    onChange={(e) => handleChange('organization_uei', e.target.value)}
                    placeholder="Unique Entity Identifier"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="organization_cage_code">CAGE Code</Label>
                  <Input
                    id="organization_cage_code"
                    value={formData.organization_cage_code}
                    onChange={(e) => handleChange('organization_cage_code', e.target.value)}
                    placeholder="Commercial and Government Entity Code"
                  />
                </div>
                <div>
                  <Label htmlFor="ntee_code">NTEE Code</Label>
                  <Input
                    id="ntee_code"
                    value={formData.ntee_code}
                    onChange={(e) => handleChange('ntee_code', e.target.value)}
                    placeholder="National Taxonomy of Exempt Entities"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="annual_budget">Annual Budget</Label>
                  <Input
                    id="annual_budget"
                    type="number"
                    value={formData.annual_budget || ""}
                    onChange={(e) => handleChange('annual_budget', parseFloat(e.target.value) || null)}
                    placeholder="500000"
                  />
                </div>
                <div>
                  <Label htmlFor="staff_count">Staff Count</Label>
                  <Input
                    id="staff_count"
                    type="number"
                    value={formData.staff_count || ""}
                    onChange={(e) => handleChange('staff_count', parseInt(e.target.value) || null)}
                    placeholder="15"
                  />
                </div>
                <div>
                  <Label htmlFor="website">Website</Label>
                  <Input
                    id="website"
                    type="url"
                    value={formData.website}
                    onChange={(e) => handleChange('website', e.target.value)}
                    placeholder="https://example.org"
                    pattern="https?://.+"
                    title="Must start with http:// or https://"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="evidence_based_program">Evidence-Based Program Model</Label>
                <Input
                  id="evidence_based_program"
                  value={formData.evidence_based_program}
                  onChange={(e) => handleChange('evidence_based_program', e.target.value)}
                  placeholder="e.g., PBIS, Trauma-Informed Care"
                />
              </div>

              {/* Federal Registration & Compliance */}
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-3">
                <h4 className="font-semibold">Federal Registration & Compliance</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'sam_gov_registered', label: 'SAM.gov Registered' },
                    { id: 'grants_gov_active', label: 'Grants.gov Account Active' },
                    { id: 'hipaa_compliant', label: 'HIPAA Compliant' },
                    { id: 'ferpa_compliant', label: 'FERPA Compliant' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id}>{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* General Qualifications */}
              <div className="space-y-3">
                <h4 className="font-semibold">General Qualifications</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'faith_based_organization', label: 'Faith-Based Organization' },
                    { id: 'serves_rural_area', label: 'Serves Rural Area' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id}>{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Insurance & Risk Management */}
              <div className="p-4 bg-green-50 rounded-lg border border-green-200 space-y-3">
                <h4 className="font-semibold">Insurance & Risk Management</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'liability_insurance', label: 'General Liability Insurance' },
                    { id: 'directors_officers_insurance', label: 'Directors & Officers Insurance' },
                    { id: 'workers_comp_insurance', label: 'Workers Compensation Insurance' },
                    { id: 'professional_liability_insurance', label: 'Professional Liability Insurance' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id}>{item.label}</Label>
                    </div>
                  ))}
                </div>
                {formData.liability_insurance && (
                  <div>
                    <Label htmlFor="liability_coverage_limit">Liability Coverage Limit</Label>
                    <Input
                      id="liability_coverage_limit"
                      value={formData.liability_coverage_limit}
                      onChange={(e) => handleChange('liability_coverage_limit', e.target.value)}
                      placeholder="e.g., $1,000,000"
                    />
                  </div>
                )}
              </div>

              {/* Business Certifications */}
              <div className="space-y-3">
                <h4 className="font-semibold">Business Certifications & Designations</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'business_501c3_certified', label: '501(c)(3) Certified' },
                    { id: 'business_501c4_certified', label: '501(c)(4) Certified' },
                    { id: 'minority_owned_certification', label: 'Minority-Owned Business Certification' },
                    { id: 'women_owned_certification', label: 'Women-Owned Business Certification' },
                    { id: 'veteran_owned_business', label: 'Veteran-Owned Business' },
                    { id: 'promise_zone_designation', label: 'Promise Zone Designation' },
                    { id: 'opportunity_zone_designation', label: 'Opportunity Zone Designation' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id}>{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP: Education (Students Only) */}
          {currentStepData.id === 'student' && isStudent && (
            <div className="space-y-4">
              <CardTitle>Education Details</CardTitle>
              <div>
                <Label>Grade Level(s) *</Label>
                <MultiSelectCombobox
                  options={GRADE_LEVELS}
                  selected={formData.student_grade_levels}
                  onSelectedChange={(values) => handleChange('student_grade_levels', values)}
                  placeholder="Select your grade level(s)"
                />
                <p className="text-xs text-slate-500 mt-1">Select all that apply</p>
              </div>
              
              {(formData.applicant_type === 'college_student' || formData.applicant_type === 'graduate_student') && (
                <>
                  <div>
                    <Label htmlFor="current_college">Current College/University</Label>
                    <Input
                      id="current_college"
                      value={formData.current_college}
                      onChange={(e) => handleChange('current_college', e.target.value)}
                      placeholder="e.g., University of Tennessee"
                    />
                  </div>
                  <div>
                    <Label>Target/Interested Colleges</Label>
                    <MultiSelectCombobox
                      options={[]}
                      selected={formData.target_colleges}
                      onSelectedChange={(values) => handleChange('target_colleges', values)}
                      placeholder="Add colleges you're interested in or applying to..."
                      allowCustom
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      List all colleges/universities you're interested in, applying to, or considering. This helps find school-specific scholarships.
                    </p>
                  </div>
                </>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="intended_major">Intended Major</Label>
                  <Input
                    id="intended_major"
                    value={formData.intended_major}
                    onChange={(e) => handleChange('intended_major', e.target.value)}
                    placeholder="e.g., Computer Science"
                  />
                </div>
                <div>
                  <Label htmlFor="gpa">GPA</Label>
                  <Input
                    id="gpa"
                    type="number"
                    step="0.01"
                    value={formData.gpa || ""}
                    onChange={(e) => handleChange('gpa', parseFloat(e.target.value) || null)}
                    placeholder="3.75"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <Label htmlFor="act_score">ACT Score</Label>
                  <Input
                    id="act_score"
                    type="number"
                    value={formData.act_score || ""}
                    onChange={(e) => handleChange('act_score', parseInt(e.target.value) || null)}
                    placeholder="32"
                  />
                </div>
                <div>
                  <Label htmlFor="sat_score">SAT Score</Label>
                  <Input
                    id="sat_score"
                    type="number"
                    value={formData.sat_score || ""}
                    onChange={(e) => handleChange('sat_score', parseInt(e.target.value) || null)}
                    placeholder="1450"
                  />
                </div>
                <div>
                  <Label htmlFor="community_service_hours">Service Hours</Label>
                  <Input
                    id="community_service_hours"
                    type="number"
                    value={formData.community_service_hours || ""}
                    onChange={(e) => handleChange('community_service_hours', parseInt(e.target.value) || null)}
                    placeholder="200"
                  />
                </div>
              </div>

              <div>
                <Label>Extracurricular Activities</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.extracurricular_activities}
                  onSelectedChange={(values) => handleChange('extracurricular_activities', values)}
                  placeholder="Add activities (soccer, band, debate, etc.)"
                  allowCustom
                />
              </div>

              <div>
                <Label>Awards & Achievements</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.achievements}
                  onSelectedChange={(values) => handleChange('achievements', values)}
                  placeholder="Add achievements..."
                  allowCustom
                />
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="first_generation"
                  checked={formData.first_generation}
                  onCheckedChange={(checked) => handleChange('first_generation', checked)}
                />
                <Label htmlFor="first_generation">I am a first-generation college student</Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="stem_student"
                  checked={formData.stem_student}
                  onCheckedChange={(checked) => handleChange('stem_student', checked)}
                />
                <Label htmlFor="stem_student">I am in a STEM field</Label>
              </div>
            </div>
          )}

          {/* STEP: Financial */}
          {currentStepData.id === 'financial' && (
            <div className="space-y-4">
              <CardTitle>Financial Situation</CardTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="household_income">Annual Household Income</Label>
                  <Input
                    id="household_income"
                    type="number"
                    value={formData.household_income || ""}
                    onChange={(e) => handleChange('household_income', parseFloat(e.target.value) || null)}
                    placeholder="50000"
                  />
                </div>
                <div>
                  <Label htmlFor="household_size">Household Size</Label>
                  <Input
                    id="household_size"
                    type="number"
                    value={formData.household_size || ""}
                    onChange={(e) => handleChange('household_size', parseInt(e.target.value) || null)}
                    placeholder="4"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="financial_need_level">Financial Need Level</Label>
                <Select
                  value={formData.financial_need_level}
                  onValueChange={(value) => handleChange('financial_need_level', value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select level..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="moderate">Moderate</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="low_income"
                    checked={formData.low_income}
                    onCheckedChange={(checked) => handleChange('low_income', checked)}
                  />
                  <Label htmlFor="low_income">Low income</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="unemployed"
                    checked={formData.unemployed}
                    onCheckedChange={(checked) => handleChange('unemployed', checked)}
                  />
                  <Label htmlFor="unemployed">Currently unemployed</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="displaced_worker"
                    checked={formData.displaced_worker}
                    onCheckedChange={(checked) => handleChange('displaced_worker', checked)}
                  />
                  <Label htmlFor="displaced_worker">Displaced worker</Label>
                </div>
              </div>
            </div>
          )}

          {/* STEP: Government Assistance */}
          {currentStepData.id === 'assistance' && (
            <div className="space-y-4">
              <CardTitle>Government Assistance Programs</CardTitle>
              <p className="text-sm text-slate-600">Select all programs you currently receive:</p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'medicaid_enrolled', label: 'Medicaid' },
                  { id: 'medicare_recipient', label: 'Medicare' },
                  { id: 'ssi_recipient', label: 'SSI (Supplemental Security Income)' },
                  { id: 'ssdi_recipient', label: 'SSDI (Social Security Disability)' },
                  { id: 'snap_recipient', label: 'SNAP (Food Stamps)' },
                  { id: 'tanf_recipient', label: 'TANF (Temporary Assistance)' },
                  { id: 'section8_housing', label: 'Section 8 Housing' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id}>{item.label}</Label>
                  </div>
                ))}
              </div>

              {formData.medicaid_enrolled && (
                <>
                  <div>
                    <Label htmlFor="medicaid_waiver_program">Medicaid Waiver Program</Label>
                    <Select
                      value={formData.medicaid_waiver_program}
                      onValueChange={(value) => handleChange('medicaid_waiver_program', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
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
                      value={formData.tenncare_id}
                      onChange={(e) => handleChange('tenncare_id', e.target.value)}
                      placeholder="Enter TennCare ID"
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* STEP: Health & Medical */}
          {currentStepData.id === 'health' && (
            <div className="space-y-6">
              <CardTitle>Health & Medical Conditions</CardTitle>
              <p className="text-sm text-slate-600">This helps us find specialized programs for you.</p>

              {/* Cancer Survivor Section */}
              <div className="p-4 bg-rose-50 rounded-lg border border-rose-200 space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="cancer_survivor"
                    checked={formData.cancer_survivor}
                    onCheckedChange={(checked) => handleChange('cancer_survivor', checked)}
                  />
                  <Label htmlFor="cancer_survivor" className="font-semibold">Cancer Survivor</Label>
                </div>
                {formData.cancer_survivor && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="cancer_type">Type of Cancer</Label>
                      <Input
                        id="cancer_type"
                        value={formData.cancer_type}
                        onChange={(e) => handleChange('cancer_type', e.target.value)}
                        placeholder="e.g., Breast, Lung"
                      />
                    </div>
                    <div>
                      <Label htmlFor="cancer_diagnosis_year">Year of Diagnosis</Label>
                      <Input
                        id="cancer_diagnosis_year"
                        type="number"
                        value={formData.cancer_diagnosis_year || ""}
                        onChange={(e) => handleChange('cancer_diagnosis_year', parseInt(e.target.value) || null)}
                        placeholder="2020"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Chronic Illness Section */}
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="chronic_illness"
                    checked={formData.chronic_illness}
                    onCheckedChange={(checked) => handleChange('chronic_illness', checked)}
                  />
                  <Label htmlFor="chronic_illness" className="font-semibold">Chronic Illness</Label>
                </div>
                {formData.chronic_illness && (
                  <div>
                    <Label htmlFor="chronic_illness_type">Type of Chronic Illness</Label>
                    <Input
                      id="chronic_illness_type"
                      value={formData.chronic_illness_type}
                      onChange={(e) => handleChange('chronic_illness_type', e.target.value)}
                      placeholder="e.g., Diabetes, Heart Disease, Asthma"
                    />
                  </div>
                )}
              </div>

              {/* Other Health Conditions */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'dialysis_patient', label: 'Dialysis Patient' },
                  { id: 'organ_transplant', label: 'Organ Transplant Recipient' },
                  { id: 'hiv_aids', label: 'HIV/AIDS' },
                  { id: 'tbi_survivor', label: 'Traumatic Brain Injury (TBI) Survivor' },
                  { id: 'amputee', label: 'Amputee' },
                  { id: 'neurodivergent', label: 'Neurodivergent (Autism, ADHD, etc.)' },
                  { id: 'visual_impairment', label: 'Visual Impairment' },
                  { id: 'hearing_impairment', label: 'Hearing Impairment' },
                  { id: 'wheelchair_user', label: 'Wheelchair User' },
                  { id: 'substance_recovery', label: 'Substance Recovery Participant' },
                  { id: 'mental_health_condition', label: 'Mental Health Condition' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id}>{item.label}</Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP: Demographics */}
          {currentStepData.id === 'demographics' && (
            <div className="space-y-6">
              <CardTitle>Demographics</CardTitle>
              
              <div>
                <Label htmlFor="immigration_status">Immigration/Citizenship Status</Label>
                <Select
                  value={formData.immigration_status}
                  onValueChange={(value) => handleChange('immigration_status', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
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

              <div className="space-y-3">
                <p className="font-semibold text-sm">Race/Ethnicity (Check all that apply):</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'african_american', label: 'African American / Black' },
                    { id: 'hispanic_latino', label: 'Hispanic / Latino' },
                    { id: 'asian_american', label: 'Asian American' },
                    { id: 'native_american', label: 'Native American / Alaska Native' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id}>{item.label}</Label>
                    </div>
                  ))}
                </div>

                {formData.native_american && (
                  <div>
                    <Label htmlFor="tribal_affiliation">Tribal Affiliation</Label>
                    <Input
                      id="tribal_affiliation"
                      value={formData.tribal_affiliation}
                      onChange={(e) => handleChange('tribal_affiliation', e.target.value)}
                      placeholder="Name of tribe"
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="lgbtq"
                  checked={formData.lgbtq}
                  onCheckedChange={(checked) => handleChange('lgbtq', checked)}
                />
                <Label htmlFor="lgbtq">LGBTQ+</Label>
              </div>
            </div>
          )}

          {/* STEP: Family & Life */}
          {currentStepData.id === 'family' && (
            <div className="space-y-4">
              <CardTitle>Family & Life Situation</CardTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'single_parent', label: 'Single Parent' },
                  { id: 'foster_youth', label: 'Foster Youth / Former Foster Care' },
                  { id: 'orphan', label: 'Orphan' },
                  { id: 'adopted', label: 'Adopted' },
                  { id: 'foster_parent', label: 'Foster or Adoptive Parent' },
                  { id: 'caregiver', label: 'Family Caregiver' },
                  { id: 'widow_widower', label: 'Widow / Widower' },
                  { id: 'grandparent_raising_grandchildren', label: 'Grandparent Raising Grandchildren' },
                  { id: 'first_time_parent', label: 'First-Time Parent' },
                  { id: 'homeless', label: 'Homeless / Housing Insecure' },
                  { id: 'domestic_violence_survivor', label: 'Domestic Violence Survivor' },
                  { id: 'trafficking_survivor', label: 'Human Trafficking Survivor' },
                  { id: 'disaster_survivor', label: 'Disaster Survivor' },
                  { id: 'formerly_incarcerated', label: 'Formerly Incarcerated' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id}>{item.label}</Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP: Military */}
          {currentStepData.id === 'military' && (
            <div className="space-y-4">
              <CardTitle>Military Service</CardTitle>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'veteran', label: 'Veteran' },
                  { id: 'active_duty_military', label: 'Active Duty Military' },
                  { id: 'national_guard', label: 'National Guard / Reserve' },
                  { id: 'disabled_veteran', label: 'Disabled Veteran' },
                  { id: 'military_spouse', label: 'Military Spouse' },
                  { id: 'military_dependent', label: 'Military Dependent' },
                  { id: 'gold_star_family', label: 'Gold Star Family Member' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id}>{item.label}</Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP: Occupation */}
          {currentStepData.id === 'occupation' && (
            <div className="space-y-6">
              <CardTitle>Occupation & Work</CardTitle>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'healthcare_worker', label: 'Healthcare Worker' },
                  { id: 'ems_worker', label: 'EMS Worker / First Responder' },
                  { id: 'educator', label: 'Teacher / Educator' },
                  { id: 'firefighter', label: 'Firefighter' },
                  { id: 'law_enforcement', label: 'Law Enforcement Officer' },
                  { id: 'public_servant', label: 'Public Servant / Government Employee' },
                  { id: 'clergy', label: 'Clergy / Religious Worker' },
                  { id: 'missionary', label: 'Missionary / Evangelist' },
                  { id: 'nonprofit_employee', label: 'Nonprofit Employee' },
                  { id: 'small_business_owner', label: 'Small Business Owner' },
                  { id: 'is_minority_owned_business_owner', label: 'Minority-Owned Business Owner' },
                  { id: 'is_women_owned_business_owner', label: 'Women-Owned Business Owner' },
                  { id: 'union_member', label: 'Union Member' },
                  { id: 'farmer', label: 'Farmer / Agricultural Worker' },
                  { id: 'truck_driver', label: 'Truck Driver / Transportation Worker' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id}>{item.label}</Label>
                  </div>
                ))}
              </div>

              {formData.healthcare_worker && (
                <div>
                  <Label htmlFor="healthcare_worker_type">Type of Healthcare Worker</Label>
                  <Input
                    id="healthcare_worker_type"
                    value={formData.healthcare_worker_type}
                    onChange={(e) => handleChange('healthcare_worker_type', e.target.value)}
                    placeholder="e.g., Registered Nurse, EMT, CNA"
                  />
                </div>
              )}
            </div>
          )}

          {/* STEP: Firearms / Second Amendment */}
          {currentStepData.id === 'firearms' && formData.applicant_type !== 'organization' && (
            <div className="space-y-4">
              <CardTitle>Firearms / Second Amendment</CardTitle>
              <p className="text-sm text-slate-600">Optional - helps identify specialized funding opportunities</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'second_amendment_supporter', label: 'Second Amendment Supporter' },
                  { id: 'gun_owner', label: 'Gun Owner' },
                  { id: 'concealed_carry_permit', label: 'Concealed Carry Permit Holder' },
                  { id: 'nra_member', label: 'NRA Member' },
                  { id: 'firearm_instructor', label: 'Firearm Safety Instructor' },
                  { id: 'competitive_shooter', label: 'Competitive Shooter' },
                  { id: 'hunting_license', label: 'Hunting License Holder' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id}>{item.label}</Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP: Political / Civic Engagement */}
          {currentStepData.id === 'political' && formData.applicant_type !== 'organization' && (
            <div className="space-y-4">
              <CardTitle>Political / Civic Engagement</CardTitle>
              <p className="text-sm text-slate-600">Optional - helps identify civic engagement opportunities</p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { id: 'registered_voter', label: 'Registered Voter' },
                  { id: 'politically_active', label: 'Politically Active' },
                  { id: 'community_organizer', label: 'Community Organizer' },
                  { id: 'advocacy_work', label: 'Advocacy Work' },
                  { id: 'civic_volunteer', label: 'Civic Volunteer' },
                  { id: 'election_worker', label: 'Election Worker / Poll Worker' },
                ].map(item => (
                  <div key={item.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={item.id}
                      checked={formData[item.id]}
                      onCheckedChange={(checked) => handleChange(item.id, checked)}
                    />
                    <Label htmlFor={item.id}>{item.label}</Label>
                  </div>
                ))}
              </div>

              <div>
                <Label htmlFor="political_party">Political Party Affiliation (Optional)</Label>
                <Select
                  value={formData.political_party}
                  onValueChange={(value) => handleChange('political_party', value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select or skip..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Prefer not to say</SelectItem>
                    <SelectItem value="democrat">Democrat</SelectItem>
                    <SelectItem value="republican">Republican</SelectItem>
                    <SelectItem value="independent">Independent</SelectItem>
                    <SelectItem value="libertarian">Libertarian</SelectItem>
                    <SelectItem value="green">Green Party</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* STEP: Location */}
          {currentStepData.id === 'location' && (
            <div className="space-y-4">
              <CardTitle>Location</CardTitle>
              <div>
                <Label htmlFor="address">Street Address</Label>
                <Input
                  id="address"
                  value={formData.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                  placeholder="123 Main St"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="city">City *</Label>
                  <Input
                    id="city"
                    value={formData.city}
                    onChange={(e) => handleChange('city', e.target.value)}
                    placeholder="Nashville"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="state">State *</Label>
                  <Select
                    value={formData.state}
                    onValueChange={(value) => handleChange('state', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select State" />
                    </SelectTrigger>
                    <SelectContent>
                      {US_STATES.map(state => (
                        <SelectItem key={state} value={state}>{state}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="zip">ZIP Code</Label>
                  <Input
                    id="zip"
                    value={formData.zip}
                    onChange={(e) => handleChange('zip', e.target.value)}
                    placeholder="37203"
                  />
                </div>
              </div>

              <div className="space-y-3 pt-4">
                <p className="font-semibold text-sm">Geographic Characteristics:</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { id: 'rural_resident', label: 'Rural Area Resident' },
                    { id: 'appalachian_region', label: 'Appalachian Region Resident' },
                    { id: 'urban_underserved', label: 'Urban Underserved Area' },
                  ].map(item => (
                    <div key={item.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={item.id}
                        checked={formData[item.id]}
                        onCheckedChange={(checked) => handleChange(item.id, checked)}
                      />
                      <Label htmlFor={item.id}>{item.label}</Label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP: Narrative */}
          {currentStepData.id === 'narrative' && (
            <div className="space-y-4">
              <CardTitle>Your Story & Goals</CardTitle>
              <p className="text-sm text-slate-600">
                These narrative responses help us find the most relevant opportunities for you.
              </p>

              <div>
                <Label htmlFor="mission">Your Mission or Purpose</Label>
                <Textarea
                  id="mission"
                  value={formData.mission}
                  onChange={(e) => handleChange('mission', e.target.value)}
                  placeholder="Describe your mission, purpose, or what drives you..."
                  rows={4}
                />
                <p className="text-xs text-slate-500 mt-1">
                  What is your organization's mission or your personal purpose?
                </p>
              </div>

              <div>
                <Label htmlFor="primary_goal">What are your primary goals?</Label>
                <Textarea
                  id="primary_goal"
                  value={formData.primary_goal}
                  onChange={(e) => handleChange('primary_goal', e.target.value)}
                  placeholder="Describe what you hope to achieve..."
                  rows={4}
                />
                <p className="text-xs text-slate-500 mt-1">
                  What specific outcomes or achievements are you working toward?
                </p>
              </div>

              <div>
                <Label htmlFor="past_experience">Past Experience & Achievements</Label>
                <Textarea
                  id="past_experience"
                  value={formData.past_experience}
                  onChange={(e) => handleChange('past_experience', e.target.value)}
                  placeholder="Describe your relevant experience, accomplishments, or programs you've implemented..."
                  rows={4}
                />
                <p className="text-xs text-slate-500 mt-1">
                  Share your track record, achievements, or relevant background
                </p>
              </div>

              <div>
                <Label htmlFor="special_circumstances">Challenges & Special Circumstances</Label>
                <Textarea
                  id="special_circumstances"
                  value={formData.special_circumstances}
                  onChange={(e) => handleChange('special_circumstances', e.target.value)}
                  placeholder="Describe any challenges overcome, barriers faced, or unique aspects of your situation..."
                  rows={4}
                />
                <p className="text-xs text-slate-500 mt-1">
                  What challenges or barriers have you overcome? What makes your situation unique?
                </p>
              </div>

              <div>
                <Label htmlFor="funding_amount_needed">Funding Needed</Label>
                <Input
                  id="funding_amount_needed"
                  value={formData.funding_amount_needed}
                  onChange={(e) => handleChange('funding_amount_needed', e.target.value)}
                  placeholder="e.g., $5,000 for tuition or $50,000 for program expansion"
                />
              </div>

              <div>
                <Label htmlFor="target_population">Target Population (if applicable)</Label>
                <Input
                  id="target_population"
                  value={formData.target_population}
                  onChange={(e) => handleChange('target_population', e.target.value)}
                  placeholder="e.g., Low-income youth, Veterans, Rural families"
                />
              </div>

              <div>
                <Label>Keywords & Interests</Label>
                <MultiSelectCombobox
                  options={[]}
                  selected={formData.keywords}
                  onSelectedChange={(values) => handleChange('keywords', values)}
                  placeholder="Add keywords (e.g., education, healthcare, community service)..."
                  allowCustom
                />
              </div>
            </div>
          )}

          {/* STEP: Documents */}
          {currentStepData.id === 'documents' && (
            <div className="space-y-4">
              <CardTitle>Supporting Documents (Optional)</CardTitle>
              <div className="p-6 border-2 border-dashed rounded-lg text-center">
                <Upload className="w-12 h-12 mx-auto text-slate-400 mb-3" />
                <p className="text-slate-600 mb-2">Upload supporting documents</p>
                <p className="text-sm text-slate-500 mb-4">
                  Transcripts, award letters, financial documents, medical records, etc.
                </p>
                <Button type="button" variant="outline">
                  <Upload className="w-4 h-4 mr-2" />
                  Choose Files
                </Button>
              </div>
              <p className="text-xs text-slate-500">
                Documents will be securely stored and used to verify eligibility.
              </p>
            </div>
          )}

          {/* STEP: Review */}
          {currentStepData.id === 'review' && (
            <div className="space-y-6">
              <CardTitle>Review Your Application</CardTitle>
              
              <div className="space-y-4">
                <div className="p-4 bg-slate-50 rounded-lg">
                  <h4 className="font-semibold mb-2">Basic Information</h4>
                  <p><strong>Name:</strong> {formData.name || 'Not provided'}</p>
                  <p><strong>Type:</strong> {formData.applicant_type || 'Not selected'}</p>
                  <p><strong>Location:</strong> {formData.city && formData.state ? `${formData.city}, ${formData.state}` : 'Not provided'}</p>
                </div>

                {isStudent && (
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <h4 className="font-semibold mb-2">Education</h4>
                    <p><strong>Grade Levels:</strong> {formData.student_grade_levels.join(', ') || 'Not selected'}</p>
                    {formData.current_college && <p><strong>Current College:</strong> {formData.current_college}</p>}
                    {formData.target_colleges.length > 0 && (
                      <p><strong>Target Colleges:</strong> {formData.target_colleges.join(', ')}</p>
                    )}
                    {formData.gpa && <p><strong>GPA:</strong> {formData.gpa}</p>}
                  </div>
                )}

                <div className="p-4 bg-green-50 rounded-lg">
                  <h4 className="font-semibold mb-2">Qualifiers Found</h4>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {Object.entries(formData).filter(([key, value]) => 
                      value === true && key !== 'applicant_type'
                    ).map(([key]) => (
                      <Badge key={key} variant="secondary">
                        {key.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5" />
                    <div>
                      <h4 className="font-semibold text-yellow-900">Ready to Submit?</h4>
                      <p className="text-sm text-yellow-800 mt-1">
                        After submission, we'll match you with all funding opportunities you're eligible for.
                      </p>
                    </div>
                  </div>
                </div>

                {/* PDF & Email Actions */}
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <h4 className="font-semibold mb-3 text-blue-900">Application Actions</h4>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handlePrintPDF}
                      className="flex-1 min-w-[200px]"
                    >
                      <Printer className="w-4 h-4 mr-2" />
                      Save as PDF
                    </Button>
                    <Button
                      type="button"
                      onClick={handleEmailApplication}
                      disabled={isSendingEmail}
                      className="flex-1 min-w-[200px] bg-blue-600 hover:bg-blue-700"
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      {isSendingEmail ? 'Sending...' : 'Email to Dr. White'}
                    </Button>
                  </div>
                  <p className="text-xs text-blue-700 mt-2">
                    Click "Save as PDF" to download, or "Email to Dr. White" to send directly to dr.johnwhite@axiombiolabs.org
                  </p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Navigation Buttons */}
      <div className="flex justify-between sticky bottom-0 bg-white border-t pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={handleBack}
          disabled={currentStep === 0}
        >
          <ChevronLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        {currentStep < visibleSteps.length - 1 ? (
          <Button
            type="button"
            onClick={handleNext}
            className="bg-blue-600 hover:bg-blue-700"
          >
            Next
            <ChevronRight className="w-4 h-4 ml-2" />
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={isSubmitting}
            className="bg-green-600 hover:bg-green-700"
          >
            {isSubmitting ? 'Submitting...' : 'Submit Application'}
            <CheckCircle className="w-4 h-4 ml-2" />
          </Button>
        )}
      </div>

      {/* Form Instructions */}
      <Card className="mt-6">
        <CardContent className="p-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="font-semibold text-blue-900 mb-2">INSTRUCTIONS</h3>
            <p className="text-sm text-blue-800">
              After completing this form, hand it back to John White, fax it to: <strong>423-414-5290</strong>, or email it to: <strong>Dr.JohnWhite@axiombiolabs.org</strong>
            </p>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
