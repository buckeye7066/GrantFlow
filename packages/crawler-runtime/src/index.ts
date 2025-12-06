import { z } from 'zod';

const AddressSchema = z.object({
  city: z.string().optional(),
  state: z.string().optional(),
  county: z.string().optional(),
  zip: z.string().optional(),
});

export function buildSearchStrategy(profile: any) {
  const qualifiers = profile.qualifiers ?? {};
  const addressResult = AddressSchema.safeParse(profile.address ?? {});
  const address = addressResult.success ? addressResult.data : {};

  const keywords = new Set<string>();

  if (qualifiers.ED_PELL_ELIGIBLE) keywords.add('Pell Grant');
  if (qualifiers.ED_FIRST_GEN) keywords.add('first-generation college student');
  if (qualifiers.ED_TITLE_I_SCHOOL) keywords.add('Title I school');

  const majors = qualifiers.ED_INTENDED_MAJOR ?? [];
  for (const major of Array.isArray(majors) ? majors : [majors]) {
    if (major) keywords.add(`${major} scholarship`);
  }

  return {
    geography: {
      state: address.state ?? null,
      county: address.county ?? null,
      city: address.city ?? null,
      zip: address.zip ?? null,
    },
    keywords: Array.from(keywords),
    assistancePrograms: Object.entries(qualifiers)
      .filter(([key, value]) => key.startsWith('GOVT_') && value)
      .map(([key]) => key),
    fundingAxes: deriveFundingAxes(qualifiers),
  };
}

export function deriveFundingAxes(qualifiers: Record<string, any>) {
  const axes: { code: string; label: string }[] = [];
  const mapping: Record<string, string> = {
    ED_PELL_ELIGIBLE: 'Pell Grant Eligible',
    ED_FIRST_GEN: 'First Generation Student',
    ED_TITLE_I_SCHOOL: 'Title I School',
    GOVT_MEDICAID_ECF_CHOICES: 'Medicaid ECF CHOICES',
    GOVT_SNAP: 'SNAP Recipient',
    FAMILY_FOSTER_YOUTH: 'Foster Youth',
    FAMILY_HOMELESS: 'Housing Insecure',
    HEALTH_DISABILITY: 'Disability',
    MILITARY_VETERAN: 'Veteran or Military Household',
  };

  for (const [code, label] of Object.entries(mapping)) {
    if (qualifiers?.[code]) {
      axes.push({ code, label });
    }
  }

  return axes;
}

