export interface Opportunity {
  id: string;
  canonicalId: string;
  title: string;
  opportunityNumber?: string;
  assistanceListingNumber?: string;
  funderId?: string;
  funderName?: string;
  sourceConnectorId: string;
  sourceConnectorName?: string;
  sourceUrl: string;
  canonicalApplicationUrl?: string;
  applicantTypes: string[];
  status: 'open' | 'forecasted' | 'recurring' | 'rolling' | 'closed' | 'canceled' | 'archived';
  awardMin?: number;
  awardMax?: number;
  estimatedTotal?: number;
  openingDate?: string;
  deadline?: string;
  lastRetrievedAt: string;
  lastChangedAt?: string;
  lastVerifiedAt?: string;
  provenance?: Record<string, string>;
  confidence?: number;
}

export interface MatchResult {
  id: string;
  applicantProfileId: string;
  opportunityId: string;
  overallScore: number;
  eligibilityResult: 'pass' | 'fail' | 'unknown';
  programRelevanceScore: number;
  competitivenessScore: number;
  readinessScore: number;
  factorContributions: Array<{ factor: string; score: number; contribution: number; detail: string }>;
  matchReasons: string[];
  mismatchReasons: string[];
  missingProfileFields: string[];
  disqualifyingConditions: string[];
  sourceEvidence: Array<{ field: string; sourceConnectorName: string; sourceUrl?: string }>;
  confidence: number;
  recommendedAction: string;
  generatedAt: string;
}

export interface Funder {
  id: string;
  legalName: string;
  aliases?: string[];
  ein?: string;
  funderType?: string;
  parentFunderId?: string;
  website?: string;
  typicalAwardMin?: number;
  typicalAwardMax?: number;
  awardFrequency?: string;
  repeatRecipientRate?: number;
  newRecipientRate?: number;
  provenance?: Record<string, string>;
}

export interface HistoricalAward {
  id: string;
  funderId: string;
  recipientName: string;
  amount: number;
  fiscalYear: number;
  purpose: string;
  isOpenOpportunity: false;
}

export interface Application {
  id: string;
  opportunityId: string;
  applicantProfileId: string;
  stage: string;
  assignedOwners: string[];
  confirmationNumber?: string;
  submittedAt?: string;
  submissionVerified: boolean;
  outcome?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalSection {
  id: string;
  applicationId: string;
  sectionType: string;
  content: string;
  charLimit?: number;
  wordLimit?: number;
  unsupportedClaimFlags: string[];
  reusedLanguageFlags: string[];
  citations: string[];
  reviewStatus: string;
}

export interface Task {
  id: string;
  applicationId?: string;
  title: string;
  ownerId?: string;
  dueDate?: string;
  reminderAt?: string;
  status: 'todo' | 'in-progress' | 'done' | 'blocked';
}

export interface SourceConnector {
  id: string;
  name: string;
  sourceType: string;
  authType: string;
  requiredCredentialKey?: string;
  isCredentialSatisfied: boolean;
  healthStatus: 'healthy' | 'degraded' | 'down' | 'unconfigured';
  lastSuccessfulSyncAt?: string;
  lastError?: string;
  enabled: boolean;
}
