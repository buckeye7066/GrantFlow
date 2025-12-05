/**
 * UNIVERSAL CRAWLER FRAMEWORK
 */

import { logPHIAccess } from "./phiAuditLogger.js";
import { randomUUID } from "node:crypto";

export const PROFILE_SECTIONS = [
  "identity",
  "education",
  "military",
  "health",
  "financials",
  "interests",
  "household",
  "goals",
];

export const SECTION_FIELDS = {
  identity: [
    "name",
    "age",
    "date_of_birth",
    "race_ethnicity",
    "gender",
    "immigration_status",
  ],
  education: [
    "gpa",
    "intended_major",
    "current_college",
    "target_colleges",
    "first_generation",
    "grade_levels",
  ],
  military: [
    "veteran",
    "active_duty_military",
    "military_spouse",
    "military_branch",
  ],
  health: [
    "health_conditions",
    "disabilities",
    "icd10_codes",
    "primary_diagnosis",
  ],
  financials: [
    "household_income",
    "low_income",
    "government_assistance",
    "financial_challenges",
  ],
  interests: ["focus_areas", "program_areas", "keywords"],
  household: ["household_size", "single_parent", "caregiver"],
  goals: ["primary_goal", "goals", "funding_need"],
};

export function filterRepaymentOpportunities(opportunities) {
  const keywords = [
    "loan",
    "repay",
    "repayment",
    "interest rate",
    "monthly payment",
    "credit score",
    "borrower",
    "lender",
    "debt",
    "financing",
  ];

  return opportunities.filter((opp) => {
    const title = opp.title ?? "";
    const description = opp.descriptionMd ?? "";
    const sponsor = opp.sponsor ?? "";
    const t = `${title} ${description} ${sponsor}`.trim().toLowerCase();
    for (const kw of keywords) {
      if (t.includes(kw)) {
        if (t.includes("forgiveness") || t.includes("repayment assistance")) {
          return true;
        }
        return false;
      }
    }
    return true;
  });
}

export function requiresRepayment(opportunity = {}) {
  if (!opportunity) return { requires: false };

  if (typeof opportunity.requires_repayment === "boolean") {
    return {
      requires: opportunity.requires_repayment,
      reason: opportunity.requires_repayment
        ? "Opportunity metadata marks it as requiring repayment."
        : undefined,
    };
  }

  const fields = [
    opportunity.title,
    opportunity.descriptionMd,
    opportunity.description,
    opportunity.summary,
    opportunity.notes,
    opportunity.details,
  ];

  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return { requires: false };

  const keywords = [
    { token: "loan", reason: "Mentions loan terms." },
    { token: "repay", reason: "Mentions repayment requirements." },
    { token: "repayment", reason: "Mentions repayment requirements." },
    { token: "interest rate", reason: "Lists an interest rate." },
    { token: "monthly payment", reason: "References monthly payments." },
    { token: "borrower", reason: "Refers to borrowers." },
    { token: "lender", reason: "Refers to lenders." },
    { token: "debt", reason: "Mentions debt obligations." },
    { token: "financing", reason: "References financing terms." },
    { token: "microloan", reason: "Mentions micro-loan products." },
    { token: "line of credit", reason: "References line of credit." },
  ];

  for (const { token, reason } of keywords) {
    if (haystack.includes(token)) {
      if (
        haystack.includes("forgivable") ||
        haystack.includes("repayment assistance")
      ) {
        return { requires: false };
      }
      return { requires: true, reason };
    }
  }

  if (opportunity.type && /\bloan\b/i.test(opportunity.type)) {
    return { requires: true, reason: "Opportunity type indicates a loan." };
  }

  return { requires: false };
}

