const CORE_BOOLEAN_FIELDS = new Set([
  "ED_PELL_ELIGIBLE",
  "ED_FIRST_GEN",
  "ED_TITLE_I_SCHOOL",
  "GOVT_MEDICAID_ECF_CHOICES",
  "GOVT_SNAP",
  "GOVT_SECTION_8",
  "GOVT_LIHEAP",
  "HEALTH_DISABILITY",
  "GEO_QCT",
  "GEO_OPPORTUNITY_ZONE",
  "MILITARY_VETERAN",
  "FAMILY_FOSTER_YOUTH",
  "FAMILY_HOMELESS",
]);

const CORE_STRING_FIELDS = new Set([
  "ED_INTENDED_MAJOR",
  "ED_TARGET_COLLEGES",
  "ED_CURRENT_COLLEGE",
  "OCCUPATION_PRIMARY",
  "RELIGION_AFFILIATION",
]);

const CORE_NUMBER_FIELDS = new Set([
  "ED_GPA",
  "ED_ACT_SCORE",
  "ED_SAT_SCORE",
  "FIN_HOUSEHOLD_INCOME",
  "FIN_HOUSEHOLD_SIZE",
]);

export function extractCoreFieldsFromQualifiers(qualifiers = {}) {
  const core = Object.create(null);

  for (const [code, value] of Object.entries(qualifiers)) {
    if (CORE_BOOLEAN_FIELDS.has(code)) {
      const normalized = value === true ||
        value === "true" ||
        value === 1 ||
        value === "1";
      core[code] = normalized;
      continue;
    }

    if (CORE_STRING_FIELDS.has(code)) {
      if (typeof value === "string" && value.trim().length > 0) {
        core[code] = value.trim();
      } else if (
        Array.isArray(value) &&
        value.length > 0
      ) {
        core[code] = value.map((entry) => String(entry).trim()).join(", ");
      }
      continue;
    }

    if (CORE_NUMBER_FIELDS.has(code)) {
      const numeric = Number(value);
      if (!Number.isNaN(numeric)) {
        core[code] = numeric;
      }
    }
  }

  return core;
}

export function mergeQualifiers(previous = {}, incoming = {}) {
  if (!incoming || typeof incoming !== "object") {
    return { ...previous };
  }

  const next = { ...previous };

  for (const [code, value] of Object.entries(incoming)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      next[code] = value.filter((entry) =>
        entry !== null && entry !== undefined && String(entry).trim().length > 0
      );
      continue;
    }

    next[code] = value;
  }

  return next;
}

export function listFundingAxes(qualifiers = {}) {
  const axes = [];

  const checks = [
    ["ED_PELL_ELIGIBLE", "Pell Grant Eligible"],
    ["ED_FIRST_GEN", "First Generation Student"],
    ["ED_TITLE_I_SCHOOL", "Title I School"],
    ["GEO_QCT", "Qualified Census Tract"],
    ["GEO_OPPORTUNITY_ZONE", "Opportunity Zone"],
    ["GOVT_MEDICAID_ECF_CHOICES", "Medicaid ECF CHOICES Waiver"],
    ["GOVT_SNAP", "SNAP Recipient"],
    ["FAMILY_FOSTER_YOUTH", "Foster Youth"],
    ["FAMILY_HOMELESS", "Housing Insecure"],
    ["HEALTH_DISABILITY", "Disability"],
    ["MILITARY_VETERAN", "Veteran or Military Household"],
  ];

  for (const [code, label] of checks) {
    if (qualifiers?.[code]) {
      axes.push({ code, label });
    }
  }

  return axes;
}

export function deriveProfileSummary(profile = {}) {
  const segments = [];

  if (profile.primary_type) {
    segments.push(`Profile Type: ${profile.primary_type}`);
  }

  if (profile.address) {
    const { city, state, county } = profile.address;
    const parts = [city, state, county].filter(Boolean);
    if (parts.length > 0) {
      segments.push(`Geography: ${parts.join(", ")}`);
    }
  }

  if (profile.qualifiers) {
    const axes = listFundingAxes(profile.qualifiers);
    if (axes.length > 0) {
      segments.push(
        `Funding Axes: ${axes.map((axis) => axis.label).join(", ")}`,
      );
    }
  }

  if (profile.core_fields) {
    const gpa = profile.core_fields.ED_GPA;
    if (typeof gpa === "number") {
      segments.push(`GPA: ${gpa}`);
    }
    const income = profile.core_fields.FIN_HOUSEHOLD_INCOME;
    if (typeof income === "number") {
      segments.push(`Household Income: $${income.toLocaleString()}`);
    }
  }

  return segments.join("\n");
}
