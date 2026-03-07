/**
 * profileAnalyzer.js
 * 
 * Extracts a structured needs assessment from a GrantFlow profile.
 * Every downstream crawler reads ONLY from this output.
 * 
 * Output shape (mirrors EVERY field from the GrantFlow application):
 *   location:       { state, city, zip, county }
 *   applicantType:  'individual' | 'organization' | 'student'
 *   needs:          Set<string> — auto-detected from gov. assistance, health, family, keywords
 *   demographics:   Set<string> — race, gender, age brackets, first_generation
 *   health:         Set<string> — from conditions array + all boolean flags (cancer, dialysis, TBI, etc.)
 *   family:         Set<string> — all life situation flags (single_parent, foster, trafficking, etc.)
 *   military:       Set<string> — all military fields (veteran, active_duty, gold_star, etc.)
 *   occupation:     Set<string> — healthcare_worker, educator, firefighter, farmer, etc.
 *   immigration:    Set<string> — refugee, new_immigrant, permanent_resident
 *   geographic:     Set<string> — rural, appalachian, urban_underserved
 *   income:         { bracket, belowPovertyLine, householdSize, householdIncome }
 *   education:      { level, currentSchool, targetColleges, intendedMajor, gpa, act, sat,
 *                     firstGeneration, communityServiceHours, valedictorian, leadershipRoles,
 *                     extracurriculars, achievements, stemStudent, returningAdult, recentGraduate,
 *                     gedGraduate, jobRetraining, studentGradeLevels, schoolZips, schoolStates }
 *   interests:      Set<string> — from extracurriculars, achievements, focus_areas, keywords
 *   sports:         Set<string> — subset of interests that are athletics/activities
 *   organization:   { is501c3, samRegistered, faithBased, ein, uei, ... } (org profiles only)
 *   keywords:       string[] — flat searchable text for downstream matchers
 */

const STATE_ABBREVS = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS',
  'kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD','massachusetts':'MA',
  'michigan':'MI','minnesota':'MN','mississippi':'MS','missouri':'MO','montana':'MT',
  'nebraska':'NE','nevada':'NV','new hampshire':'NH','new jersey':'NJ',
  'new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',
  'ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA','rhode island':'RI',
  'south carolina':'SC','south dakota':'SD','tennessee':'TN','texas':'TX',
  'utah':'UT','vermont':'VT','virginia':'VA','washington':'WA','west virginia':'WV',
  'wisconsin':'WI','wyoming':'WY','district of columbia':'DC',
};

function normalizeState(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^[A-Z]{2}$/.test(s)) return s;
  if (/^[A-Z]{2}$/.test(s.toUpperCase())) return s.toUpperCase();
  return STATE_ABBREVS[s.toLowerCase()] || null;
}

function lower(val) { return String(val || '').toLowerCase().trim(); }

function collectValues(obj, ...paths) {
  const vals = [];
  for (const path of paths) {
    let cur = obj;
    for (const key of path.split('.')) {
      if (!cur || typeof cur !== 'object') { cur = null; break; }
      cur = cur[key];
    }
    if (cur === true) vals.push(path.split('.').pop());
    else if (typeof cur === 'string' && cur.trim()) vals.push(cur.trim());
    else if (Array.isArray(cur)) cur.forEach(v => {
      if (typeof v === 'string') vals.push(v);
      else if (v?.name) vals.push(v.name);
    });
  }
  return vals.filter(Boolean);
}

// ── Need detection keywords ──
const NEED_MAP = {
  utilities:          ['utilities','utility','electric','gas','water','energy','heating','cooling','lieap','liheap','power bill'],
  housing:            ['housing','rent','mortgage','shelter','homeless','section 8','home repair','eviction'],
  food:               ['food','snap','groceries','hunger','nutrition','wic','food bank','meals','food pantry'],
  healthcare:         ['health','medical','medicaid','medicare','insurance','dental','vision','prescription','clinic'],
  cash_assistance:    ['cash','tanf','income','financial','money','emergency fund','general assistance','wv works'],
  employment:         ['employment','job','work','career','workforce','training','vocational'],
  childcare:          ['childcare','child care','daycare','head start','preschool'],
  education:          ['education','school','college','tuition','scholarship','student aid','ged','pell'],
  transportation:     ['transportation','transit','bus','vehicle','car repair'],
  disability:         ['disability','disabled','ssi','ssdi','accommodation','adaptive'],
  mental_health:      ['mental health','counseling','therapy','behavioral','crisis','depression','anxiety'],
  substance_recovery: ['substance','addiction','recovery','sober','rehab','opioid'],
  legal:              ['legal','court','lawyer','attorney','immigration'],
  clothing:           ['clothing','clothes','uniform','school supplies'],
  internet:           ['internet','broadband','wifi','connectivity','acp','lifeline phone'],
  weatherization:     ['weatherization','insulation','energy efficiency','home improvement','hvac'],
  burial:             ['burial','funeral','cremation'],
  tax:                ['tax','eitc','vita','tax prep'],
  scholarship:        ['scholarship','fafsa','financial aid','pell grant','endowment','merit','tuition assistance','student aid','oneapp'],
  business:           ['business','entrepreneur','startup','self-employ','microenterprise','small business','sba','freelance','side hustle','llc','sole proprietor'],
};