export function buildSearchStrategyForProfile(profile = {}) {
  const strategy = {
    geography: {
      state: profile.address?.state ?? null,
      county: profile.address?.county ?? null,
      city: profile.address?.city ?? null,
      zip: profile.address?.zip ?? null,
      qct: profile.qualifiers?.GEO_QCT === true,
      opportunityZone: profile.qualifiers?.GEO_OPPORTUNITY_ZONE === true,
    },
    education: {
      primaryType: profile.primary_type ?? null,
      majors: [],
      targetColleges: [],
      currentCollege: null,
      gpa: profile.core_fields?.ED_GPA ?? null,
    },
    assistancePrograms: [],
    keywords: new Set(),
    excludedKeywords: new Set(),
  };

  const qualifiers = profile.qualifiers ?? {};

  if (
    profile.primary_type === "High School Student" ||
    profile.primary_type === "College Student"
  ) {
    if (qualifiers.ED_PELL_ELIGIBLE) strategy.keywords.add("Pell Grant");
    if (qualifiers.ED_FIRST_GEN) {
      strategy.keywords.add("first-generation college student");
    }
    if (qualifiers.ED_TITLE_I_SCHOOL) strategy.keywords.add("Title I");
  }

  if (
    Array.isArray(qualifiers.ED_TARGET_COLLEGES) &&
    qualifiers.ED_TARGET_COLLEGES.length > 0
  ) {
    strategy.education.targetColleges = qualifiers.ED_TARGET_COLLEGES;
    for (const college of qualifiers.ED_TARGET_COLLEGES) {
      strategy.keywords.add(String(college));
    }
  } else if (profile.core_fields?.ED_TARGET_COLLEGES) {
    strategy.education.targetColleges = String(
      profile.core_fields.ED_TARGET_COLLEGES,
    )
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const college of strategy.education.targetColleges) {
      strategy.keywords.add(college);
    }
  }

  if (
    qualifiers.ED_CURRENT_COLLEGE || profile.core_fields?.ED_CURRENT_COLLEGE
  ) {
    const current = qualifiers.ED_CURRENT_COLLEGE ??
      profile.core_fields.ED_CURRENT_COLLEGE;
    strategy.education.currentCollege = current;
    strategy.keywords.add(String(current));
  }

  if (qualifiers.ED_INTENDED_MAJOR || profile.core_fields?.ED_INTENDED_MAJOR) {
    const majors = qualifiers.ED_INTENDED_MAJOR ??
      profile.core_fields.ED_INTENDED_MAJOR;
    const majorList = Array.isArray(majors)
      ? majors
      : String(majors).split(",");
    for (const major of majorList) {
      const trimmed = String(major).trim();
      if (trimmed.length > 0) {
        strategy.education.majors.push(trimmed);
        strategy.keywords.add(`${trimmed} scholarship`);
      }
    }
  }

  if (qualifiers.GOVT_MEDICAID_ECF_CHOICES) {
    strategy.assistancePrograms.push("Medicaid ECF CHOICES");
    strategy.keywords.add("Medicaid waiver");
    strategy.keywords.add("ECF CHOICES");
  }
  if (qualifiers.GOVT_SNAP) strategy.assistancePrograms.push("SNAP");
  if (qualifiers.GOVT_SECTION_8) strategy.assistancePrograms.push("Section 8");
  if (qualifiers.GOVT_LIHEAP) strategy.assistancePrograms.push("LIHEAP");

  if (qualifiers.HEALTH_DISABILITY) strategy.keywords.add("disability support");
  if (qualifiers.MILITARY_VETERAN) strategy.keywords.add("veteran benefits");
  if (qualifiers.FAMILY_FOSTER_YOUTH) {
    strategy.keywords.add("foster youth program");
  }
  if (qualifiers.FAMILY_HOMELESS) strategy.keywords.add("housing assistance");

  return strategy;
}

export function isOpportunityActive(opportunity) {
  if (!opportunity.deadlineAt) return true;
  try {
    return new Date(opportunity.deadlineAt) >= new Date();
  } catch {
    return true;
  }
}

export function extractSectionData(profile, section) {
  const fields = SECTION_FIELDS[section] || [];
  const out = {};
  for (const f of fields) {
    if (profile[f] !== undefined && profile[f] !== null && profile[f] !== "") {
      out[f] = profile[f];
    }
  }
  return out;
}

