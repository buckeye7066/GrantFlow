/**
 * schoolPrograms.js
 *
 * Federal, national, and private grant programs and funding opportunities
 * available to K-12 schools, school districts, charter schools, private
 * schools, and homeschool cooperatives.
 *
 * All URLs are real program, application, or intake pages.
 * Programs verified active as of 2024-2025.
 */

export const SCHOOL_PROGRAMS = [

  // ════════════════════════════════════════
  // FEDERAL — U.S. DEPARTMENT OF EDUCATION
  // ════════════════════════════════════════
  {
    id: 'school-title-i-lea',
    name: 'Title I Grants to Local Educational Agencies',
    description: 'The largest federal K-12 education grant program, providing funding to help schools with high concentrations of students from low-income families meet challenging academic standards. Funds flow from the U.S. Department of Education to state education agencies and then to local educational agencies (LEAs). Eligible uses include additional instructional time, tutoring, family engagement, and school improvement strategies.',
    url: 'https://oese.ed.gov/offices/office-of-formula-grants/school-support-and-accountability/title-i-part-a-program/',
    applicant_types: ['school', 'organization'],
    categories: ['education', 'low_income_students', 'academic_support'],
    type: 'grant',
    fundingType: 'formula_grant',
    maxAmount: 5000000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['title_i', 'disadvantaged_students', 'k12', 'school', 'education_funding'],
    is_active: true,
  },

  {
    id: 'school-idea-part-b',
    name: 'IDEA Part B Grants (Special Education)',
    description: 'Individuals with Disabilities Education Act (IDEA) Part B grants fund special education and related services for children with disabilities aged 3-21. Funds are distributed to states based on census data and poverty rates, then allocated to LEAs. Supports IEP development and implementation, assistive technology, specialist staff, and transition services for students with physical, cognitive, emotional, or learning disabilities.',
    url: 'https://sites.ed.gov/idea/',
    applicant_types: ['school', 'organization'],
    categories: ['education', 'special_education', 'disability'],
    type: 'grant',
    fundingType: 'formula_grant',
    maxAmount: 2000000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['special_education', 'disability', 'iep', 'school', 'k12'],
    is_active: true,
  },

  {
    id: 'school-title-iv-a',
    name: 'Title IV-A Student Support and Academic Enrichment Grants',
    description: 'Formula grants to LEAs for well-rounded educational opportunities, safe and healthy students, and effective use of technology. Funds may be used for STEM, arts, music, foreign languages, computer science, financial literacy, health and physical education, college and career counseling, and technology infrastructure. LEAs with allocations under $30,000 may use funds for any of the three areas.',
    url: 'https://oese.ed.gov/offices/office-of-formula-grants/school-support-and-accountability/title-iv-a-student-support-and-academic-enrichment-program/',
    applicant_types: ['school', 'organization'],
    categories: ['education', 'stem', 'arts', 'health_education'],
    type: 'grant',
    fundingType: 'formula_grant',
    maxAmount: 1000000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['stem', 'arts_education', 'school_enrichment', 'k12', 'school'],
    is_active: true,
  },

  {
    id: 'school-21st-cclc',
    name: '21st Century Community Learning Centers',
    description: 'Competitive grants to support the creation and expansion of community learning centers that provide academic enrichment during non-school hours for children, particularly those in high-poverty and low-performing schools. Programs may include tutoring, homework help, STEM activities, arts and music, and summer learning programs. Organizations must partner with LEAs.',
    url: 'https://oese.ed.gov/offices/office-of-formula-grants/school-support-and-accountability/21st-century-community-learning-centers/',
    applicant_types: ['school', 'nonprofit', 'organization'],
    categories: ['education', 'afterschool', 'community'],
    type: 'grant',
    fundingType: 'competitive_grant',
    maxAmount: 500000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['afterschool', 'out_of_school_time', 'summer_learning', 'school', 'k12'],
    is_active: true,
  },

  {
    id: 'school-magnet-schools',
    name: 'Magnet Schools Assistance Program',
    description: 'Competitive grants to LEAs to support magnet school programs that promote desegregation and reduce minority group isolation. Funds can be used to attract students to magnet programs, develop innovative curriculum, train teachers, and acquire necessary equipment. Magnet themes may include STEM, arts, international studies, career and technical education, and dual-language programs.',
    url: 'https://oese.ed.gov/offices/office-of-formula-grants/school-support-and-accountability/magnet-schools-assistance-program/',
    applicant_types: ['school', 'organization'],
    categories: ['education', 'diversity', 'specialized_programs'],
    type: 'grant',
    fundingType: 'competitive_grant',
    maxAmount: 3000000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['magnet_school', 'school_choice', 'stem', 'arts_school', 'k12'],
    is_active: true,
  },

  {
    id: 'school-full-service-community',
    name: 'Full-Service Community Schools Grant Program',
    description: 'Competitive grants to support the planning, implementation, and expansion of full-service community schools that provide coordinated academic, social, and health services for students, families, and communities. Partnerships between LEAs and community-based organizations are required. Services may include mental health, medical care, adult education, family support, and early childhood programs.',
    url: 'https://oese.ed.gov/offices/office-of-formula-grants/school-support-and-accountability/full-service-community-schools-program/',
    applicant_types: ['school', 'nonprofit', 'organization'],
    categories: ['education', 'community', 'social_services'],
    type: 'grant',
    fundingType: 'competitive_grant',
    maxAmount: 2500000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['community_school', 'wraparound_services', 'family_engagement', 'k12', 'school'],
    is_active: true,
  },

  {
    id: 'school-title-ii-a',
    name: 'Title II-A Supporting Effective Instruction',
    description: 'Formula grants to states and LEAs to increase student achievement by improving the quality and effectiveness of teachers, principals, and other school leaders. Funds can be used for professional development, mentoring, induction programs, teacher recruitment and retention, and class-size reduction. LEAs must use at least 15% of funds for school leader development.',
    url: 'https://oese.ed.gov/offices/office-of-formula-grants/school-support-and-accountability/title-ii-part-a-supporting-effective-instruction/',
    applicant_types: ['school', 'organization'],
    categories: ['education', 'professional_development', 'teacher_quality'],
    type: 'grant',
    fundingType: 'formula_grant',
    maxAmount: 800000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['teacher_training', 'professional_development', 'school', 'k12', 'educator'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // FEDERAL — USDA / FOOD & NUTRITION
  // ════════════════════════════════════════
  {
    id: 'school-nslp-equipment',
    name: 'National School Lunch Program Equipment Assistance Grants',
    description: 'USDA grants to help schools purchase equipment needed to serve healthy meals through the National School Lunch Program and School Breakfast Program. Funds are distributed to state agencies, which then award grants to eligible schools and school food authorities. Equipment may include ovens, refrigeration units, serving lines, and other food service equipment.',
    url: 'https://www.fns.usda.gov/cn/equipment-assistance-grants',
    applicant_types: ['school', 'organization'],
    categories: ['food_service', 'equipment', 'education'],
    type: 'grant',
    fundingType: 'competitive_grant',
    maxAmount: 100000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['school_lunch', 'cafeteria', 'food_service', 'k12', 'school'],
    is_active: true,
  },

  {
    id: 'school-farm-to-school',
    name: 'USDA Farm to School Grant Program',
    description: 'Competitive grants to help schools and school food authorities implement or expand farm to school programs that connect students to local and regional food producers. Funds may be used for curriculum development, staff training, school gardens, food safety equipment, and local food procurement. Open to school food authorities, state and local agencies, Indian tribal organizations, and nonprofits.',
    url: 'https://www.fns.usda.gov/farmtoschool/farm-school-grant-program',
    applicant_types: ['school', 'organization', 'nonprofit'],
    categories: ['food_service', 'agriculture', 'nutrition_education'],
    type: 'grant',
    fundingType: 'competitive_grant',
    maxAmount: 100000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['farm_to_school', 'local_food', 'nutrition', 'school', 'k12'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // FEDERAL — TECHNOLOGY & CONNECTIVITY
  // ════════════════════════════════════════
  {
    id: 'school-erate',
    name: 'E-Rate Program (Schools and Libraries)',
    description: 'The FCC E-Rate program provides discounts of 20%-90% on telecommunications and internet access services and equipment for eligible schools and libraries. Administered by the Universal Service Administrative Company (USAC). Schools in high-poverty areas or rural locations qualify for greater discounts. Covers broadband connectivity, Wi-Fi infrastructure, and network equipment.',
    url: 'https://www.usac.org/e-rate/',
    applicant_types: ['school', 'organization'],
    categories: ['technology', 'education', 'internet'],
    type: 'program',
    fundingType: 'discount_program',
    isGrant: false,
    isProgram: true,
    source: 'federal',
    intentMatch: ['internet_access', 'technology', 'school', 'broadband', 'digital_equity'],
    is_active: true,
  },

  {
    id: 'school-usda-distance-learning',
    name: 'USDA Distance Learning and Telemedicine Grants (Rural Schools)',
    description: 'USDA grants to help rural schools and educational institutions use telecommunications to access educational and medical resources not locally available. Funds may be used for broadband equipment, video conferencing systems, distance learning software, and related end-user equipment. Rural schools and school districts in communities of 20,000 or fewer are eligible.',
    url: 'https://www.rd.usda.gov/programs-services/telecommunications-programs/distance-learning-telemedicine-grants',
    applicant_types: ['school', 'organization'],
    categories: ['technology', 'education', 'rural_development'],
    type: 'grant',
    fundingType: 'competitive_grant',
    maxAmount: 1000000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['rural_school', 'distance_learning', 'technology', 'k12', 'broadband'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // FEDERAL — EPA & ENVIRONMENT
  // ════════════════════════════════════════
  {
    id: 'school-epa-environmental-ed',
    name: 'EPA Environmental Education Grants (for Schools)',
    description: 'Competitive grants from the EPA to support environmental education projects that help people gain awareness and understanding of environmental issues. Schools, nonprofits, colleges, and tribal organizations may apply. Projects may include curriculum development, teacher training, student field investigations, and school-based environmental action projects focused on STEM and sustainability.',
    url: 'https://www.epa.gov/education/environmental-education-ee-grants',
    applicant_types: ['school', 'nonprofit', 'organization'],
    categories: ['environment', 'education', 'stem'],
    type: 'grant',
    fundingType: 'competitive_grant',
    maxAmount: 100000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['environmental_education', 'science', 'school', 'k12', 'sustainability'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // FEDERAL — AMERICORPS
  // ════════════════════════════════════════
  {
    id: 'school-americorps',
    name: 'AmeriCorps School-Based Programs',
    description: 'AmeriCorps grants fund programs that deploy national service members to support K-12 schools with tutoring, mentoring, literacy support, and after-school programming. Schools partner with nonprofits and AmeriCorps programs such as AmeriCorps Seniors, AmeriCorps VISTA, and AmeriCorps State and National to bring volunteer tutors and mentors into classrooms and after-school settings.',
    url: 'https://americorps.gov/partner/how-to-work-with-americorps/grants',
    applicant_types: ['school', 'nonprofit', 'organization'],
    categories: ['education', 'volunteer', 'tutoring'],
    type: 'grant',
    fundingType: 'competitive_grant',
    maxAmount: 400000,
    isGrant: true,
    source: 'federal',
    intentMatch: ['tutoring', 'mentoring', 'school', 'k12', 'reading_support'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // PRIVATE / NONPROFIT FOUNDATION
  // ════════════════════════════════════════
  {
    id: 'school-dollar-general-literacy',
    name: 'Dollar General Literacy Foundation Grants',
    description: 'Grants from the Dollar General Literacy Foundation to support literacy and education initiatives for K-12 schools, nonprofit organizations, and libraries. Programs include school grants for summer reading, adult literacy grants, and GED/diploma grants. School grants typically fund books, reading materials, and literacy programs during summer months to combat learning loss.',
    url: 'https://www.dgliteracy.org/',
    applicant_types: ['school', 'nonprofit', 'organization'],
    categories: ['education', 'literacy', 'reading'],
    type: 'grant',
    fundingType: 'private_grant',
    maxAmount: 5000,
    isGrant: true,
    source: 'private',
    intentMatch: ['literacy', 'reading', 'school', 'k12', 'adult_literacy'],
    is_active: true,
  },

  {
    id: 'school-nea-foundation',
    name: 'NEA Foundation Student Achievement Grants',
    description: 'Grants from the NEA Foundation to public school educators in grades preK-12 to fund innovative learning projects that improve student achievement. Grants of up to $5,000 support projects that use research-based strategies to help students master challenging academic content. Projects may involve collaborative, hands-on learning, technology integration, or cross-disciplinary approaches.',
    url: 'https://www.neafoundation.org/for-educators/student-achievement-grants/',
    applicant_types: ['school', 'organization'],
    categories: ['education', 'classroom', 'professional_development'],
    type: 'grant',
    fundingType: 'private_grant',
    maxAmount: 5000,
    isGrant: true,
    source: 'private',
    intentMatch: ['teacher_grant', 'classroom_supplies', 'school', 'k12', 'innovation'],
    is_active: true,
  },

];