/** Coerce a value into an array. Handles JSON strings, objects, null/undefined, etc. */
function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* not JSON */ }
  }
  return [];
}

/**
 * @param {Object} db - Database handle
 * @param {string|Object} profileOrId
 * @returns {Object} Structured needs assessment
 */
export async function analyzeProfile(db, profileOrId) {
  let profile, sections;

  if (typeof profileOrId === 'string') {
    profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileOrId);
    if (!profile) throw new Error(`Profile not found: ${profileOrId}`);
    const rows = await db.prepare(
      'SELECT section_key, data FROM profile_sections WHERE profile_id = ?'
    ).all(profileOrId);
    sections = {};
    for (const r of (rows || [])) {
      try { sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; }
      catch { /* skip */ }
    }

    // Fallback: if profile_sections is empty, hydrate from profiles table columns
    if (Object.keys(sections).length === 0 && profile) {
      console.log('[ProfileAnalyzer] Fallback: hydrating sections from profiles table columns');
      const COL_MAP = {
        basic_information: 'basic_information',
        education_information: 'education',
        employment_information: 'employment',
        health_information: 'health_medical',
        financial_information: 'financial_information',
        housing_information: 'housing',
      };
      for (const [col, secKey] of Object.entries(COL_MAP)) {
        if (profile[col]) {
          try {
            const parsed = typeof profile[col] === 'string' ? JSON.parse(profile[col]) : profile[col];
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
              sections[secKey] = parsed;
            }
          } catch { /* skip unparseable */ }
        }
      }

      // additional_information contains mixed family/military/demographic fields —
      // hydrate into the section keys the analyzer expects
      if (profile.additional_information) {
        try {
          const addl = typeof profile.additional_information === 'string'
            ? JSON.parse(profile.additional_information) : profile.additional_information;
          if (addl && typeof addl === 'object') {
            if (!sections.family_life) sections.family_life = addl;
            if (!sections.military_service && (addl.veteran !== undefined || addl.active_duty !== undefined))
              sections.military_service = addl;
          }
        } catch { /* skip */ }
      }
    }
  } else {
    profile = profileOrId;
    sections = profile.sections || {};
  }

  const basic     = sections.basic_information || {};
  const health    = sections.health_medical || sections.medical || {};
  const medHist   = sections.medical_history || {};
  const medIns    = sections.medical_insurance || {};
  const family    = sections.family_life || sections.family || {};
  const mil       = sections.military_service || {};
  const edu       = sections.education || {};
  const fin       = sections.financial_information || sections.financial || {};
  const gov       = sections.government_assistance || {};
  const loc       = sections.location_focus || {};
  const occ       = sections.occupation || {};
  const housing   = sections.housing || {};
  const employ    = sections.employment || {};
  const narr      = sections.narrative || {};
  const comp      = sections.comprehensive_application || {};
  const npComp    = sections.nonprofit_compliance || {};
  const smBiz     = sections.small_business_details || {};
  // Alternate-schema medical section (UUID profiles store 'medical' instead of 'health_medical')
  const medAlt    = sections.medical || {};

  // ── Location (handle nested address objects AND plain address strings) ──
  const rawAddr = basic.address;
  const addr = (rawAddr && typeof rawAddr === 'object') ? rawAddr : {};
  const addrStr = typeof rawAddr === 'string' ? rawAddr : '';
  const compAddr = (sections.comprehensive_application || {}).address || {};

  // Parse state/city/county from a free-text address like "Cleveland, Tennessee (Bradley County)"
  let parsedState = null, parsedCity = null, parsedCounty = null;
  if (addrStr) {
    for (const [fullName, abbr] of Object.entries(STATE_ABBREVS)) {
      if (addrStr.toLowerCase().includes(fullName)) { parsedState = abbr; break; }
    }
    if (!parsedState) {
      const stMatch = addrStr.match(/\b([A-Z]{2})\b/);
      if (stMatch && Object.values(STATE_ABBREVS).includes(stMatch[1])) parsedState = stMatch[1];
    }
    const cityMatch = addrStr.match(/^([^,]+),/);
    if (cityMatch) parsedCity = cityMatch[1].trim();
    const countyMatch = addrStr.match(/\(([^)]+?)\s*County\)/i) || addrStr.match(/(\w+)\s+County/i);
    if (countyMatch) parsedCounty = countyMatch[1].trim();
  }

  const location = {
    state:  normalizeState(profile.state || basic.state || addr.state || loc.state || loc.primary_state || compAddr.state || parsedState),
    city:   (profile.city || basic.city || addr.city || loc.city || compAddr.city || parsedCity || '').trim() || null,
    zip:    (String(profile.zip_code || profile.zip || basic.zip_code || addr.zip_code || addr.zip || addr.postal_code || '').match(/(\d{5})/) || [])[1] || null,
    county: (basic.county || addr.county || loc.county || profile.county || parsedCounty || '').trim() || null,
  };

  // ── Applicant Type ──
  const primaryType = lower(profile.primary_type);
  const compApplicantType = lower(comp.applicant_type || basic.profile_category || '');
  let rawTags = profile.tags;
  if (typeof rawTags === 'string') { try { rawTags = JSON.parse(rawTags); } catch { rawTags = []; } }
  const tags = (Array.isArray(rawTags) ? rawTags : []).map(lower);
  let applicantType = 'individual';
  if (['organization','nonprofit','business','church','school'].some(t => primaryType.includes(t) || tags.includes(t) || compApplicantType.includes(t)))
    applicantType = 'organization';
  if (['student','college_student','graduate_student','high_school_student'].some(t => primaryType === t || tags.includes(t) || compApplicantType.includes(t))
      || edu.gpa || comp.gpa || (comp.student_grade_levels && comp.student_grade_levels.length > 0))
    applicantType = 'student';

  // ── Needs ──
  const needs = new Set();
  const rawKeywords = [...tags, ...collectValues(sections, 'basic_information.primary_needs', 'basic_information.assistance_needed'), primaryType].map(lower);
  for (const kw of rawKeywords) {
    for (const [need, triggers] of Object.entries(NEED_MAP)) {
      if (triggers.some(t => kw.includes(t))) needs.add(need);
    }
  }
  // Default needs for individual profiles with nothing specific
  if (needs.size === 0 && (primaryType.includes('individual') || primaryType.includes('general') || primaryType.includes('assistance'))) {
    ['utilities','housing','food','healthcare','cash_assistance'].forEach(n => needs.add(n));
  }

  // ── Demographics (profile schema + comprehensive application) ──
  const demographics = new Set();
  const demoSection = sections.demographics || {};
  const demoNotes = lower(demoSection.notes || '');
  const age = parseInt(basic.age || profile.age || comp.age) || null;
  if (age >= 65) demographics.add('senior');
  if (age && age < 25) demographics.add('youth');
  if (comp.young_adult || (age && age >= 18 && age <= 24)) demographics.add('young_adult');
  if (comp.minor_child || (age && age < 18)) demographics.add('minor');
  let gender = lower(basic.gender || profile.gender);
  if (!gender && demoNotes.includes('gender: female')) gender = 'female';
  if (!gender && demoNotes.includes('gender: male')) gender = 'male';
  if (['female','woman','f'].includes(gender)) demographics.add('female');
  if (['male','man','m'].includes(gender)) demographics.add('male');
  if (demoSection.african_american === true || comp.african_american === true) demographics.add('african_american');
  if (demoSection.hispanic_latino === true || comp.hispanic_latino === true) demographics.add('hispanic_latino');
  if (demoSection.asian_american === true || comp.asian_american === true) demographics.add('asian_american');
  if (demoSection.native_american === true || comp.native_american === true) demographics.add('native_american');
  if (demoSection.tribal_affiliation || comp.tribal_affiliation) demographics.add('native_american');
  if (demoSection.lgbtq === true || comp.lgbtq === true) demographics.add('lgbtq');
  if (demoSection.first_generation === true || comp.first_generation === true) demographics.add('first_generation');
  const race = lower(basic.race_ethnicity || basic.race || '');
  if (race.includes('african') || race.includes('black')) demographics.add('african_american');
  if (race.includes('hispanic') || race.includes('latino')) demographics.add('hispanic_latino');
  if (race.includes('asian')) demographics.add('asian_american');
  if (race.includes('native') || race.includes('indigenous')) demographics.add('native_american');

  // ── Health (conditions array + all boolean flags from application) ──
  const healthSignals = new Set();
  const conditions = collectValues(sections, 'health_medical.conditions', 'health_medical.disability_type',
    'medical.conditions', 'medical.disability_type', 'medical.disabilities');
  // Also include notes from health/medical sections as free-text condition hints
  const healthNotes = lower([health.notes, medAlt.notes, health.chronic_illness_type].filter(Boolean).join(' '));
  for (const c of [...conditions.map(lower), ...(healthNotes.length > 0 ? healthNotes.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : [])]) {
    if (c.includes('disab')) healthSignals.add('disability');
    if (c.includes('cancer')) healthSignals.add('cancer');
    if (c.includes('kidney') || c.includes('dialysis')) healthSignals.add('kidney_disease');
    if (c.includes('mental') || c.includes('depression') || c.includes('anxiety') || c.includes('ptsd')) healthSignals.add('mental_health');
    if (c.includes('heart') || c.includes('cardiac')) healthSignals.add('heart_disease');
    if (c.includes('blind') || c.includes('visual')) healthSignals.add('visual_impairment');
    if (c.includes('deaf') || c.includes('hearing')) healthSignals.add('hearing_impairment');
    if (c.includes('cerebral') || c.includes('spinal') || c.includes('wheelchair')) healthSignals.add('physical_disability');
    if (c.includes('chronic')) healthSignals.add('chronic_illness');
    if (c.includes('hiv') || c.includes('aids')) healthSignals.add('hiv_aids');
    if (c.includes('substance') || c.includes('addiction')) healthSignals.add('substance_recovery');
    if (c.includes('ms') || c.includes('multiple sclerosis')) healthSignals.add('multiple_sclerosis');
    if (c.includes('lupus') || c.includes('fibro') || c.includes('copd')) healthSignals.add('chronic_illness');
    if (c.includes('diabetes')) healthSignals.add('diabetes');
    if (c.includes('intellectual') || c.includes('developmental') || c.includes('i/dd') || c.includes('autism')) healthSignals.add('developmental_disability');
    if (c.includes('tbi') || c.includes('traumatic brain')) healthSignals.add('tbi');
  }
  // Boolean flags from health_medical section (directly from application form)
  if (health.disability_status || profile.disability_status) healthSignals.add('disability');
  if (health.cancer_survivor || comp.cancer_survivor) healthSignals.add('cancer');
  if (health.chronic_illness || comp.chronic_illness) healthSignals.add('chronic_illness');
  if (health.dialysis_patient || comp.dialysis_patient) healthSignals.add('kidney_disease');
  if (health.organ_transplant || comp.organ_transplant) healthSignals.add('organ_transplant');
  if (health.hiv_aids || comp.hiv_aids) healthSignals.add('hiv_aids');
  if (health.tbi_survivor || comp.tbi_survivor) healthSignals.add('tbi');
  if (health.amputee || comp.amputee) healthSignals.add('physical_disability');
  if (health.neurodivergent || comp.neurodivergent) healthSignals.add('neurodivergent');
  if (health.visual_impairment || comp.visual_impairment) healthSignals.add('visual_impairment');
  if (health.hearing_impairment || comp.hearing_impairment) healthSignals.add('hearing_impairment');
  if (health.wheelchair_user || comp.wheelchair_user) healthSignals.add('physical_disability');
  if (health.substance_recovery || comp.substance_recovery) healthSignals.add('substance_recovery');
  if (health.mental_health_condition || comp.mental_health_condition) healthSignals.add('mental_health');
  // Medical history section
  if (medHist.primary_condition) {
    const pc = lower(medHist.primary_condition);
    if (pc.includes('cancer')) healthSignals.add('cancer');
    if (pc.includes('kidney') || pc.includes('dialysis') || pc.includes('renal')) healthSignals.add('kidney_disease');
    if (pc.includes('heart') || pc.includes('cardiac')) healthSignals.add('heart_disease');
    if (pc.includes('diabetes')) healthSignals.add('diabetes');
  }
  if (Array.isArray(medHist.secondary_conditions)) {
    for (const sc of medHist.secondary_conditions.map(lower)) {
      if (sc.includes('cancer')) healthSignals.add('cancer');
      if (sc.includes('diabetes')) healthSignals.add('diabetes');
    }
  }
  if (Array.isArray(medHist.dme_needed) && medHist.dme_needed.length > 0) healthSignals.add('disability');
  if (medHist.mobility_needs) healthSignals.add('physical_disability');

  // Propagate health → needs
  if (healthSignals.has('disability') || healthSignals.has('physical_disability') || healthSignals.has('visual_impairment') || healthSignals.has('hearing_impairment') || healthSignals.has('developmental_disability'))
    needs.add('disability');
  if (healthSignals.has('mental_health')) needs.add('mental_health');
  if (healthSignals.has('substance_recovery')) needs.add('substance_recovery');
  if (healthSignals.has('cancer') || healthSignals.has('kidney_disease') || healthSignals.has('heart_disease') || healthSignals.has('chronic_illness'))
    needs.add('healthcare');

  // ── Family & Life Situation (all application fields) ──
  const familySignals = new Set();
  if (family.single_parent || comp.single_parent) familySignals.add('single_parent');
  if (family.caregiver || family.family_caregiver || comp.caregiver) familySignals.add('caregiver');
  if (family.foster_youth || comp.foster_youth) familySignals.add('foster_youth');
  if (family.orphan || comp.orphan) familySignals.add('orphan');
  if (family.adopted || comp.adopted) familySignals.add('adopted');
  if (family.foster_parent || comp.foster_parent) familySignals.add('foster_parent');
  if (family.widow_widower || comp.widow_widower) familySignals.add('widow');
  if (family.grandparent_raising_grandchildren || comp.grandparent_raising_grandchildren) familySignals.add('grandparent_caregiver');
  if (family.first_time_parent || comp.first_time_parent) familySignals.add('first_time_parent');
  if (family.homeless || family.housing_insecure || comp.homeless || housing.status === 'homeless') { familySignals.add('homeless'); needs.add('housing'); }
  if (family.domestic_violence_survivor || comp.domestic_violence_survivor) { familySignals.add('domestic_violence'); needs.add('housing'); needs.add('legal'); }
  if (family.trafficking_survivor || comp.trafficking_survivor) { familySignals.add('trafficking_survivor'); needs.add('housing'); needs.add('legal'); }
  if (family.disaster_survivor || comp.disaster_survivor) { familySignals.add('disaster_survivor'); needs.add('housing'); }
  if (family.formerly_incarcerated || comp.formerly_incarcerated) familySignals.add('formerly_incarcerated');
  const householdSize = parseInt(family.household_size || basic.household_size || fin.household_size || comp.household_size) || null;
  if (family.has_children || family.dependents > 0 || (householdSize > 1)) familySignals.add('has_children');
  if (comp.minor_child) familySignals.add('has_children');
  if (housing.status === 'at-risk') needs.add('housing');

  // ── Military (all application fields) ──
  const militarySignals = new Set();
  if (mil.veteran || profile.veteran || comp.veteran) { militarySignals.add('veteran'); demographics.add('veteran'); }
  if (mil.disabled_veteran || comp.disabled_veteran) { militarySignals.add('disabled_veteran'); militarySignals.add('veteran'); healthSignals.add('disability'); }
  if (mil.active_duty || mil.active_duty_military || comp.active_duty_military) militarySignals.add('active_duty');
  if (mil.national_guard || comp.national_guard) militarySignals.add('national_guard');
  if (mil.spouse || mil.military_spouse || comp.military_spouse) militarySignals.add('military_spouse');
  if (mil.military_dependent || comp.military_dependent) militarySignals.add('military_dependent');
  if (mil.gold_star_family || comp.gold_star_family) militarySignals.add('gold_star_family');

  // ── Income & Financial ──
  const income = {
    bracket: fin.annual_income_bracket || fin.income_bracket || null,
    belowPovertyLine: fin.below_poverty_line || fin.low_income || comp.low_income || false,
    householdSize,
    householdIncome: parseFloat(fin.household_income || comp.household_income) || null,
  };
  if (income.belowPovertyLine) needs.add('cash_assistance');
  if (fin.unemployed || comp.unemployed) { needs.add('employment'); needs.add('cash_assistance'); }
  if (fin.displaced_worker || comp.displaced_worker) needs.add('employment');

  // ── Government Assistance → auto-detect needs ──
  if (gov.medicaid_enrolled || comp.medicaid_enrolled) needs.add('healthcare');
  if (gov.medicare_recipient || comp.medicare_recipient) needs.add('healthcare');
  if (gov.ssi_recipient || comp.ssi_recipient) { needs.add('disability'); needs.add('cash_assistance'); }
  if (gov.ssdi_recipient || comp.ssdi_recipient) { needs.add('disability'); needs.add('cash_assistance'); }
  if (gov.snap_recipient || comp.snap_recipient) needs.add('food');
  if (gov.tanf_recipient || comp.tanf_recipient) needs.add('cash_assistance');
  if (gov.section8_housing || comp.section8_housing) needs.add('housing');
  if (gov.medicaid_waiver_program && gov.medicaid_waiver_program !== 'none') needs.add('healthcare');

  // ── Assistance programs from medical section (alternate schema) ──
  const assistPrograms = Array.isArray(medAlt.assistance_programs) ? medAlt.assistance_programs.map(lower) : [];
  for (const prog of assistPrograms) {
    if (prog.includes('ssdi')) { needs.add('disability'); needs.add('cash_assistance'); }
    if (prog.includes('ssi')) { needs.add('disability'); needs.add('cash_assistance'); }
    if (prog.includes('medicaid')) needs.add('healthcare');
    if (prog.includes('medicare')) needs.add('healthcare');
    if (prog.includes('snap')) needs.add('food');
    if (prog.includes('tanf')) needs.add('cash_assistance');
    if (prog.includes('section') && prog.includes('8')) needs.add('housing');
    if (prog.includes('liheap')) needs.add('utilities');
    if (prog.includes('wic')) needs.add('food');
  }

  // ── Occupation signals ──
  const occupationSignals = new Set();
  if (occ.healthcare_worker || comp.healthcare_worker) occupationSignals.add('healthcare_worker');
  if (occ.healthcare_worker_type) occupationSignals.add(lower(occ.healthcare_worker_type));
  if (occ.ems_worker || comp.ems_worker) occupationSignals.add('ems_worker');
  if (occ.educator || comp.educator) occupationSignals.add('educator');
  if (occ.firefighter || comp.firefighter) occupationSignals.add('firefighter');
  if (occ.law_enforcement || comp.law_enforcement) occupationSignals.add('law_enforcement');
  if (occ.public_servant || comp.public_servant) occupationSignals.add('public_servant');
  if (occ.clergy || comp.clergy) occupationSignals.add('clergy');
  if (occ.missionary || comp.missionary) occupationSignals.add('missionary');
  if (occ.nonprofit_employee || comp.nonprofit_employee) occupationSignals.add('nonprofit_employee');
  if (occ.small_business_owner || comp.small_business_owner) occupationSignals.add('small_business_owner');
  if (occ.minority_owned_business || comp.is_minority_owned_business_owner || comp.minority_owned_certification) occupationSignals.add('minority_owned_business');
  if (occ.women_owned_business || comp.is_women_owned_business_owner || comp.women_owned_certification) occupationSignals.add('women_owned_business');
  if (occ.union_member || comp.union_member) occupationSignals.add('union_member');
  if (occ.farmer || comp.farmer) occupationSignals.add('farmer');
  if (occ.truck_driver || comp.truck_driver) occupationSignals.add('truck_driver');

  // ── Immigration / Citizenship signals ──
  const immigrationSignals = new Set();
  const immStatusRaw = lower(comp.immigration_status || (sections.demographics || {}).immigrant_status || '').split(/[\n\r]+/)[0].trim();
  if (immStatusRaw && immStatusRaw !== 'us_citizen' && immStatusRaw !== 'unknown') immigrationSignals.add(immStatusRaw);
  if (comp.permanent_resident || immStatusRaw.includes('permanent_resident') || immStatusRaw.includes('permanent resident')) immigrationSignals.add('permanent_resident');
  if (comp.refugee || immStatusRaw.includes('refugee')) { immigrationSignals.add('refugee'); needs.add('housing'); needs.add('legal'); }
  if (comp.new_immigrant || immStatusRaw.includes('new_immigrant') || immStatusRaw.includes('new immigrant')) immigrationSignals.add('new_immigrant');

  // ── Geographic qualifiers ──
  const geoSignals = new Set();
  if (loc.rural_resident || comp.rural_resident || comp.serves_rural_area) geoSignals.add('rural');
  if (loc.appalachian_region || comp.appalachian_region) geoSignals.add('appalachian');
  if (loc.urban_underserved || comp.urban_underserved) geoSignals.add('urban_underserved');
  // Also check demographic geographic_qualifiers array (from application form)
  const demoGeo = demoSection.geographic_qualifiers || [];
  if (Array.isArray(demoGeo)) {
    for (const g of demoGeo.map(lower)) {
      if (g.includes('rural')) geoSignals.add('rural');
      if (g.includes('appalachian')) geoSignals.add('appalachian');
      if (g.includes('urban') && g.includes('underserved')) geoSignals.add('urban_underserved');
    }
  }

  // ── Housing → needs ──
  if (housing.broadband_speed && lower(housing.broadband_speed).includes('no')) needs.add('internet');
  if (housing.status === 'shelter' || housing.status === 'transitional') needs.add('housing');

  // ── Narrative/Barriers → keyword extraction for broader matching ──
  const narrativeText = lower([
    narr.barriers_faced, narr.special_circumstances, narr.mission, narr.primary_goal,
    narr.statement_of_need, narr.goals,
    employ.career_goal, employ.notes,
    family.notes, family.responsibilities,
    health.notes, medAlt.notes,
    housing.notes,
  ].filter(Boolean).join(' '));
  for (const [need, triggers] of Object.entries(NEED_MAP)) {
    if (triggers.some(t => narrativeText.includes(t))) needs.add(need);
  }

  // ── Education / Student signals (full application coverage) ──
  const uniApps = Array.isArray(sections.university_applications?.applications)
    ? sections.university_applications.applications : [];
  const progServices = sections.programs_services || {};
  const education = {
    level: edu.highest_level || null,
    currentSchool: edu.current_institution || comp.current_college || null,
    targetColleges: edu.target_colleges || comp.target_colleges || uniApps.map(a => a.name).filter(Boolean),
    intendedMajor: edu.intended_major || comp.intended_major || uniApps.find(a => a.intended_major)?.intended_major || null,
    gpa: parseFloat(edu.gpa || comp.gpa) || uniApps.reduce((best, a) => Math.max(best, parseFloat(a.avg_gpa || a.gpa) || 0), 0) || null,
    act: parseInt(edu.act_score || comp.act_score) || uniApps.reduce((best, a) => Math.max(best, parseInt(a.act_score || a.act) || 0), 0) || null,
    sat: parseInt(edu.sat_score || comp.sat_score) || uniApps.reduce((best, a) => Math.max(best, parseInt(a.sat_score || a.sat) || 0), 0) || null,
    firstGeneration: edu.first_generation || sections.demographics?.first_generation || comp.first_generation || false,
    communityServiceHours: parseInt(edu.community_service_hours || comp.community_service_hours) || null,
    valedictorian: edu.valedictorian || false,
    leadershipRoles: edu.leadership_roles || [],
    extracurriculars: comp.extracurricular_activities || [],
    achievements: comp.achievements || [],
    stemStudent: comp.stem_student || false,
    returningAdult: comp.returning_adult_student || false,
    recentGraduate: comp.recent_graduate || false,
    gedGraduate: comp.ged_graduate || false,
    jobRetraining: comp.job_retraining || false,
    studentGradeLevels: comp.student_grade_levels || [],
    schoolZips: uniApps.map(a => a.zip).filter(Boolean),
    schoolStates: [...new Set(uniApps.map(a => normalizeState(a.state)).filter(Boolean))],
  };

  // ── Per-school portal/contact data (from university application cards) ──
  const schools = uniApps.filter(a => a.name).map(app => ({
    name: app.name,
    id: app.id || null,
    status: app.status || 'planning',
    state: normalizeState(app.state) || null,
    city: app.city || null,
    zip: app.zip || null,
    website: app.website_url || null,
    fafsaCode: app.fafsa_code || null,
    tuition: parseFloat(app.tuition) || null,
    portals: {
      financialAid: app.portals?.financial_aid_url || null,
      admissions: app.portals?.admissions_url || null,
      studentPortal: app.portals?.student_portal_url || null,
      counseling: app.portals?.counseling_url || null,
      transcripts: app.portals?.transcripts_url || null,
      sendScores: app.portals?.send_scores_url || null,
    },
    actions: {
      apply: app.actions?.apply_url || null,
      payFee: app.actions?.pay_fee_url || null,
      visit: app.actions?.visit_url || null,
    },
    contacts: safeArray(app.contacts).filter(c => c.name || c.email || c.phone || c.url).map(c => ({
      label: c.label || 'Contact',
      name: c.name || null,
      title: c.title || null,
      email: c.email || null,
      phone: c.phone || null,
      url: c.url || null,
    })),
    departmentContacts: safeArray(app.department_contacts).filter(c => c.area || c.name).map(c => ({
      area: c.area || null,
      category: c.category || null,
      genderTarget: c.gender_target || 'any',
      name: c.name || null,
      title: c.title || null,
      email: c.email || null,
      phone: c.phone || null,
      url: c.url || null,
    })),
    interests: app.interests || [],
    financialAidDeadline: app.financial_aid_deadline || null,
    applicationDeadline: app.application_deadline || null,
  }));

  // Interests from university applications + programs_services + extracurriculars + achievements
  const interests = new Set();
  for (const app of uniApps) {
    if (Array.isArray(app.interests)) app.interests.forEach(i => interests.add(lower(i)));
    if (app.intended_major) interests.add(lower(app.intended_major));
  }
  if (Array.isArray(progServices.interests)) progServices.interests.forEach(i => interests.add(lower(i)));
  if (Array.isArray(progServices.focus_areas)) progServices.focus_areas.forEach(f => interests.add(lower(f)));
  if (Array.isArray(edu.interests)) edu.interests.forEach(i => interests.add(lower(i)));
  if (edu.field_of_study) interests.add(lower(edu.field_of_study));
  if (edu.intended_major) interests.add(lower(edu.intended_major));
  if (comp.intended_major) interests.add(lower(comp.intended_major));
  if (Array.isArray(comp.extracurricular_activities)) comp.extracurricular_activities.forEach(a => interests.add(lower(a)));
  if (Array.isArray(comp.achievements)) comp.achievements.forEach(a => interests.add(lower(a)));
  if (Array.isArray(comp.focus_areas)) comp.focus_areas.forEach(f => interests.add(lower(f)));
  if (Array.isArray(comp.keywords)) comp.keywords.forEach(k => interests.add(lower(k)));
  if (comp.stem_student) interests.add('stem');
  if (employ.career_goal) interests.add(lower(employ.career_goal));

  // Sports detection (gender-specific for matching)
  const sports = new Set();
  const SPORT_KEYWORDS = ['basketball','football','soccer','volleyball','baseball','softball','tennis',
    'swimming','track','cross country','golf','wrestling','lacrosse','hockey','gymnastics','cheerleading',
    'cheer','dance','rowing','crew','field hockey','water polo','bowling','rifle','fencing','archery',
    'equestrian','rugby','skiing','diving','band','marching band','orchestra','choir','debate','drama','theater'];
  for (const interest of interests) {
    if (SPORT_KEYWORDS.some(s => interest.includes(s))) sports.add(interest);
  }

  if (applicantType === 'student') {
    needs.add('education');
    needs.add('scholarship');
    if (education.firstGeneration) demographics.add('first_generation');
    if (education.stemStudent) interests.add('stem');
  }

  // ── Organization-specific signals ──
  const orgSignals = {};
  if (applicantType === 'organization') {
    orgSignals.is501c3 = npComp.is_501c3 || comp.business_501c3_certified || false;
    orgSignals.samRegistered = npComp.sam_registered || comp.sam_gov_registered || false;
    orgSignals.faithBased = comp.faith_based_organization || false;
    orgSignals.veteranOwned = comp.veteran_owned_business || false;
    orgSignals.ein = comp.organization_ein || '';
    orgSignals.uei = comp.organization_uei || '';
    orgSignals.annualBudget = comp.annual_budget || null;
    orgSignals.nteeCode = comp.ntee_code || '';
    if (smBiz.naics_code) orgSignals.naicsCode = smBiz.naics_code;
    if (smBiz.certifications) orgSignals.certifications = smBiz.certifications;
  }

  // ── Keywords (searchable text for downstream matching) ──
  const keywords = [
    ...tags,
    ...collectValues(sections, 'basic_information.primary_needs', 'basic_information.assistance_needed'),
    primaryType, compApplicantType,
    ...[...needs],
    ...[...interests],
    ...(education.intendedMajor ? [education.intendedMajor] : []),
    ...(education.targetColleges || []),
    ...(education.extracurriculars || []),
    ...(education.achievements || []),
    ...[...healthSignals],
    ...[...familySignals],
    ...[...militarySignals],
    ...[...occupationSignals],
    ...[...immigrationSignals],
    ...[...geoSignals],
    ...[...sports],
    ...(Array.isArray(progServices.keywords) ? progServices.keywords : []),
    ...(narr.barriers_faced ? [narr.barriers_faced] : []),
    ...(narr.special_circumstances ? [narr.special_circumstances] : []),
    ...(employ.career_goal ? [employ.career_goal] : []),
  ].map(lower).filter(v => v && v.length > 1);

  const result = {
    profileId: profile.id,
    profileName: profile.display_name || profile.name || null,
    location,
    applicantType,
    needs,
    demographics,
    health: healthSignals,
    family: familySignals,
    military: militarySignals,
    occupation: occupationSignals,
    immigration: immigrationSignals,
    geographic: geoSignals,
    income,
    education,
    interests,
    sports,
    schools,
    keywords,
    ...(applicantType === 'organization' ? { organization: orgSignals } : {}),
  };

  console.log(`[ProfileAnalyzer] ${result.profileName}: type=${applicantType}, state=${location.state}, needs=[${[...needs]}], demographics=[${[...demographics]}], occupation=[${[...occupationSignals]}], geo=[${[...geoSignals]}]`);
  return result;
}

export default { analyzeProfile };