export async function safeCrawlerWrapper(sdk, {
  crawlerName,
  profile,
  profileId,
  organizationId,
  crawlFn,
  user,
  options = {},
}) {
  const requestId = randomUUID().slice(0, 8);
  const start = Date.now();

  console.log(
    `[${crawlerName}:${requestId}] Starting crawl for profile ${profileId}`,
  );

  await logPHIAccess(sdk, {
    user,
    action: "crawl_for_profile",
    entity: "Organization",
    entity_id: organizationId,
    function_name: crawlerName,
  });

  try {
    const raw = await crawlFn(profile, options);

    if (!raw || !Array.isArray(raw)) {
      return {
        opportunities: [],
        stats: { total: 0, filtered: 0, duration: Date.now() - start },
      };
    }

    let filtered = raw;

    if (!options.includeLoans) {
      filtered = filterRepaymentOpportunities(filtered);
    }

    if (!options.includeExpired) {
      filtered = filtered.filter(isOpportunityActive);
    }

    const seen = new Set();
    filtered = filtered.filter((opp) => {
      const key = opp.source_id || opp.url || opp.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const tagged = filtered.map((opp) => ({
      ...opp,
      profile_id: profileId,
      organization_id: organizationId,
      crawled_by: crawlerName,
      crawled_at: new Date().toISOString(),
    }));

    try {
      await sdk.entities.CrawlLog.create({
        source: crawlerName,
        status: "success",
        results_count: tagged.length,
        profile_id: profileId,
        duration_ms: Date.now() - start,
      });
    } catch (logErr) {
      console.warn(`[${crawlerName}] CrawlLog write failed:`, logErr?.message);
    }

    return {
      opportunities: tagged,
      stats: {
        total: raw.length,
        filtered: tagged.length,
        duration: Date.now() - start,
      },
    };
  } catch (error) {
    try {
      await sdk.entities.CrawlLog.create({
        source: crawlerName,
        status: "error",
        error_message: String(error?.message || error),
        profile_id: profileId,
        duration_ms: Date.now() - start,
      });
    } catch (logErr) {
      console.warn(
        `[${crawlerName}] CrawlLog error write failed:`,
        logErr?.message,
      );
    }

    throw error;
  }
}

export function crawlerSuccess(data, message = "Success") {
  return { ok: true, message, data };
}

export function crawlerError(message, details = null) {
  return { ok: false, error: message, details };
}

export function isGeographicallyRelevant(opportunity, profile) {
  if (opportunity.is_national) return true;
  const oppState = opportunity.state?.toLowerCase();
  const profState = profile.state?.toLowerCase();
  if (!oppState || !profState) return true;
  if (oppState === profState) return true;
  if (Array.isArray(opportunity.regions)) {
    const r = opportunity.regions.map((x) => x.toLowerCase());
    if (r.includes(profState)) return true;
    if (r.includes("national") || r.includes("all states")) return true;
  }
  return false;
}

export function isStudentEligible(opportunity, profile) {
  const studentTypes = [
    "high_school_student",
    "college_student",
    "graduate_student",
  ];
  const isStudent = studentTypes.includes(profile.applicant_type);

  const t = `${opportunity.title || ""} ${opportunity.descriptionMd || ""}`
    .toLowerCase();
  const kws = [
    "student",
    "scholarship",
    "undergraduate",
    "graduate",
    "college",
    "university",
  ];
  const studentOpp = kws.some((k) => t.includes(k));

  if (studentOpp && !isStudent) return false;
  return true;
}

export function isECFEligible(opportunity, profile) {
  const kws = ["exceptional", "children", "ecf", "disability", "special needs"];
  const t = `${opportunity.title || ""} ${opportunity.descriptionMd || ""}`
    .toLowerCase();
  const isECF = kws.some((k) => t.includes(k));

  if (isECF) {
    const hasDisability = (profile.disabilities?.length > 0) ||
      (profile.health_conditions?.length > 0) ||
      (profile.icd10_codes?.length > 0);
    return hasDisability;
  }
  return true;
}

export const STATE_ABBREVIATIONS = {
  "alabama": "AL",
  "alaska": "AK",
  "arizona": "AZ",
  "arkansas": "AR",
  "california": "CA",
  "colorado": "CO",
  "connecticut": "CT",
  "delaware": "DE",
  "florida": "FL",
  "georgia": "GA",
  "hawaii": "HI",
  "idaho": "ID",
  "illinois": "IL",
  "indiana": "IN",
  "iowa": "IA",
  "kansas": "KS",
  "kentucky": "KY",
  "louisiana": "LA",
  "maine": "ME",
  "maryland": "MD",
  "massachusetts": "MA",
  "michigan": "MI",
  "minnesota": "MN",
  "mississippi": "MS",
  "missouri": "MO",
  "montana": "MT",
  "nebraska": "NE",
  "nevada": "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  "ohio": "OH",
  "oklahoma": "OK",
  "oregon": "OR",
  "pennsylvania": "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  "tennessee": "TN",
  "texas": "TX",
  "utah": "UT",
  "vermont": "VT",
  "virginia": "VA",
  "washington": "WA",
  "west virginia": "WV",
  "wisconsin": "WI",
  "wyoming": "WY",
};

export function getStateAbbreviation(stateName) {
  if (!stateName) return null;
  const n = stateName.toLowerCase().trim();
  return STATE_ABBREVIATIONS[n] || stateName.toUpperCase();
}
