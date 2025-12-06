import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DollarSign, User, Building2, GraduationCap, Heart, TrendingDown, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

/**
 * Real-time billing calculator that updates based on application form data
 * Determines pricing tier, discounts, and displays relevant service options
 */
export default function BillingCalculator({ formData }) {
  // Determine client category based on form data
  const clientCategory = useMemo(() => {
    const { applicant_type, annual_budget, household_income } = formData;

    // Individuals and families
    if (['high_school_student', 'college_student', 'graduate_student', 'individual_need', 'medical_assistance', 'family'].includes(applicant_type)) {
      return {
        category: 'individual_household',
        label: 'Individual / Household',
        icon: User,
        color: 'text-blue-600',
        bgColor: 'bg-blue-50',
        borderColor: 'border-blue-200'
      };
    }

    // Organizations - size-based
    if (applicant_type === 'organization') {
      const budget = parseFloat(annual_budget) || 0;
      
      if (budget === 0 || budget < 250000) {
        return {
          category: 'small_ministry_nonprofit',
          label: 'Small Organization',
          icon: Building2,
          color: 'text-green-600',
          bgColor: 'bg-green-50',
          borderColor: 'border-green-200',
          description: 'Annual budget under $250,000'
        };
      } else if (budget < 2000000) {
        return {
          category: 'midsize_org',
          label: 'Mid-Size Organization',
          icon: Building2,
          color: 'text-purple-600',
          bgColor: 'bg-purple-50',
          borderColor: 'border-purple-200',
          description: 'Annual budget $250K - $2M'
        };
      } else {
        return {
          category: 'large_org',
          label: 'Large Organization',
          icon: Building2,
          color: 'text-indigo-600',
          bgColor: 'bg-indigo-50',
          borderColor: 'border-indigo-200',
          description: 'Annual budget over $2M'
        };
      }
    }

    // Default
    return {
      category: 'individual_household',
      label: 'Individual / Household',
      icon: User,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      borderColor: 'border-blue-200'
    };
  }, [formData.applicant_type, formData.annual_budget]);

  // Check for hardship qualification
  const qualifiesForHardship = useMemo(() => {
    const { applicant_type, household_income } = formData;
    
    // Individuals/families with low income
    if (['individual_need', 'medical_assistance', 'family'].includes(applicant_type)) {
      const income = parseFloat(household_income) || 0;
      return income < 30000; // Hardship threshold
    }
    
    return false;
  }, [formData.applicant_type, formData.household_income]);

  // Check for ministry discount
  const qualifiesForMinistryDiscount = useMemo(() => {
    const { applicant_type, annual_budget, organization_type } = formData;
    
    if (applicant_type === 'organization') {
      const budget = parseFloat(annual_budget) || 0;
      // Churches/ministries with budget under $250K
      return budget < 250000 && (
        organization_type === 'church' || 
        organization_type === 'ministry' ||
        formData.mission?.toLowerCase().includes('church') ||
        formData.mission?.toLowerCase().includes('ministry')
      );
    }
    
    return false;
  }, [formData.applicant_type, formData.annual_budget, formData.organization_type, formData.mission]);

  // Base pricing structure
  const basePricing = {
    individual_household: {
      hourlyRate: 85,
      quickScan: 149,
      comprehensiveDossier: 399,
      microGrant: { min: 600, max: 1200 },
      standardGrant: { min: 2000, max: 5000 }
    },
    small_ministry_nonprofit: {
      hourlyRate: 85,
      quickScan: 349,
      comprehensiveDossier: 1250,
      microGrant: { min: 600, max: 1200 },
      standardGrant: { min: 2000, max: 5000 }
    },
    midsize_org: {
      hourlyRate: 115,
      quickScan: 349,
      comprehensiveDossier: 2400,
      standardGrant: { min: 2000, max: 5000 },
      complexFederal: { min: 5000, max: 12000 }
    },
    large_org: {
      hourlyRate: 150,
      quickScan: 750,
      comprehensiveDossier: 3800,
      standardGrant: { min: 2000, max: 5000 },
      complexFederal: { min: 5000, max: 12000 }
    }
  };

  // Hardship pricing overrides
  const hardshipPricing = {
    quickScan: { min: 0, max: 49 },
    comprehensiveDossier: { min: 99, max: 199 },
    microGrant: { max: 250 },
    scholarship: { min: 99, max: 199 }
  };

  // Get applicable pricing
  const pricing = qualifiesForHardship 
    ? hardshipPricing 
    : basePricing[clientCategory.category];

  // Ministry discount calculation (25%)
  const applyMinistryDiscount = (amount) => {
    return qualifiesForMinistryDiscount ? amount * 0.75 : amount;
  };

  const Icon = clientCategory.icon;

  return (
    <div className="space-y-4">
      {/* Client Category Card */}
      <Card className={`border-2 ${clientCategory.borderColor} ${clientCategory.bgColor}`}>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg bg-white`}>
              <Icon className={`w-6 h-6 ${clientCategory.color}`} />
            </div>
            <div className="flex-1">
              <CardTitle className="text-lg">{clientCategory.label}</CardTitle>
              {clientCategory.description && (
                <CardDescription>{clientCategory.description}</CardDescription>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Discount Badges */}
      {(qualifiesForHardship || qualifiesForMinistryDiscount) && (
        <div className="space-y-2">
          {qualifiesForHardship && (
            <Alert className="border-rose-300 bg-rose-50">
              <Heart className="w-4 h-4 text-rose-600" />
              <AlertDescription className="text-rose-900">
                <strong>Hardship Pricing Applied</strong> - Special reduced rates available
              </AlertDescription>
            </Alert>
          )}
          
          {qualifiesForMinistryDiscount && (
            <Alert className="border-emerald-300 bg-emerald-50">
              <Building2 className="w-4 h-4 text-emerald-600" />
              <AlertDescription className="text-emerald-900">
                <strong>Ministry Discount: 25% Off</strong> - All services
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {/* Pricing Options */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <DollarSign className="w-5 h-5" />
            Your Pricing Options
          </CardTitle>
          <CardDescription>
            Based on your profile, here are your service options and rates
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Hourly Rate */}
          {!qualifiesForHardship && (
            <div className="p-3 bg-purple-50 rounded-lg border border-purple-200">
              <div className="flex justify-between items-center">
                <div>
                  <p className="font-semibold text-slate-900">Hourly Rate</p>
                  <p className="text-xs text-slate-600">Flexible pay-as-you-go</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-purple-600">
                    ${applyMinistryDiscount(pricing.hourlyRate)}/hr
                  </p>
                  {qualifiesForMinistryDiscount && (
                    <p className="text-xs text-slate-500 line-through">${pricing.hourlyRate}/hr</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Quick Eligibility Scan */}
          <div className="p-3 bg-green-50 rounded-lg border border-green-200">
            <div className="flex justify-between items-center">
              <div className="flex-1">
                <p className="font-semibold text-slate-900">Quick Eligibility Scan</p>
                <p className="text-xs text-slate-600">Top 10-20 opportunities identified</p>
              </div>
              <div className="text-right">
                {qualifiesForHardship ? (
                  <>
                    <p className="text-2xl font-bold text-green-600">
                      ${pricing.quickScan.min}-${pricing.quickScan.max}
                    </p>
                    <p className="text-xs text-slate-600">Sliding scale</p>
                  </>
                ) : (
                  <>
                    <p className="text-2xl font-bold text-green-600">
                      ${applyMinistryDiscount(pricing.quickScan)}
                    </p>
                    {qualifiesForMinistryDiscount && (
                      <p className="text-xs text-slate-500 line-through">${pricing.quickScan}</p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Comprehensive Dossier */}
          <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
            <div className="flex justify-between items-center">
              <div className="flex-1">
                <p className="font-semibold text-slate-900">Comprehensive Funding Dossier</p>
                <p className="text-xs text-slate-600">50+ opportunities, detailed analysis</p>
              </div>
              <div className="text-right">
                {qualifiesForHardship ? (
                  <>
                    <p className="text-2xl font-bold text-blue-600">
                      ${pricing.comprehensiveDossier.min}-${pricing.comprehensiveDossier.max}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-2xl font-bold text-blue-600">
                      ${applyMinistryDiscount(pricing.comprehensiveDossier)}
                    </p>
                    {qualifiesForMinistryDiscount && (
                      <p className="text-xs text-slate-500 line-through">${pricing.comprehensiveDossier}</p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Application Writing */}
          {!qualifiesForHardship && (
            <>
              {pricing.microGrant && (
                <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                  <div className="flex justify-between items-center">
                    <div className="flex-1">
                      <p className="font-semibold text-slate-900">Micro-Grant Application</p>
                      <p className="text-xs text-slate-600">Awards under $5,000</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-amber-600">
                        ${applyMinistryDiscount(pricing.microGrant.min)}-${applyMinistryDiscount(pricing.microGrant.max)}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {pricing.standardGrant && (
                <div className="p-3 bg-indigo-50 rounded-lg border border-indigo-200">
                  <div className="flex justify-between items-center">
                    <div className="flex-1">
                      <p className="font-semibold text-slate-900">Standard Foundation Grant</p>
                      <p className="text-xs text-slate-600">Full proposal package</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-indigo-600">
                        ${applyMinistryDiscount(pricing.standardGrant.min)}-${applyMinistryDiscount(pricing.standardGrant.max)}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {pricing.complexFederal && (
                <div className="p-3 bg-violet-50 rounded-lg border border-violet-200">
                  <div className="flex justify-between items-center">
                    <div className="flex-1">
                      <p className="font-semibold text-slate-900">Complex Federal Grant</p>
                      <p className="text-xs text-slate-600">Comprehensive federal proposal</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-violet-600">
                        ${applyMinistryDiscount(pricing.complexFederal.min)}-${applyMinistryDiscount(pricing.complexFederal.max)}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Hardship Note */}
          {qualifiesForHardship && (
            <Alert>
              <Info className="w-4 h-4" />
              <AlertDescription className="text-sm">
                Hardship pricing is available on a sliding scale based on your specific situation. 
                We'll work with you to find an affordable solution.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Payment Terms */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Payment Terms</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-600 space-y-2">
          <p>• <strong>Milestone-Based:</strong> 40% deposit, 40% at draft, 20% at submission</p>
          <p>• <strong>Hourly:</strong> Invoiced weekly/bi-weekly, Net 15 days</p>
          <p>• <strong>Accepted Methods:</strong> Check, Venmo, CashApp, ACH, Credit Card</p>
          {!qualifiesForHardship && (
            <p>• <strong>Bill-to-Grant:</strong> Available when allowed by funder (no upfront cost)</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}