import { z } from 'zod';

export const applicantTypes = [
  'nonprofit','business','individual','researcher','university',
  'faith-based','government','tribal','healthcare','community-group','artist',
] as const;

export const profileSchema = z.object({
  applicantType: z.enum(applicantTypes),
  orgName: z.string().min(1, 'Organization or individual name is required'),
  ein: z.string().optional(),
  taxStatus: z.string().optional(),
  missionStatement: z.string().min(10, 'Please describe your mission in at least 10 characters'),
  geographicServiceArea: z.string().min(1, 'Service area is required'),
  subjectAreas: z.array(z.string()).min(1, 'Select at least one subject area'),
  populationsServed: z.array(z.string()).optional(),
  annualBudget: z.number().optional(),
  requestedAmountRange: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
  aiUsageConsent: z.boolean().refine((v) => v === true, 'Consent is required to use AI features'),
});

export type ProfileForm = z.infer<typeof profileSchema>;

export const sectionSchema = z.object({
  sectionType: z.string().min(1),
  content: z.string(),
  charLimit: z.number().optional(),
  wordLimit: z.number().optional(),
});
