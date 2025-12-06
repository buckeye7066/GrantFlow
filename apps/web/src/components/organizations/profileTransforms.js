const DEFAULT_TYPE = 'organization';

const sanitizeAddress = (address = {}, formData = {}) => {
  const city = formData.city ?? address.city ?? '';
  const state = formData.state ?? address.state ?? '';
  const county = formData.county ?? address.county ?? '';
  const zip = formData.zip ?? address.zip ?? '';

  return {
    city,
    state,
    county,
    zip,
  };
};

export const mapProfileToOrganization = (profile) => {
  if (!profile) return null;

  const qualifiers = profile.qualifiers ?? {};
  const address = typeof profile.address === 'object' ? profile.address ?? {} : {};

  const name = profile.name ?? qualifiers.name ?? 'Untitled Profile';
  const applicantType = profile.type ?? qualifiers.applicant_type ?? DEFAULT_TYPE;

  return {
    ...qualifiers,
    ...profile,
    id: profile.id,
    name,
    applicant_type: applicantType,
    city: qualifiers.city ?? address.city ?? '',
    state: qualifiers.state ?? address.state ?? '',
    created_by: profile.createdBy ?? qualifiers.created_by ?? null,
    address,
    qualifiers,
  };
};

export const profileInputFromForm = (formData, userEmail, existingProfile) => {
  const existingQualifiers = existingProfile?.qualifiers ?? {};
  const mergedQualifiers = { ...existingQualifiers, ...(formData ?? {}) };

  if (userEmail) {
    mergedQualifiers.created_by = userEmail;
  }

  const existingAddress =
    typeof existingProfile?.address === 'object' ? existingProfile?.address ?? {} : {};
  const normalizedAddress = sanitizeAddress(existingAddress, mergedQualifiers);

  return {
    type: mergedQualifiers.applicant_type ?? existingProfile?.type ?? DEFAULT_TYPE,
    name: mergedQualifiers.name ?? existingProfile?.name ?? 'Untitled Profile',
    email:
      mergedQualifiers.email ??
      mergedQualifiers.contact_email ??
      existingProfile?.email ??
      null,
    phone:
      mergedQualifiers.phone ??
      mergedQualifiers.contact_phone ??
      existingProfile?.phone ??
      null,
    address: normalizedAddress,
    coreFlags: mergedQualifiers.coreFlags ?? existingProfile?.coreFlags ?? {},
    qualifiers: mergedQualifiers,
    createdBy: userEmail ?? existingProfile?.createdBy ?? null,
  };
};

