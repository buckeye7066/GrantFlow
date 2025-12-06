import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Printer, DollarSign, Clock, CreditCard, Building2, User, Users, CheckCircle2, Phone, Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function PrintablePaymentOptions() {
  const { data: settings } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: async () => {
      const results = await base44.entities.BillingSettings.list();
      return results[0] || getDefaultSettings();
    },
  });

  const getDefaultSettings = () => ({
    consultant_name: "John White",
    business_name: "White Grant Services",
    net_terms_days: 15,
    hourly_rates: {
      individual_household: 85,
      small_ministry_nonprofit: 85,
      midsize_org: 115,
      large_org: 150,
    },
    flat_fees: {
      quick_eligibility_scan_individual: 149,
      quick_eligibility_scan_small: 349,
      quick_eligibility_scan_large: 750,
      comprehensive_dossier_individual: 399,
      comprehensive_dossier_small: 1250,
      comprehensive_dossier_mid: 2400,
      comprehensive_dossier_large: 3800,
      micro_grant_min: 600,
      micro_grant_max: 1200,
      standard_foundation_min: 2000,
      standard_foundation_max: 5000,
      complex_federal_min: 5000,
      complex_federal_max: 12000,
    },
    milestone_deposit_percent: 40,
    milestone_draft_percent: 40,
    milestone_final_percent: 20,
    ministry_discount_percent: 25,
  });

  const handlePrint = () => {
    window.print();
  };

  if (!settings) return null;

  return (
    <div className="min-h-screen bg-white">
      {/* Print Button - Hidden when printing */}
      <div className="no-print fixed top-4 right-4 z-50">
        <Button onClick={handlePrint} className="bg-blue-600 hover:bg-blue-700 shadow-lg">
          <Printer className="w-4 h-4 mr-2" />
          Print Payment Options
        </Button>
      </div>

      <div className="max-w-5xl mx-auto p-8 space-y-8">
        {/* Header */}
        <header className="text-center border-b-2 border-slate-900 pb-6">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">
            Payment Options & Pricing Guide
          </h1>
          <p className="text-xl text-slate-600">{settings.business_name || settings.consultant_name}</p>
          <p className="text-sm text-slate-500 mt-2">Professional Grant Writing & Consulting Services</p>
          <div className="flex justify-center gap-6 mt-4 text-sm text-slate-600">
            <div className="flex items-center gap-2">
              <Phone className="w-4 h-4" />
              Cell: 423-504-7778
            </div>
            <div className="flex items-center gap-2">
              <Printer className="w-4 h-4" />
              Fax: 423-414-5290
            </div>
          </div>
        </header>

        {/* Client Information Form */}
        <Card className="border-2 border-slate-300">
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-1">Client Name:</p>
                <div className="border-b-2 border-slate-300 pb-1">&nbsp;</div>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-1">Date:</p>
                <div className="border-b-2 border-slate-300 pb-1">&nbsp;</div>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-1">Phone:</p>
                <div className="border-b-2 border-slate-300 pb-1">&nbsp;</div>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-1">Email:</p>
                <div className="border-b-2 border-slate-300 pb-1">&nbsp;</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Instructions */}
        <Card className="border-3 border-amber-400 bg-amber-50">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-amber-200 rounded-full flex-shrink-0">
                <CheckCircle2 className="w-6 h-6 text-amber-900" />
              </div>
              <div>
                <p className="font-bold text-amber-900 text-lg mb-2">INSTRUCTIONS:</p>
                <ol className="text-sm text-amber-900 space-y-1 list-decimal list-inside">
                  <li>Check the box (☐) next to each service you are interested in</li>
                  <li>Review the pricing for your organization size or individual status</li>
                  <li>Read the "Important Note" below to avoid duplicate charges</li>
                  <li>Sign and return this sheet to discuss your selected services</li>
                </ol>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Organization Size Definitions */}
        <Card className="border-2 border-blue-200 bg-blue-50/30">
          <CardHeader>
            <CardTitle className="text-blue-900">Organization Size Definitions</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div className="p-3 bg-white rounded border border-blue-200">
                <p className="font-bold text-blue-900 mb-1">Small Organization</p>
                <p className="text-slate-600">Annual budget under $250,000</p>
              </div>
              <div className="p-3 bg-white rounded border border-blue-200">
                <p className="font-bold text-blue-900 mb-1">Mid-Size Organization</p>
                <p className="text-slate-600">Annual budget $250,000 - $2,000,000</p>
              </div>
              <div className="p-3 bg-white rounded border border-blue-200">
                <p className="font-bold text-blue-900 mb-1">Large Organization</p>
                <p className="text-slate-600">Annual budget over $2,000,000</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Important Note - Avoid Double Billing */}
        <Card className="border-3 border-red-400 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-red-200 rounded-full flex-shrink-0">
                <Mail className="w-6 h-6 text-red-900" />
              </div>
              <div>
                <p className="font-bold text-red-900 text-lg mb-2">⚠️ IMPORTANT NOTE - Avoid Duplicate Charges:</p>
                <ul className="text-sm text-red-900 space-y-2">
                  <li className="leading-relaxed">
                    <strong>Choose ONE:</strong> Quick Eligibility Scan <strong>OR</strong> Comprehensive Funding Dossier 
                    (not both - Comprehensive includes everything in Quick Scan plus much more)
                  </li>
                  <li className="leading-relaxed">
                    <strong>Application Writing is separate:</strong> After your eligibility assessment, you can add 
                    application writing services for specific grants
                  </li>
                  <li className="leading-relaxed">
                    <strong>Hourly billing is an alternative:</strong> Choose hourly <strong>OR</strong> flat fee services, 
                    not both for the same work
                  </li>
                  <li className="leading-relaxed">
                    <strong>Additional services can be added:</strong> Budget development, editing, compliance, and calendar 
                    management are supplemental and can be combined with any package
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* QUICK ELIGIBILITY SERVICES */}
        <section className="mb-8">
          <div className="bg-gradient-to-r from-green-600 to-emerald-600 text-white p-4 mb-4">
            <h2 className="text-2xl font-bold">QUICK ELIGIBILITY SERVICES</h2>
            <p className="text-sm text-green-50">Fast assessments to identify immediate opportunities</p>
          </div>

          {/* Quick Eligibility Scan */}
          <Card className="border-2 border-green-300 mb-4">
            <CardHeader className="bg-green-50">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <CardTitle className="text-green-900 flex items-center gap-2">
                    ☐ Quick Eligibility Scan
                  </CardTitle>
                  <p className="text-sm text-green-800 mt-1">
                    Fast assessment of top 10-20 funding opportunities matching your profile. Includes keyword research, 
                    initial database queries, and summary report of best matches.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-4 gap-3 text-center">
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">☐ Individual</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.flat_fees?.quick_eligibility_scan_individual || 149}
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">☐ Small Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.flat_fees?.quick_eligibility_scan_small || 349}
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">☐ Mid-Size Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.flat_fees?.quick_eligibility_scan_small || 349}
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">☐ Large Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.flat_fees?.quick_eligibility_scan_large || 750}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Application Strategy Session */}
          <Card className="border-2 border-green-300">
            <CardHeader className="bg-green-50">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <CardTitle className="text-green-900 flex items-center gap-2">
                    ☐ Application Strategy Session
                  </CardTitle>
                  <p className="text-sm text-green-800 mt-1">
                    One-on-one consultation to develop your grant application strategy. Includes opportunity prioritization, 
                    timeline development, resource assessment, and action planning. 60-90 minute session with written follow-up recommendations.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="text-center p-3 border-2 border-slate-300 rounded">
                <p className="text-xs text-slate-600 mb-1">All Client Types</p>
                <p className="text-2xl font-bold text-slate-900">
                  ${settings.flat_fees?.application_strategy_min || 300} - ${settings.flat_fees?.application_strategy_max || 600}
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* COMPREHENSIVE FUNDING SERVICES */}
        <section className="page-break-before mb-8">
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-4 mb-4">
            <h2 className="text-2xl font-bold">COMPREHENSIVE FUNDING SERVICES</h2>
            <p className="text-sm text-blue-50">In-depth research, analysis, and full application support</p>
          </div>

          {/* Comprehensive Funding Dossier */}
          <Card className="border-2 border-blue-300 mb-4">
            <CardHeader className="bg-blue-50">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <CardTitle className="text-blue-900 flex items-center gap-2">
                    ☐ Comprehensive Funding Dossier
                  </CardTitle>
                  <p className="text-sm text-blue-800 mt-1">
                    Deep research with 50+ opportunities identified, detailed eligibility analysis, strategic roadmap, 
                    application timelines, and budget planning. Includes personalized recommendations and priority ranking.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-4 gap-3 text-center">
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">☐ Individual</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.flat_fees?.comprehensive_dossier_individual || 399}
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">☐ Small Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.flat_fees?.comprehensive_dossier_small || 1250}
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">☐ Mid-Size Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.flat_fees?.comprehensive_dossier_mid || 2400}
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">☐ Large Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.flat_fees?.comprehensive_dossier_large || 3800}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Grant Application Writing */}
          <div className="mb-4">
            <h3 className="text-xl font-bold text-blue-900 mb-3 pl-2">Grant Application Writing</h3>
            
            <Card className="border-2 border-blue-300 mb-3">
              <CardContent className="pt-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="font-bold text-slate-900">☐ Micro-Grants (Award &lt;$5,000)</p>
                    <p className="text-xs text-slate-600 mt-1">
                      Complete application preparation including narrative, simple budget, and required attachments
                    </p>
                  </div>
                  <div className="text-right ml-4">
                    <p className="text-xl font-bold text-slate-900 whitespace-nowrap">
                      ${settings.flat_fees?.micro_grant_min || 600} - ${settings.flat_fees?.micro_grant_max || 1200}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-2 border-blue-300 mb-3">
              <CardContent className="pt-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="font-bold text-slate-900">☐ Standard Foundation Grants</p>
                    <p className="text-xs text-slate-600 mt-1">
                      Full proposal package with project narrative, detailed budget, sustainability plan, and evaluation framework
                    </p>
                  </div>
                  <div className="text-right ml-4">
                    <p className="text-xl font-bold text-slate-900 whitespace-nowrap">
                      ${settings.flat_fees?.standard_foundation_min || 2000} - ${settings.flat_fees?.standard_foundation_max || 5000}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-2 border-blue-300">
              <CardContent className="pt-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="font-bold text-slate-900">☐ Complex Federal Grants</p>
                    <p className="text-xs text-slate-600 mt-1">
                      Comprehensive federal proposal with multi-year budgets, logic models, evaluation plans, 
                      data management, and compliance documentation
                    </p>
                  </div>
                  <div className="text-right ml-4">
                    <p className="text-xl font-bold text-slate-900 whitespace-nowrap">
                      ${settings.flat_fees?.complex_federal_min || 5000} - ${settings.flat_fees?.complex_federal_max || 12000}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Additional Comprehensive Services */}
          <div className="mb-4">
            <h3 className="text-xl font-bold text-blue-900 mb-3 pl-2">Additional Services</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Card className="border border-blue-200">
                <CardContent className="pt-4">
                  <p className="font-bold text-slate-900 text-sm mb-1">☐ Budget Development & Logic Models</p>
                  <p className="text-lg font-bold text-slate-900">
                    ${settings.flat_fees?.budget_logic_model_min || 350} - ${settings.flat_fees?.budget_logic_model_max || 900}
                  </p>
                </CardContent>
              </Card>

              <Card className="border border-blue-200">
                <CardContent className="pt-4">
                  <p className="font-bold text-slate-900 text-sm mb-1">☐ Editing & Redrafting Services</p>
                  <p className="text-lg font-bold text-slate-900">
                    ${settings.flat_fees?.editing_redraft_min || 300} - ${settings.flat_fees?.editing_redraft_max || 900}
                  </p>
                </CardContent>
              </Card>

              <Card className="border border-blue-200">
                <CardContent className="pt-4">
                  <p className="font-bold text-slate-900 text-sm mb-1">☐ Post-Award Compliance & Reporting</p>
                  <p className="text-lg font-bold text-slate-900">
                    ${settings.flat_fees?.compliance_reporting_min || 500} - ${settings.flat_fees?.compliance_reporting_max || 1500}
                  </p>
                </CardContent>
              </Card>

              <Card className="border border-blue-200">
                <CardContent className="pt-4">
                  <p className="font-bold text-slate-900 text-sm mb-1">☐ Grant Calendar Setup & Management</p>
                  <p className="text-lg font-bold text-slate-900">
                    ${settings.flat_fees?.grant_calendar_setup_min || 800} - ${settings.flat_fees?.grant_calendar_setup_max || 1800}
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* Hourly Billing Option */}
        <section className="mb-8">
          <div className="bg-gradient-to-r from-purple-600 to-violet-600 text-white p-4 mb-4">
            <h2 className="text-2xl font-bold">HOURLY BILLING OPTION</h2>
            <p className="text-sm text-purple-50">Flexible, pay-as-you-go services</p>
          </div>

          <Card className="border-2 border-purple-300">
            <CardContent className="pt-6">
              <p className="font-bold text-slate-900 mb-3">☐ Hourly Rate Based on Organization Size:</p>
              <div className="grid grid-cols-4 gap-3 text-center mb-4">
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">Individual</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.hourly_rates?.individual_household || 85}/hr
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">Small Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.hourly_rates?.small_ministry_nonprofit || 85}/hr
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">Mid-Size Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.hourly_rates?.midsize_org || 115}/hr
                  </p>
                </div>
                <div className="p-3 border-2 border-slate-300 rounded">
                  <p className="text-xs text-slate-600 mb-1">Large Org</p>
                  <p className="text-xl font-bold text-slate-900">
                    ${settings.hourly_rates?.large_org || 150}/hr
                  </p>
                </div>
              </div>
              <p className="text-sm text-slate-600 bg-purple-50 p-3 rounded">
                <strong>Includes:</strong> Research, writing, editing, compliance review, submission assistance, 
                and ongoing consultation. Invoiced weekly or bi-weekly. Net {settings.net_terms_days} payment terms.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* Payment Terms */}
        <section>
          <h2 className="text-2xl font-bold text-slate-900 mb-4 flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-purple-600" />
            Payment Terms & Methods
          </h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="bg-slate-50">
                <CardTitle className="text-slate-900">Payment Schedule</CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-3">
                <div>
                  <p className="font-semibold text-slate-900 mb-1">Milestone-Based (Recommended)</p>
                  <ul className="space-y-1 text-sm text-slate-600">
                    <li>• {settings.milestone_deposit_percent}% deposit at project start</li>
                    <li>• {settings.milestone_draft_percent}% upon draft delivery</li>
                    <li>• {settings.milestone_final_percent}% upon final submission</li>
                  </ul>
                </div>
                <div className="pt-3 border-t">
                  <p className="font-semibold text-slate-900 mb-1">Hourly Billing</p>
                  <p className="text-sm text-slate-600">
                    Invoiced weekly or bi-weekly • Net {settings.net_terms_days} payment terms
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="bg-slate-50">
                <CardTitle className="text-slate-900">Accepted Payment Methods</CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <ul className="space-y-2 text-slate-700">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    <div>
                      <strong>Check</strong> - Make payable to: <span className="font-semibold">John White</span>
                    </div>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    <div>
                      <strong>Venmo:</strong> @John-White-1384
                    </div>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    <div>
                      <strong>CashApp:</strong> $jwhiternmba
                    </div>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    ACH / Bank Transfer
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    Credit Card (processing fee may apply)
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    Bill-to-Grant (when allowed by funder)
                  </li>
                </ul>
                <p className="text-xs text-slate-500 mt-3 italic">
                  Payment plans available for qualified clients
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Special Pricing */}
        <section>
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Special Pricing & Accommodations</h2>
          
          <div className="space-y-3">
            <Card className="border-emerald-200 bg-emerald-50/30">
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-emerald-100 rounded-lg">
                    <Building2 className="w-5 h-5 text-emerald-700" />
                  </div>
                  <div className="flex-1">
                    <p className="font-bold text-emerald-900 mb-1">Ministry & Church Discount</p>
                    <p className="text-sm text-emerald-800">
                      Churches and ministries with annual budgets under $250,000 receive {settings.ministry_discount_percent}% discount on all services
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-rose-200 bg-rose-50/30">
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-rose-100 rounded-lg">
                    <User className="w-5 h-5 text-rose-700" />
                  </div>
                  <div className="flex-1">
                    <p className="font-bold text-rose-900 mb-1">Hardship Pricing Caps</p>
                    <p className="text-sm text-rose-800 mb-2">
                      For individuals experiencing financial hardship:
                    </p>
                    <ul className="text-sm text-rose-800 space-y-1">
                      <li>• Quick Scan: $0-49 (sliding scale)</li>
                      <li>• Comprehensive Dossier: $99-199</li>
                      <li>• Micro-Grant Application: Up to $250</li>
                      <li>• Scholarship Package: $99-199</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-blue-200 bg-blue-50/30">
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-blue-100 rounded-lg">
                    <Clock className="w-5 h-5 text-blue-700" />
                  </div>
                  <div className="flex-1">
                    <p className="font-bold text-blue-900 mb-1">Rush Service Fees</p>
                    <ul className="text-sm text-blue-800 space-y-1">
                      <li>• Standard Rush (7-14 days): +25% of base fee</li>
                      <li>• Emergency Rush (&lt;7 days): +50% of base fee</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Bill-to-Grant Option */}
        <section className="page-break-before">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Bill-to-Grant Option</h2>
          <Card className="border-2 border-purple-200">
            <CardContent className="pt-6">
              <p className="text-slate-700 leading-relaxed mb-4">
                Many federal and state grants explicitly allow proposal writing costs to be charged to the grant 
                if awarded. When this option is available and clearly stated in the Notice of Funding Opportunity (NOFO):
              </p>
              <ul className="space-y-2 text-slate-700 ml-4">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-purple-600 mt-0.5 flex-shrink-0" />
                  <span>You pay nothing upfront</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-purple-600 mt-0.5 flex-shrink-0" />
                  <span>If grant is awarded, proposal costs are billed to the grant budget</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-purple-600 mt-0.5 flex-shrink-0" />
                  <span>If not awarded, you owe nothing (risk-free)</span>
                </li>
              </ul>
              <p className="text-sm text-slate-600 italic mt-4 p-3 bg-purple-50 rounded">
                We verify NOFO language before offering this option. Not available for all grants.
              </p>
            </CardContent>
          </Card>
        </section>



        {/* Contract Terms & Conditions - Page 2 */}
        <section className="page-break-before">
          <h2 className="text-2xl font-bold text-slate-900 mb-4 border-b-2 border-slate-900 pb-2">
            CONTRACT TERMS & CONDITIONS
          </h2>
          
          <Card className="border-2 border-slate-300">
            <CardContent className="pt-6">
              <div className="space-y-4 text-xs text-slate-700 leading-relaxed">
                <div>
                  <p className="font-bold text-slate-900 mb-1">1. SERVICES AGREEMENT</p>
                  <p>
                    This agreement is between {settings.business_name || settings.consultant_name} ("Consultant") and the 
                    undersigned Client for grant writing and consulting services as selected above. Consultant agrees to provide 
                    professional services in accordance with industry standards, Grant Professionals Association (GPA) Code of Ethics, 
                    and all applicable laws and regulations.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">2. PAYMENT TERMS</p>
                  <p>
                    Client agrees to pay for selected services at the rates specified. Payment is due within {settings.net_terms_days} days 
                    of invoice date unless otherwise agreed in writing. Late payments may incur a monthly service charge of 
                    {settings.late_fee_monthly_percent || 1.5}%. For milestone-based projects: {settings.milestone_deposit_percent}% 
                    deposit at start, {settings.milestone_draft_percent}% upon draft delivery, {settings.milestone_final_percent}% upon final submission. 
                    Returned checks subject to $35 fee plus any bank charges.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">3. NO GUARANTEE OF AWARD</p>
                  <p>
                    <strong>CONSULTANT MAKES NO WARRANTY, GUARANTEE, OR REPRESENTATION THAT ANY GRANT APPLICATION WILL BE FUNDED.</strong> Grant 
                    awards are solely at the discretion of funding agencies. Consultant's fee is for professional services rendered, not for 
                    results obtained. Client remains responsible for full payment regardless of whether a grant is awarded. Success depends on 
                    many factors beyond Consultant's control including funder priorities, competition, budget availability, and application requirements.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">4. CLIENT RESPONSIBILITIES</p>
                  <p>
                    Client agrees to: (a) provide accurate, complete, and truthful information in a timely manner; (b) review all drafts and 
                    provide feedback within 5 business days or agreed timeframe; (c) ensure all submitted information is accurate and that Client 
                    has authority to enter this agreement; (d) obtain necessary approvals from board or governing body; (e) respond promptly to 
                    Consultant requests for information; (f) maintain confidentiality of proprietary research or strategy; and (g) notify Consultant 
                    immediately of any material changes affecting eligibility or project scope.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">5. SCOPE CHANGES & ADDITIONAL WORK</p>
                  <p>
                    Scope of work is limited to services selected above. Any changes, additions, or extra work beyond the original scope must be 
                    documented in writing and will be billed separately at applicable rates. Examples of additional work include: responding to 
                    funder questions after submission, major rewrites due to changed funder requirements, preparing appeals, or work on 
                    different grant opportunities. Client will receive written notice and cost estimate before additional charges are incurred.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">6. CANCELLATION & REFUND POLICY</p>
                  <p>
                    Either party may terminate with 7 days written notice. Upon cancellation: (a) Client pays for all work completed through 
                    cancellation date; (b) For flat fee projects, deposits are non-refundable after work commences, milestone payments refunded 
                    only for work not yet completed; (c) For hourly projects, Client pays for all documented hours worked; (d) Consultant will 
                    provide all work completed to date; (e) No refunds for "Quick Eligibility" or "Strategy Session" services after delivery. 
                    Consultant may terminate immediately if Client breaches this agreement, fails to pay, or requests unethical/illegal practices.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">7. DEADLINES & TIMELY PERFORMANCE</p>
                  <p>
                    Consultant will make reasonable efforts to meet agreed deadlines. However, timely performance depends on Client providing 
                    information and feedback as requested. Consultant is not liable for missed funder deadlines caused by: Client delays in 
                    providing information, Client delays in reviewing/approving drafts, funder portal technical issues, or other circumstances 
                    beyond Consultant's reasonable control. Rush fees apply when Client requests completion in less than normal timeframes.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">8. CONFIDENTIALITY & DATA PRIVACY</p>
                  <p>
                    Consultant agrees to maintain confidentiality of all client information and will not disclose sensitive data to third parties 
                    without written permission, except as: (a) required by law; (b) necessary to perform services (e.g., submitting to funders); 
                    or (c) necessary to defend against legal claims. Client data will be stored securely and not sold or shared for marketing purposes.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">9. INTELLECTUAL PROPERTY & WORK PRODUCT</p>
                  <p>
                    Upon receipt of full payment, all work product created specifically for Client (proposals, budgets, narratives, etc.) becomes 
                    Client's property for use, modification, and submission. Consultant retains right to: (a) use general methodologies, processes, 
                    and templates for other clients; (b) reuse non-identifying information and lessons learned; (c) use project as portfolio/reference 
                    example unless Client objects in writing. Consultant retains ownership of proprietary research databases, software tools, and 
                    assessment methodologies.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">10. LIMITATION OF LIABILITY</p>
                  <p>
                    <strong>CONSULTANT'S TOTAL LIABILITY UNDER THIS AGREEMENT SHALL NOT EXCEED THE TOTAL FEES PAID BY CLIENT FOR THE SPECIFIC PROJECT.</strong> 
                    Consultant is not liable for: (a) funding decisions or award amounts; (b) changes in funder requirements after submission; 
                    (c) delays caused by Client, funders, or third parties; (d) technical failures of funder portals or systems; (e) Client's 
                    failure to meet grant requirements post-award; or (f) any consequential, indirect, special, incidental, or punitive damages. 
                    CONSULTANT MAKES NO WARRANTIES EXPRESS OR IMPLIED INCLUDING MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">11. COMPLIANCE, ETHICS & PROFESSIONAL STANDARDS</p>
                  <p>
                    All work conducted in accordance with: Grant Professionals Association Code of Ethics, applicable federal grant regulations 
                    (2 CFR 200), IRS rules for charitable organizations, and state/local laws. Consultant will not: lobby with grant funds, make 
                    false statements, submit plagiarized content, guarantee outcomes, charge percentage-based fees on grant awards, or engage in 
                    conflicts of interest. Client certifies eligibility for applied-for funding and authority to submit applications on behalf of 
                    organization if applicable.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">12. DISPUTE RESOLUTION & GOVERNING LAW</p>
                  <p>
                    Disputes shall first be addressed through good-faith negotiation within 30 days of written notice. If unresolved, parties 
                    agree to non-binding mediation before pursuing litigation. This agreement is governed by Tennessee law without regard to 
                    conflicts of law provisions. Venue for any legal action shall be in Hamilton County, Tennessee. Prevailing party in any 
                    dispute may recover reasonable attorney fees and costs.
                  </p>
                </div>

                <div>
                  <p className="font-bold text-slate-900 mb-1">13. ENTIRE AGREEMENT & AMENDMENTS</p>
                  <p>
                    This document constitutes the entire agreement between parties and supersedes all prior oral or written agreements, 
                    understandings, or representations. Any modifications, amendments, or waivers must be made in writing and signed by both 
                    parties. No oral modifications are valid. If any provision is found unenforceable, remaining provisions remain in full effect.
                  </p>
                </div>

                <div className="mt-6 p-3 bg-slate-200 rounded border-2 border-slate-400">
                  <p className="text-xs text-slate-800 text-center italic">
                    <strong>NOTICE:</strong> Client has the right to seek independent legal counsel before signing this agreement. 
                    This contract becomes binding when signed by both parties.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Signature Block - Contract Execution */}
        <section className="mb-8">
          <Card className="border-4 border-slate-900">
            <CardHeader className="bg-slate-800 text-white">
              <CardTitle className="text-center text-xl">SIGNATURES - BINDING CONTRACT</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 pb-8">
              <p className="text-sm text-slate-700 mb-6 text-center font-bold bg-yellow-100 p-3 rounded border-2 border-yellow-400">
                ⚠️ By signing below, both parties acknowledge they have read, understand, and agree to be bound by all terms and 
                conditions in this contract, including the selected services and pricing above.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-12 mt-8">
                {/* Client Signature */}
                <div className="space-y-4">
                  <p className="font-bold text-slate-900 text-lg border-b-2 border-slate-300 pb-2">CLIENT SIGNATURE:</p>
                  
                  <div>
                    <p className="text-sm font-semibold text-slate-700 mb-1">Printed Name:</p>
                    <div className="border-b-2 border-slate-900 pb-1 mb-1">&nbsp;</div>
                  </div>
                  
                  <div>
                    <p className="text-sm font-semibold text-slate-700 mb-1">Title/Position (if org):</p>
                    <div className="border-b-2 border-slate-900 pb-1 mb-1">&nbsp;</div>
                  </div>
                  
                  <div>
                    <p className="text-sm font-semibold text-slate-700 mb-1">Organization Name (if applicable):</p>
                    <div className="border-b-2 border-slate-900 pb-1 mb-1">&nbsp;</div>
                  </div>
                  
                  <div className="pt-3">
                    <p className="text-sm font-semibold text-slate-700 mb-2">Signature:</p>
                    <div className="border-b-2 border-slate-900 pb-10 mb-1">&nbsp;</div>
                  </div>
                  
                  <div>
                    <p className="text-sm font-semibold text-slate-700 mb-1">Date:</p>
                    <div className="border-b-2 border-slate-900 pb-1">&nbsp;</div>
                  </div>
                </div>

                {/* Consultant Signature */}
                <div className="space-y-4">
                  <p className="font-bold text-slate-900 text-lg border-b-2 border-slate-300 pb-2">CONSULTANT SIGNATURE:</p>
                  
                  <div>
                    <p className="text-sm font-semibold text-slate-700 mb-1">Printed Name:</p>
                    <div className="border-b-2 border-slate-900 pb-1 mb-1 text-slate-700">
                      {settings.consultant_name}
                    </div>
                  </div>
                  
                  <div>
                    <p className="text-sm font-semibold text-slate-700 mb-1">Title:</p>
                    <div className="border-b-2 border-slate-900 pb-1 mb-1 text-slate-700">
                      Grant Writing Consultant
                    </div>
                  </div>
                  
                  <div>
                    <p className="text-sm font-semibold text-slate-700 mb-1">Business Name:</p>
                    <div className="border-b-2 border-slate-900 pb-1 mb-1 text-slate-700">
                      {settings.business_name}
                    </div>
                  </div>
                  
                  <div className="pt-3">
                    <p className="text-sm font-semibold text-slate-700 mb-2">Signature:</p>
                    <div className="border-b-2 border-slate-900 pb-10 mb-1">&nbsp;</div>
                  </div>
                  
                  <div>
                    <p className="text-sm font-semibold text-slate-700 mb-1">Date:</p>
                    <div className="border-b-2 border-slate-900 pb-1">&nbsp;</div>
                  </div>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t-2 border-slate-300">
                <p className="text-xs text-slate-600 text-center italic">
                  Each party should retain a signed copy of this contract for their records. 
                  This agreement becomes effective on the date of the last signature.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Footer */}
        <footer className="border-t-2 border-slate-900 pt-6 mt-8">
          <div className="text-center mb-6">
            <p className="text-slate-700 mb-2 text-lg">
              <strong>{settings.consultant_name}</strong>
            </p>
            <p className="text-slate-600">
              {settings.business_name}
            </p>
            <div className="flex justify-center gap-6 mt-3 text-sm text-slate-600">
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4" />
                <span><strong>Cell:</strong> 423-504-7778</span>
              </div>
              <div className="flex items-center gap-2">
                <Printer className="w-4 h-4" />
                <span><strong>Fax:</strong> 423-414-5290</span>
              </div>
            </div>
          </div>

          <p className="text-slate-500 text-xs text-center">
            Contract effective as of date of last signature • Prices current as of {new Date().toLocaleDateString()}
          </p>
          <p className="text-slate-500 text-xs text-center mt-2 italic">
            We reserve {settings.pro_bono_tithe_percent || 10}% of revenue for pro bono services to those in crisis
          </p>
        </footer>
      </div>

      {/* Print Styles */}
      <style>{`
        @media print {
          body {
            margin: 0;
            padding: 0;
          }
          
          .no-print {
            display: none !important;
          }
          
          .page-break-before {
            page-break-before: always;
          }
          
          .page-break-after {
            page-break-after: always;
          }
          
          @page {
            margin: 0.5in;
          }
        }
      `}</style>
    </div>
  );
}