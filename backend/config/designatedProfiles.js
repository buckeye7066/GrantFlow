export const DESIGNATED_PROFILES = [
  // Required roster (release-hardening checklist):
  // John, Robert, Anastasia, Luibov, Focus Forward, Axiom Biolabs, Brian, Hollie,
  // Olivia, Avanell, Angelika, Rachel, Josh, Jason, Kathy.
  //
  // Demo/test fixture profile for onboarding + smoke checks:
  // John Doe should always exist so admins can validate flows quickly.
  {
    id: 'profile-john-doe',
    display_name: 'John Doe',
    primary_type: 'individual',
    status: 'active',
    tags: ['individual', 'demo'],
    sections: {
      basic_information: {
        full_name: 'John Doe',
        email: 'john.doe@example.com',
        phone: '',
        website: '',
        address: '123 Main Street\nNashville, TN 37209',
      },
      financial_information: {
        financial_need_level: 'Unknown',
        notes: 'Demo profile for validating intake, documents, and crawlers.',
      },
      location_focus: {
        geographic_focus: 'Nashville, Tennessee',
        notes: 'Demo profile – update as needed.',
      },
      narrative: {
        mission: 'Demo profile for testing GrantFlow end-to-end.',
        primary_goal: 'Validate crawl + application + document ingestion flows.',
        funding_amount_needed: '',
      },
    },
  },
  //
  // NOTE: Some profiles below are minimal stubs (no sections yet). That's intentional:
  // they ensure deterministic IDs exist in Postgres/SQLite so login mapping can attach,
  // while allowing admins/users to keep editing without startup wiping data.
  {
    id: 'profile-axiom-biolabs',
    display_name: 'Axiom BioLabs',
    primary_type: 'organization',
    status: 'active',
    tags: ['organization'],
    sections: {
      basic_information: {
        full_name: 'Axiom BioLabs',
        email: '',
        phone: '',
        website: 'https://www.axiombiolabs.org',
        address: '',
      },
      organization_details: {
        organization_type: 'Biotechnology / research organization',
        mission: '',
      },
    },
  },
  {
    id: 'profile-robert',
    display_name: 'Robert',
    primary_type: 'individual',
    status: 'active',
    tags: ['individual'],
  },
  {
    id: 'profile-anastasia',
    display_name: 'Anastasia Nicole White',
    primary_type: 'high_school_student',
    status: 'active',
    tags: ['individual', 'student'],
    // Keep canonical profile data as data (not hardcoded in this file).
    // `ensureDesignatedProfiles` will seed these sections only if missing.
    data_file: 'backend/config/profile-anastasia.json',
  },
  {
    id: 'profile-luibov',
    display_name: 'Luibov',
    primary_type: 'individual',
    status: 'active',
    tags: ['individual'],
  },
  {
    id: 'profile-angelika-ptak',
    display_name: 'Angelika Ptak',
    primary_type: 'individual',
    status: 'active',
    tags: ['individual'],
  },
  {
    id: 'profile-rachel-miller',
    display_name: 'Rachel Miller',
    primary_type: 'individual',
    status: 'active',
    tags: ['individual'],
  },
  {
    id: 'profile-josh-dasher',
    display_name: 'Josh Dasher',
    primary_type: 'individual',
    status: 'active',
    tags: ['individual'],
  },
  {
    id: 'profile-paul-jason-dasher',
    display_name: 'Jason Dasher',
    primary_type: 'individual',
    status: 'active',
    tags: ['individual'],
  },
  {
    id: 'profile-kathy',
    display_name: 'Kathy',
    primary_type: 'individual',
    status: 'active',
    tags: ['individual'],
  },
  {
    id: 'profile-olivia-beltran',
    display_name: 'Olivia Beltran / Hybrid Healing',
    primary_type: 'small_business',
    status: 'active',
    tags: ['wellness', 'holistic', 'small business'],
    sections: {
      basic_information: {
        full_name: 'Hybrid Healing Wellness Collective',
        email: 'Oliviadbeltran@gmail.com',
        phone: '7245449650',
        website: 'https://mysite.vagaro.com/hybridhealingllc/',
        address: '196 James Street\nBeaver Falls, PA 15010',
      },
      organization_details: {
        organization_type: 'Holistic wellness collective',
        ein: '88-4291655',
        mission:
          'Provide integrative wellness services led by a nurse practitioner and trauma-informed massage therapist.',
      },
      financial_information: {
        financial_need_level: 'High',
        household_income: 36000,
        household_size: 6,
        notes:
          'Seeking $50,000 to expand services, purchase equipment, and complete facility build-out.',
      },
      demographics: {
        hispanic_latino: true,
        white_caucasian: true,
      },
      family_life: {
        family_caregiver: true,
        first_time_parent: true,
      },
      location_focus: {
        appalachian_region: true,
        geographic_focus: 'Beaver County, Pennsylvania',
      },
      narrative: {
        primary_goal:
          'Expand Hybrid Healing wellness services, upgrade facilities, and stabilize operations.',
        funding_amount_needed: '$50,000 for equipment, renovations, staffing, and marketing.',
        mission:
          'Create a holistic sanctuary that integrates nursing care, trauma-informed bodywork, and community wellness.',
      },
    },
  },
  {
    id: 'profile-avanell-leamon',
    display_name: 'Avanell Lea Leamon',
    primary_type: 'family',
    status: 'active',
    tags: ['family assistance', 'caregiver', 'appalachian'],
    sections: {
      basic_information: {
        full_name: 'Avanell Lea Leamon',
        email: '',
        phone: '',
        address: '915 Linda Drive SE\nCleveland, TN 37323',
        notes: 'Imported from Base44 profile export (Avanell profile.pdf) on 2026-01-03.',
      },
      location_focus: {
        rural_resident: true,
        appalachian_region: true,
        geographic_focus: 'Cleveland, Tennessee and surrounding Appalachian communities.',
        notes: '',
      },
      financial_information: {
        household_size: 2,
        notes:
          'Household of two with caregiving responsibilities; prioritize grants serving low-income Appalachian families and caregivers.',
      },
      family_life: {
        caregiver: true,
        notes: '',
      },
      narrative: {
        mission: '',
        primary_goal: '',
        target_population: '',
        funding_amount_needed: '',
        timeline: '',
        past_experience: '',
        unique_qualities: '',
        collaboration_partners: '',
        sustainability_plan: '',
        barriers_faced: '',
        special_circumstances:
          'Profile generated from Base44 export. Narrative details still need to be collected from the applicant.',
      },
    },
  },
  {
    id: 'profile-gilbert-mccosh',
    display_name: 'Gilbert Allen McCosh',
    primary_type: 'individual',
    status: 'active',
    tags: ['epilepsy', 'disability advocacy', 'appalachian', 'low income'],
    sections: {
      basic_information: {
        full_name: 'Gilbert Allen McCosh',
        email: '',
        phone: '4235047778',
        address: '3940 Eveningside Dr. NE\nCleveland, TN 37312',
        notes:
          'Date of birth: 08/19/1952. Profile imported from Base44 export (Allen profile.pdf) on 2026-01-03.',
      },
      financial_information: {
        financial_need_level: 'High',
        low_income: true,
        unemployed: true,
        notes:
          'Seeking ~$4,500 combined funding for a customized wheelchair and adaptive technology; lives in a CLS-FM home and relies on public assistance.',
      },
      government_assistance: {
        medicaid_enrolled: true,
        ssi_recipient: true,
        ssdi_recipient: true,
        snap_recipient: true,
        other_programs: 'Medicaid Waiver Program (ECF CHOICES - TN). Medicaid number: ZECM15043724.',
      },
      health_medical: {
        chronic_illness: true,
        chronic_illness_type: 'Epilepsy',
        disability_type: [
          'Retina detachment (left eye)',
          'Epilepsy',
          'Anoxic brain injury',
          'Cognitive disability (F70)',
          'Clawing effect in hands',
        ],
        support_needs_level: 'Substantial',
        neurodivergent: true,
        mental_health_condition: true,
        notes:
          'Primary diagnosis codes include D07.4, F32.9, F70, G40.9, M62.830, and 311. Advocates for neurodiversity and needs mobility aids and assistive technology.',
      },
      location_focus: {
        rural_resident: false,
        appalachian_region: true,
        geographic_focus: 'Cleveland, Tennessee (Bradley County) with emphasis on Appalachian disability services.',
        notes: '',
      },
      narrative: {
        mission:
          'Advocate for neurodiversity and disability rights while securing support that improves daily living for people navigating epilepsy and brain injuries.',
        primary_goal:
          'Secure at least three chronic illness grants within the next year to fund a customized wheelchair and assistive technology.',
        target_population:
          'Individuals living with epilepsy, anoxic brain injuries, and related disabilities in Appalachian communities needing accessible healthcare and adaptive supports.',
        funding_amount_needed:
          '$3,000 for a customized wheelchair and $1,500 for adaptive assistive technology (communication and daily task supports).',
        timeline:
          'Research grants by December 15, 2023; identify top opportunities by January 10, 2024; submit applications by February 10, 2024; follow up by February 15, 2024; ongoing advocacy outreach through the end of 2024.',
        past_experience:
          'Years of independent living in group home settings culminating in advocacy for epilepsy and brain injury support programs.',
        unique_qualities:
          'Lived experience with chronic illness, brain injury, and disability advocacy; committed to empowering peers through storytelling.',
        collaboration_partners:
          'Plans to connect with at least five Cleveland, TN community organizations, disability support groups, and healthcare providers.',
        sustainability_plan:
          'Leverage acquired mobility aids and technology to maintain independence; sustain advocacy via workshops, speaking engagements, and community partnerships.',
        barriers_faced:
          'Limited mobility due to clawing effect in hands, financial constraints, and need for accessible healthcare and rehabilitation resources.',
        special_circumstances:
          'Living with epilepsy since age two; complications from a neck surgery caused lasting mobility challenges requiring specialized equipment.',
      },
      demographics: {
        notes: 'White / Caucasian; details captured from Base44 export.',
      },
    },
  },
  {
    id: 'profile-hollie-knox',
    display_name: 'Hollie Machelle Knox',
    primary_type: 'family',
    status: 'active',
    tags: ['family', 'single parent', 'domestic violence survivor'],
    sections: {
      basic_information: {
        full_name: 'Hollie Machelle Knox',
        email: 'HollieT52@gmail.com',
        phone: '4403965688',
        address: '120 Middle St\nWellington, OH 44090',
      },
      financial_information: {
        financial_need_level: 'High',
        household_income: 30000,
        household_size: 3,
        low_income: true,
        notes: 'Seeking $5,000 for housing costs and initial business inventory.',
      },
      government_assistance: {
        medicaid_enrolled: true,
      },
      health_medical: {
        chronic_illness: true,
        neurodivergent: true,
      },
      demographics: {
        white_caucasian: true,
        us_citizen: true,
      },
      family_life: {
        single_parent: true,
        family_caregiver: true,
        domestic_violence_survivor: true,
      },
      narrative: {
        primary_goal:
          'Provide a stable home for her children and launch an apothecary business for generational wealth.',
        mission:
          'Overcome financial hardships and build a safe, loving family environment with sustainable income.',
        funding_amount_needed: '$5,000 for housing costs and business startup supplies.',
        barriers_faced:
          'Survived childhood poverty, homelessness, teen pregnancy, abusive relationships, and a traumatic divorce.',
        special_circumstances:
          'Documented chronic illness and neurodivergence. Needs rapid financial relief for housing stability and seed capital.',
        unique_qualities:
          'Experienced horse trainer with a vision for an apothecary business that serves her local community.',
      },
    },
  },
  {
    id: 'profile-brian-client',
    display_name: 'Brian Nicholas Newman',
    primary_type: 'individual',
    status: 'active',
    tags: ['veteran', 'disabled veteran', 'single parent', 'public servant', 'ministry'],
    sections: {
      basic_information: {
        full_name: 'Brian Nicholas Newman',
        email: 'isawstars08@yahoo.com',
        phone: '4232700231',
        website: 'https://www.psalm16ministry.com',
        address: '3925 Adkisson Drive\nCleveland, TN 37312',
        notes:
          'DOB 08/24/1980. Sensitive identifiers stored in secure document (Brian.pdf) dated 12/05/2025.',
      },
      financial_information: {
        household_income: 75000,
        household_size: 4,
        financial_need_level: 'High debt burden',
        notes:
          'Seeking $50,000–$100,000 to retire student loans, resolve custody-related legal debt, secure housing, and seed a ministry-oriented small business.',
      },
      health_medical: {
        chronic_illness: true,
        chronic_illness_type: 'Diabetes, chronic kidney disease, sleep apnea',
        mental_health_condition: true,
        disability_type: [
          'Visual impairment',
          'PTSD',
          'Chronic kidney disease',
          'Hypertension',
        ],
        notes:
          'Documented high blood pressure, chronic kidney disease, sleep apnea, PTSD, and visual impairment contributing to 90% VA disability rating.',
      },
      demographics: {
        us_citizen: true,
        white_caucasian: true,
        religious_affiliation: 'Anglican',
        notes: 'Grew up in poverty; first-generation service member and college graduate.',
      },
      family_life: {
        single_parent: true,
      },
      military_service: {
        veteran: true,
        disabled_veteran: true,
        notes: 'United States Air Force veteran with 90% VA disability rating.',
      },
      occupation: {
        public_servant: true,
        nonprofit_employee: false,
        small_business_owner: false,
        notes: 'Human services professional and ordained minister; operates Psalm 16 Ministry.',
      },
      narrative: {
        mission:
          'Serve vulnerable families through ministry and human services while achieving personal financial stability.',
        primary_goal:
          'Eliminate high-interest student and legal debt, secure safe housing, and relaunch ministry and small business initiatives.',
        funding_amount_needed:
          '$50,000–$100,000 for debt payoff, down payment on a home, and ministry/small business start-up costs.',
        target_population:
          'Low-income families and individuals seeking faith-based counseling, veteran support, and human services resources.',
        timeline:
          'Debt relief and housing stabilization targeted within the next 12 months; ministry relaunch immediately afterward.',
        barriers_faced:
          'Extreme poverty in childhood, loss of parents and grandparents by college graduation, parental alienation, and multi-generational trauma.',
        supports:
          'Active in local church communities; strong network of ministers and peer support specialists.',
        special_circumstances:
          'Balancing single parenthood, chronic health conditions, and ministry obligations while servicing substantial debt.',
        unique_qualities:
          'Award-winning Air Force veteran, author, and certified peer recovery specialist with extensive training credentials.',
      },
    },
  },
  {
    id: 'profile-focus-forward-ministries',
    display_name: 'Focus Forward Ministries',
    primary_type: 'organization',
    status: 'active',
    tags: ['faith-based', 'indigenous outreach', 'poverty alleviation', 'missions'],
    sections: {
      basic_information: {
        full_name: 'Focus Forward Ministries',
        website: 'https://www.focusforwardministries.com',
        address: '796 Mount Vernon Drive Northwest\nCleveland, TN 37311',
        notes: 'Profile imported from Focus Forward Ministries Profile.pdf (Base44 export).',
      },
      organization_details: {
        organization_type: 'Faith-based nonprofit ministry',
        annual_budget: 25000,
        staff_count: 5,
        mission:
          'Bring the love of Christ to underserved communities through compassionate service, discipleship, and sustainable outreach.',
      },
      financial_information: {
        financial_need_level: 'Growth capital',
        notes:
          'Needs $15,000–$250,000 to expand work on the Pine Ridge Indian Reservation and strengthen infrastructure for ongoing outreach.',
      },
      location_focus: {
        geographic_focus: 'Pine Ridge Indian Reservation (Sioux Nation), South Dakota',
        notes:
          'Focus on rural, indigenous communities experiencing systemic poverty and limited access to services.',
      },
      narrative: {
        mission:
          'Restore hope, strengthen families, and empower Sioux communities through holistic ministry and practical support.',
        primary_goal:
          'Deliver building supplies, spiritual guidance, and sustainable support structures for Pine Ridge families by January 2026.',
        target_population:
          'Sioux Indian families living in poverty on the Pine Ridge Indian Reservation.',
        funding_amount_needed: '$15,000–$250,000 for outreach logistics, materials, and staffing.',
        timeline: 'Critical funding goal of January 2026 to align with next outreach deployment.',
        past_experience:
          'Completed repairs on two reservation buildings, supplied vital equipment, and led ongoing discipleship and outreach initiatives.',
        unique_qualities:
          'Team includes Indigenous leaders with deep cultural insight, ensuring trusted, culturally responsive service delivery.',
        collaboration_partners:
          'Local businesses, faith-based groups, community leaders, indigenous rights organizations, and sustainable development partners.',
        sustainability_plan:
          'Empower community leadership through training, resource-sharing networks, and diversified funding via grants, donations, and fundraisers.',
        barriers_faced:
          'Systemic poverty, limited infrastructure, cultural isolation, and historic distrust complicate outreach execution.',
      },
    },
  },
  {
    id: 'profile-john-white',
    display_name: 'Dr. John White',
    primary_type: 'individual',
    status: 'active',
    tags: ['healthcare professional', 'educator', 'food security', 'community advocate'],
    sections: {
      basic_information: {
        full_name: 'John White',
        email: '',
        phone: '',
        address: '3940 Eveningside Dr. NE\nCleveland, TN 37312',
        notes:
          'Profile imported from John Profile.pdf. Molecular geneticist, registered nurse, and educator committed to community wellness.',
      },
      location_focus: {
        geographic_focus: 'Bradley County, Tennessee, with outreach to regional food security programs.',
        notes:
          'Actively coordinates with regional nonprofits such as Good Shepherd Center, Hands of Mercy, and Cleveland Family YMCA.',
      },
      financial_information: {
        notes:
          'Funding priorities include community nutrition initiatives, workforce development for healthcare trainees, and support for local food assistance networks.',
      },
      narrative: {
        mission:
          'Mobilize scientific expertise, nursing practice, and faith-informed service to address food insecurity and health disparities.',
        primary_goal:
          'Secure multi-year funding to expand community health education, nutrition assistance, and youth mentorship programs.',
        target_population:
          'Underserved families in Bradley County needing access to healthy food, healthcare navigation, and STEM education pathways.',
        funding_amount_needed:
          'Seeking catalytic grants (mid five figures) to underwrite program coordination, volunteer training, and curriculum development.',
        past_experience:
          'Extensive background in molecular genetics, nursing, and academic instruction; active collaborations with regional food assistance organizations.',
        unique_qualities:
          'Bridges advanced scientific training with pastoral care and community organizing to design holistic support models.',
        barriers_faced:
          'Sustaining volunteer-driven programs while balancing clinical, educational, and community leadership responsibilities.',
        collaboration_partners:
          'Food pantries, faith-based coalitions, healthcare providers, and educational institutions across East Tennessee.',
        special_circumstances:
          'Documented in Base44 export; requires sensitive handling of personal credentials and licensure data.',
      },
    },
  },
  {
    id: 'profile-paul-jason-dasher',
    display_name: 'Paul Jason Dasher',
    primary_type: 'individual',
    status: 'active',
    tags: ['baseline', 'designated'],
    sections: {
      basic_information: {
        full_name: 'Paul Jason Dasher',
        email: 'Pjandcrdasher@att.net',
        phone: '',
        address: '',
      },
    },
  },
  {
    id: 'profile-angelika-ptak',
    display_name: 'Angelika Ptak',
    primary_type: 'individual',
    status: 'active',
    tags: ['baseline', 'designated'],
    sections: {
      basic_information: {
        full_name: 'Angelika Ptak',
        email: 'angelikaps.rn@gmail.com',
        phone: '',
        address: '',
      },
    },
  },
  {
    id: 'profile-rachel-miller',
    display_name: 'Rachel Miller',
    primary_type: 'individual',
    status: 'active',
    tags: ['baseline', 'designated'],
    sections: {
      basic_information: {
        full_name: 'Rachel Miller',
        email: 'rdashermiller@gmail.com',
        phone: '',
        address: '',
      },
    },
  },
  {
    id: 'profile-anastasia-white',
    display_name: 'Anastasia Nicole White',
    primary_type: 'high_school_student',
    status: 'active',
    tags: ['baseline', 'designated', 'student'],
    sections: {
      basic_information: {
        full_name: 'Anastasia Nicole White',
        email: 'Tishka1201@icloud.com',
        phone: '',
        address: 'Cleveland, TN',
        notes:
          'Currently in high school and taking college-level classes at Cleveland State Community College.',
      },
    },
  },
  {
    id: 'profile-kathy-daniel',
    display_name: 'Kathy Marie Daniel',
    primary_type: 'individual',
    status: 'active',
    tags: ['baseline', 'designated'],
    sections: {
      basic_information: {
        full_name: 'Kathy Marie Daniel',
        email: 'kathydaniel1975@gmail.com',
        phone: '4236611020',
        address: '',
      },
    },
  },
  {
    id: 'profile-kimberly-botts',
    display_name: 'Kimberly Botts',
    primary_type: 'individual',
    status: 'active',
    tags: ['baseline', 'designated'],
    sections: {
      basic_information: {
        full_name: 'Kimberly Botts',
        email: '',
        phone: '',
        address: 'Cleveland, TN',
      },
    },
  },
  {
    id: 'profile-luibov-samoylenko',
    display_name: 'Luibov S Samoylenko',
    primary_type: 'individual',
    status: 'active',
    tags: ['baseline', 'designated'],
    sections: {
      basic_information: {
        full_name: 'Luibov S Samoylenko',
        email: '',
        phone: '',
        address: 'Cleveland, TN',
        notes: 'Baseline profile imported from Base44 export.',
      },
    },
  },
  {
    id: 'profile-robert-white',
    display_name: 'Robert White',
    primary_type: 'college_student',
    status: 'active',
    tags: ['baseline', 'designated', 'student'],
    sections: {
      basic_information: {
        full_name: 'Robert White',
        email: '',
        phone: '',
        address: 'Cleveland, TN 37312',
      },
    },
  },
  {
    id: 'profile-axiom-biolabs',
    display_name: 'Axiom Biolabs',
    primary_type: 'organization',
    status: 'active',
    tags: ['baseline', 'designated', 'organization'],
    sections: {
      basic_information: {
        full_name: 'Axiom Biolabs',
        email: '',
        phone: '',
        address: '',
      },
    },
  },
  {
    id: 'profile-josh-dasher',
    display_name: 'Josh Dasher',
    primary_type: 'individual',
    status: 'active',
    tags: ['baseline', 'designated'],
    sections: {
      basic_information: {
        full_name: 'Josh Dasher',
        email: 'joshua.dasher@gmail.com',
        phone: '',
        address: '',
      },
    },
  },
]
