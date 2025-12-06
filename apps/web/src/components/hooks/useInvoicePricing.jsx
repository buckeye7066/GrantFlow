import { useMemo } from 'react';

/**
 * Custom hook for invoice pricing calculations
 * Handles client categorization, rate determination, fee calculation, and discounts
 */
export function useInvoicePricing(formData, selectedOrg, settings, timeEntries) {
  return useMemo(() => {
    if (!selectedOrg || !settings) return null;

    const result = {
      category: 'large_org',
      qualifiesForHardship: false,
      qualifiesForMinistryDiscount: false,
      qualifiesForProBono: selectedOrg.pro_bono || false,
      baseRate: settings.hourly_rates?.large_org || 150,
      calculatedFee: 0,
      discountAmount: 0,
      discountDescription: '',
      finalFee: 0,
    };

    // Determine category
    if (['individual_need', 'medical_assistance', 'family', 'high_school_student', 'college_student', 'graduate_student'].includes(selectedOrg.applicant_type)) {
      result.category = 'individual_household';
      result.baseRate = settings.hourly_rates?.individual_household || 85;
    } else if (selectedOrg.annual_budget && selectedOrg.annual_budget < 250000) {
      result.category = 'small_ministry_nonprofit';
      result.baseRate = settings.hourly_rates?.small_ministry_nonprofit || 85;
    } else if (selectedOrg.annual_budget && selectedOrg.annual_budget <= 2000000) {
      result.category = 'midsize_org';
      result.baseRate = settings.hourly_rates?.midsize_org || 115;
    }

    // Check hardship qualifications
    const hardshipQualifiers = [
      selectedOrg.ssi_recipient,
      selectedOrg.ssdi_recipient,
      selectedOrg.medicaid_enrolled && selectedOrg.medicaid_waiver_program === 'ecf_choices',
      selectedOrg.cancer_survivor && selectedOrg.cancer_diagnosis_year && (new Date().getFullYear() - selectedOrg.cancer_diagnosis_year <= 5),
      selectedOrg.medicaid_enrolled,
      selectedOrg.household_income && selectedOrg.household_size && (selectedOrg.household_income / selectedOrg.household_size < 25000),
      selectedOrg.domestic_violence_survivor,
      selectedOrg.trafficking_survivor,
      selectedOrg.disaster_survivor,
      selectedOrg.clergy && selectedOrg.household_income && selectedOrg.household_income < 40000,
    ];

    result.qualifiesForHardship = hardshipQualifiers.some(q => q === true);

    // Check ministry discount
    result.qualifiesForMinistryDiscount = 
      (selectedOrg.faith_based || selectedOrg.clergy || selectedOrg.missionary) && 
      (!selectedOrg.annual_budget || selectedOrg.annual_budget < 250000);

    // Calculate fee based on service type
    const serviceType = formData.service_type;
    if (serviceType && settings.flat_fees) {
      const fees = settings.flat_fees;
      
      switch (serviceType) {
        case 'quick_scan':
          if (result.category === 'individual_household') {
            result.calculatedFee = fees.quick_eligibility_scan_individual || 149;
          } else if (result.category === 'small_ministry_nonprofit') {
            result.calculatedFee = fees.quick_eligibility_scan_small || 349;
          } else {
            result.calculatedFee = fees.quick_eligibility_scan_large || 750;
          }
          break;
        
        case 'comprehensive_dossier':
          if (result.category === 'individual_household') {
            result.calculatedFee = fees.comprehensive_dossier_individual || 399;
          } else if (result.category === 'small_ministry_nonprofit') {
            result.calculatedFee = fees.comprehensive_dossier_small || 1250;
          } else if (result.category === 'midsize_org') {
            result.calculatedFee = fees.comprehensive_dossier_mid || 2400;
          } else {
            result.calculatedFee = fees.comprehensive_dossier_large || 3800;
          }
          break;
        
        case 'micro_grant':
          result.calculatedFee = fees.micro_grant_min || 600;
          break;
        
        case 'standard_foundation':
          result.calculatedFee = fees.standard_foundation_min || 2000;
          break;
        
        case 'complex_federal':
          result.calculatedFee = fees.complex_federal_min || 5000;
          break;
        
        case 'scholarship_pack':
          result.calculatedFee = fees.transfer_scholarship_pack || 450;
          break;
        
        case 'hourly_time':
          const totalMinutes = timeEntries.reduce((sum, entry) => sum + (entry.rounded_minutes || 0), 0);
          const totalHours = totalMinutes / 60;
          result.calculatedFee = totalHours * result.baseRate;
          break;
        
        default:
          result.calculatedFee = 0;
      }
    }

    // Apply hardship caps if applicable
    if (result.qualifiesForHardship && settings.hardship_caps) {
      const caps = settings.hardship_caps;
      
      switch (serviceType) {
        case 'quick_scan':
          if (result.calculatedFee > caps.quick_scan_max) {
            result.discountAmount = result.calculatedFee - caps.quick_scan_max;
            result.calculatedFee = caps.quick_scan_max;
            result.discountDescription = 'Hardship Cap Applied';
          }
          break;
        
        case 'comprehensive_dossier':
          if (result.calculatedFee > caps.dossier_max) {
            result.discountAmount = result.calculatedFee - caps.dossier_min;
            result.calculatedFee = caps.dossier_min;
            result.discountDescription = 'Hardship Cap Applied';
          }
          break;
        
        case 'micro_grant':
          if (result.calculatedFee > caps.micro_grant_max) {
            result.discountAmount = result.calculatedFee - caps.micro_grant_max;
            result.calculatedFee = caps.micro_grant_max;
            result.discountDescription = 'Hardship Cap Applied';
          }
          break;
        
        case 'scholarship_pack':
          if (result.calculatedFee > caps.scholarship_pack_max) {
            result.discountAmount = result.calculatedFee - caps.scholarship_pack_min;
            result.calculatedFee = caps.scholarship_pack_min;
            result.discountDescription = 'Hardship Cap Applied';
          }
          break;
      }
    }

    // Apply ministry discount if no hardship discount already applied
    if (result.qualifiesForMinistryDiscount && result.discountAmount === 0) {
      const ministryDiscount = result.calculatedFee * ((settings.ministry_discount_percent || 25) / 100);
      result.discountAmount = ministryDiscount;
      result.calculatedFee -= ministryDiscount;
      result.discountDescription = `Ministry Discount ${settings.ministry_discount_percent || 25}%`;
    }

    // Apply Pro Bono 100% discount
    if (result.qualifiesForProBono && result.calculatedFee > 0) {
      result.discountAmount = result.calculatedFee;
      result.calculatedFee = 0;
      result.discountDescription = 'Pro Bono Service (100% Discount for Tax Write-Off)';
    }

    result.finalFee = result.calculatedFee;

    return result;
  }, [selectedOrg, settings, formData.service_type, timeEntries]);
}