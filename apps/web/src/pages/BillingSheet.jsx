import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { FileDown, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';

const SERVICES = {
  discovery: [
    {
      id: 'quick_scan',
      name: 'Quick Eligibility Scan',
      description: 'Rapid assessment of your eligibility for federal, state, and foundation grants. Includes keyword research, initial database queries, and a summary report of 5-10 top opportunities with eligibility notes.',
      individual: 149,
      small: 349,
      mid: 349,
      large: 750
    },
    {
      id: 'comprehensive_dossier',
      name: 'Comprehensive Funding Dossier',
      description: 'Full funding landscape analysis with detailed research across federal, state, foundation, and corporate sources. Includes strategic recommendations, timeline planning, and prioritized list of 15-30+ opportunities with full eligibility analysis, award ranges, and application requirements.',
      individual: 399,
      small: 1250,
      mid: 2400,
      large: 3800
    },
    {
      id: 'application_strategy',
      name: 'Application Strategy Session',
      description: 'One-on-one consultation to develop your grant application strategy. Includes opportunity prioritization, timeline development, resource assessment, and action planning. 60-90 minute session with written follow-up recommendations.',
      individual: 300,
      small: 450,
      mid: 600,
      large: 600
    }
  ],
  writing: [
    {
      id: 'micro_grant',
      name: 'Micro-Grant Application (<$5K)',
      description: 'Complete application preparation for small grants and assistance programs under $5,000. Includes narrative development, budget preparation, and submission coordination. Ideal for emergency assistance, scholarships, and community grants.',
      individual: 600,
      small: 900,
      mid: 1200,
      large: 1200
    },
    {
      id: 'standard_foundation',
      name: 'Standard Foundation Application',
      description: 'Full-service foundation grant application ($5K-$250K). Includes needs assessment, program design narrative, evaluation plan, logic model, detailed budget with justification, and all required attachments. Typically 5-15 pages.',
      individual: 2000,
      small: 3500,
      mid: 5000,
      large: 5000
    },
    {
      id: 'complex_federal',
      name: 'Complex/Federal Application',
      description: 'Comprehensive federal or large foundation proposal ($250K+). Includes all narrative sections, detailed work plan, organizational capacity documentation, partnership coordination, complex budget development, sustainability planning, and compliance review. Typically 20-50+ pages.',
      individual: 5000,
      small: 8000,
      mid: 12000,
      large: 12000
    },
    {
      id: 'scholarship_pack',
      name: 'Transfer Scholarship Pack',
      description: 'Coordinated application support for students applying to multiple transfer scholarships. Includes common essay development, customization for 3-5 institutions, academic records coordination, and submission tracking.',
      individual: 450,
      small: 450,
      mid: 450,
      large: 450
    }
  ],
  support: [
    {
      id: 'editing',
      name: 'Editing & Redraft Service',
      description: 'Professional editing and revision of existing grant proposals. Includes content strengthening, compliance review, formatting, clarity enhancement, and scoring rubric alignment. Does not include complete rewrite.',
      individual: 300,
      small: 500,
      mid: 900,
      large: 900
    },
    {
      id: 'budget_development',
      name: 'Budget & Logic Model Development',
      description: 'Standalone budget creation with detailed justification and logic model development. Includes line-item budget, budget narrative, indirect cost calculations, cost-sharing documentation, and visual logic model showing inputs, activities, outputs, and outcomes.',
      individual: 350,
      small: 600,
      mid: 900,
      large: 900
    },
    {
      id: 'compliance_reporting',
      name: 'Compliance Reporting & Management',
      description: 'Post-award grant management support. Includes quarterly/annual report preparation, expenditure tracking, outcomes documentation, and compliance verification. Per report or monthly retainer available.',
      individual: 500,
      small: 1000,
      mid: 1500,
      large: 1500
    },
    {
      id: 'grant_calendar',
      name: 'Grant Calendar Setup & Management',
      description: 'Comprehensive grant opportunity tracking system. Includes research of applicable deadlines, calendar creation with milestones, automated reminders, and quarterly updates. 12-month calendar with ongoing support.',
      individual: 800,
      small: 1200,
      mid: 1800,
      large: 1800
    }
  ],
  hourly: [
    {
      id: 'hourly_consultation',
      name: 'Hourly Consultation & Advisory',
      description: 'Flexible hourly support for grant research, proposal review, technical assistance, training, or ad-hoc consulting. Billed in 6-minute increments with 15-minute minimum. Rates vary by client category.',
      rate: 'hourly'
    }
  ]
};

export default function BillingSheet() {
  const urlParams = new URLSearchParams(window.location.search);
  const organizationId = urlParams.get('organization_id');
  const isMaster = !organizationId; // Master sheet if no org specified
  const navigate = useNavigate();

  const [selectedServices, setSelectedServices] = useState(new Set());

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // RLS-safe organization query
  const { data: organization } = useQuery({
    queryKey: ['organization', organizationId, user?.email, isAdmin],
    queryFn: async () => {
      if (!organizationId) return null;

      if (isAdmin) {
        return base44.entities.Organization.get(organizationId);
      }

      const results = await base44.entities.Organization.filter(
        { id: organizationId, created_by: user.email },
        'name'
      );
      return results?.[0] || null;
    },
    enabled: !!user?.email && !!organizationId,
  });

  const { data: settings } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: async () => {
      const results = await base44.entities.BillingSettings.list();
      return results[0] || {};
    },
  });

  const handlePrint = () => {
    window.print();
  };

  const toggleService = (serviceId) => {
    const newSelected = new Set(selectedServices);
    if (newSelected.has(serviceId)) {
      newSelected.delete(serviceId);
    } else {
      newSelected.add(serviceId);
    }
    setSelectedServices(newSelected);
  };

  const calculateTotal = () => {
    let total = 0;
    const allServices = [
      ...SERVICES.discovery,
      ...SERVICES.writing,
      ...SERVICES.support,
    ];
    
    allServices.forEach(service => {
      if (selectedServices.has(service.id)) {
        const price = service[clientCategory] || 0;
        total += price;
      }
    });
    
    return total;
  };

  const handleGenerateInvoice = () => {
    if (selectedServices.size === 0) {
      alert('Please select at least one service');
      return;
    }
    
    // Construct selected service IDs for the invoice URL
    const selectedServiceIds = Array.from(selectedServices).join(',');
    
    // Navigate to create invoice with pre-selected services
    navigate(`${createPageUrl('CreateInvoice')}?organization_id=${organizationId}&selectedServices=${selectedServiceIds}`);
  };

  // Determine client category
  const getClientCategory = () => {
    if (!organization) return 'large';

    if (['individual_need', 'medical_assistance', 'family', 'high_school_student', 'college_student', 'graduate_student'].includes(organization.applicant_type)) {
      return 'individual';
    } else if (organization.annual_budget && organization.annual_budget < 250000) {
      return 'small';
    } else if (organization.annual_budget && organization.annual_budget <= 2000000) {
      return 'mid';
    }
    return 'large';
  };

  const clientCategory = getClientCategory();
  const categoryLabels = {
    individual: 'Individual/Household',
    small: 'Small Org/Ministry (<$250K budget)',
    mid: 'Mid-Size Organization ($250K-$2M budget)',
    large: 'Large Organization (>$2M budget)'
  };

  // Check if service applies to this profile
  const serviceApplies = (service) => {
    if (isMaster) return true; // Master sheet shows all

    // All services apply to all categories in this model
    return true;
  };

  const getServicePrice = (service) => {
    if (service.rate === 'hourly') {
      const hourlyRates = settings?.hourly_rates || {};
      const rate = hourlyRates[clientCategory] || 150; // Default if not found
      return `$${rate}/hour`;
    }
    return `$${service[clientCategory] || 0}`;
  };

  // Loading state
  if (isLoadingUser) {
    return (
      <div className="p-8 text-center">
        <span>Loading...</span>
      </div>
    );
  }

  // Access denied for non-admin viewing org they don't own
  if (organizationId && !isMaster && user?.email && !organization) {
    return (
      <div className="p-8 text-center">
        <p className="text-red-600 font-semibold">Access denied or organization not found.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          .no-print { 
            display: none !important; 
          }
          @page { 
            margin: 0.3in 0.4in;
            size: letter portrait;
          }
          body {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          .avoid-break {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .allow-break {
            page-break-inside: auto;
          }
          
          /* Ultra-compact print styles */
          .print-compact {
            padding: 2px 0 !important;
            margin: 1px 0 !important;
          }
          
          .print-compact h3 {
            font-size: 12px !important;
            margin-bottom: 4px !important;
            margin-top: 8px !important;
          }
          
          .print-compact table {
            font-size: 9px !important;
          }
          
          .print-compact td, .print-compact th {
            padding: 2px 1px !important;
            line-height: 1.1 !important;
          }
          
          .print-compact .service-description {
            font-size: 7px !important;
            line-height: 1.1 !important;
            margin-top: 1px !important;
          }
          
          /* Compress header */
          .print-header {
            margin-bottom: 8px !important;
            padding-bottom: 4px !important;
          }
          
          .print-header h1 {
            font-size: 18px !important;
            margin-bottom: 2px !important;
          }
          
          .print-header h2 {
            font-size: 14px !important;
          }
          
          .print-header h3 {
            font-size: 16px !important;
            margin-bottom: 2px !important;
          }
          
          .print-header p {
            font-size: 9px !important;
            margin-top: 2px !important;
            line-height: 1.2 !important;
          }
          
          /* Compress client info box */
          .client-info-box {
            padding: 6px !important;
            margin-bottom: 8px !important;
          }
          
          .client-info-box h3 {
            font-size: 11px !important;
            margin-bottom: 4px !important;
          }
          
          .client-info-box p, .client-info-box .text-sm {
            font-size: 8px !important;
            line-height: 1.2 !important;
          }
          
          /* Compress category definitions */
          .category-box {
            padding: 6px !important;
            margin-bottom: 8px !important;
          }
          
          .category-box h3 {
            font-size: 11px !important;
            margin-bottom: 4px !important;
          }
          
          .category-box p {
            font-size: 7px !important;
            line-height: 1.2 !important;
            margin-bottom: 2px !important;
          }
          
          /* Compress ethical notice */
          .ethical-notice {
            padding: 4px !important;
            margin-bottom: 8px !important;
          }
          
          .ethical-notice p {
            font-size: 7px !important;
            line-height: 1.2 !important;
          }
          
          /* Compress special pricing box */
          .special-pricing-box {
            padding: 6px !important;
            margin-top: 8px !important;
            margin-bottom: 8px !important;
          }
          
          .special-pricing-box h3 {
            font-size: 10px !important;
            margin-bottom: 4px !important;
          }
          
          .special-pricing-box p {
            font-size: 7px !important;
            line-height: 1.2 !important;
            margin-bottom: 1px !important;
          }
          
          /* Compress payment terms */
          .payment-terms-box {
            padding: 6px !important;
            margin-top: 8px !important;
            margin-bottom: 8px !important;
          }
          
          .payment-terms-box h3 {
            font-size: 10px !important;
            margin-bottom: 4px !important;
          }
          
          .payment-terms-box p, .payment-terms-box li {
            font-size: 7px !important;
            line-height: 1.2 !important;
          }
          
          .payment-terms-box ul {
            margin: 2px 0 !important;
          }
          
          /* Signature section */
          .signature-section {
            margin-top: 8px !important;
            padding-top: 6px !important;
          }
          
          .signature-section h3 {
            font-size: 10px !important;
            margin-bottom: 4px !important;
          }
          
          .signature-section p {
            font-size: 7px !important;
            line-height: 1.2 !important;
            margin-bottom: 4px !important;
          }
          
          .signature-section .signature-line {
            height: 30px !important;
            margin-bottom: 0 !important;
          }
          
          /* Footer */
          .print-footer {
            margin-top: 8px !important;
            padding-top: 4px !important;
            font-size: 7px !important;
            line-height: 1.2 !important;
          }
          
          /* Force signature and footer to stay on last page */
          .print-footer-group {
            page-break-inside: avoid;
            margin-top: 12px;
          }
          
          /* Hide interactive checkboxes in print, show styled boxes */
          .interactive-checkbox {
            display: none !important;
          }
          .form-box {
            display: inline-block !important;
          }
        }

        @media screen {
          /* Hide styled boxes on screen, show interactive checkboxes */
          .form-box {
            display: none !important;
          }
          .interactive-checkbox {
            display: inline-block !important;
          }
        }

        .form-box {
          width: 16px;
          height: 16px;
          border: 2px solid #000;
          display: inline-block;
          margin-right: 8px;
          vertical-align: middle;
        }
        
        .interactive-checkbox {
          width: 18px;
          height: 18px;
          margin-right: 8px;
          vertical-align: middle;
          cursor: pointer;
          accent-color: #2563eb;
        }

        .price-cell {
          text-align: right;
          font-weight: 600;
        }

        .service-description {
          font-size: 11px;
          color: #475569;
          line-height: 1.4;
          margin-top: 4px;
        }
        
        .service-row {
          cursor: pointer;
          transition: background-color 0.15s;
        }
        
        .service-row:hover {
          background-color: #f8fafc;
        }
        
        .service-row.selected {
          background-color: #eff6ff;
        }
      `}} />

      {/* Action Buttons */}
      <div className="no-print fixed top-4 right-4 z-50 flex gap-2">
        {!isMaster && selectedServices.size > 0 && organizationId && (
          <Button 
            onClick={handleGenerateInvoice}
            className="bg-emerald-600 hover:bg-emerald-700 shadow-lg"
          >
            <FileText className="w-4 h-4 mr-2" />
            Generate Invoice (${calculateTotal().toLocaleString()})
          </Button>
        )}
        <Button onClick={handlePrint} className="bg-blue-600 hover:bg-blue-700 shadow-lg">
          <FileDown className="w-4 h-4 mr-2" />
          Save as PDF
        </Button>
      </div>

      {/* Printable Content */}
      <div className="max-w-4xl mx-auto p-8">
        {/* Header */}
        <div className="border-b-4 border-blue-600 pb-6 mb-8 print-header">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-4xl font-bold text-gray-900 mb-2">GrantFlow</h1>
              <h2 className="text-xl text-gray-700">Professional Grant Writing Services</h2>
              <p className="text-sm text-gray-600 mt-4">John White, PhD, MBA, Grant Writing Consultant</p>
              <p className="text-sm text-gray-600">Dr.JohnWhite@axiombiolabs.org</p>
              <p className="text-sm text-gray-600">Cell: 423.504.7778</p>
              <p className="text-sm text-gray-600">Fax: 423.414.5290</p>
            </div>
            <div className="text-right">
              <h3 className="text-2xl font-bold text-blue-600 mb-2">
                {isMaster ? 'MASTER SERVICE MENU' : 'SERVICE SELECTION FORM'}
              </h3>
              <p className="text-sm text-gray-600">Date: {new Date().toLocaleDateString()}</p>
            </div>
          </div>
        </div>

        {/* Client Information */}
        {!isMaster && organization && (
          <div className="mb-8 p-6 bg-blue-50 rounded-lg border-2 border-blue-200 avoid-break client-info-box">
            <h3 className="font-bold text-lg text-blue-900 mb-3">Client Information</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="font-semibold">Name:</p>
                <p className="text-gray-800">{organization.name}</p>
              </div>
              <div>
                <p className="font-semibold">Category:</p>
                <p className="text-gray-800">{categoryLabels[clientCategory]}</p>
              </div>
              {organization.email && organization.email[0] && (
                <div>
                  <p className="font-semibold">Email:</p>
                  <p className="text-gray-800">{organization.email[0]}</p>
                </div>
              )}
              {organization.phone && organization.phone[0] && (
                <div>
                  <p className="font-semibold">Phone:</p>
                  <p className="text-gray-800">{organization.phone[0]}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Instructions */}
        <div className="mb-8 p-6 bg-amber-50 rounded-lg border-3 border-amber-400 avoid-break">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 text-2xl">✓</div>
            <div>
              <p className="font-bold text-amber-900 text-lg mb-2">INSTRUCTIONS:</p>
              <ol className="text-sm text-amber-900 space-y-1 list-decimal list-inside">
                <li>Check the box next to each service you are interested in</li>
                <li>Review the pricing for your organization size or individual status</li>
                <li>Read the "Important Note" below to avoid duplicate charges</li>
                <li>Sign and return this sheet to discuss your selected services</li>
              </ol>
            </div>
          </div>
        </div>

        {/* Pricing Categories Key (for master sheet) */}
        {isMaster && (
          <div className="mb-8 p-6 bg-slate-50 rounded-lg border-2 border-slate-200 avoid-break category-box">
            <h3 className="font-bold text-lg text-slate-900 mb-3">Client Category Definitions</h3>
            <div className="space-y-2 text-sm text-slate-700">
              <p><strong>Individual:</strong> Students, individuals/families seeking assistance</p>
              <p><strong>Small Org:</strong> Nonprofits, ministries, or businesses with annual budget under $250,000</p>
              <p><strong>Mid-Size:</strong> Organizations with annual budget between $250,000 and $2,000,000</p>
              <p><strong>Large Org:</strong> Organizations with annual budget over $2,000,000</p>
            </div>
          </div>
        )}

        {/* Organization Size Definitions */}
        {!isMaster && (
          <div className="mb-8 p-6 bg-blue-50 rounded-lg border-2 border-blue-200 avoid-break category-box">
            <h3 className="font-bold text-lg text-blue-900 mb-3">Organization Size Definitions</h3>
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
          </div>
        )}

        {/* Important Note - Avoid Double Billing */}
        <div className="mb-8 p-6 bg-red-50 rounded-lg border-3 border-red-400 avoid-break">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 text-2xl">⚠️</div>
            <div>
              <p className="font-bold text-red-900 text-lg mb-2">IMPORTANT NOTE - Avoid Duplicate Charges:</p>
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
        </div>

        {/* Ethical Standards Notice */}
        <div className="mb-8 p-4 bg-green-50 border-2 border-green-600 rounded-lg avoid-break ethical-notice">
          <p className="text-sm text-green-900">
            <strong>✓ Ethical Billing Standards:</strong> All fees are for professional services rendered and are NOT contingent on award outcomes.
            No percentage-based or commission fees. Pricing complies with grant writing ethical standards and funder requirements.
          </p>
        </div>

        {/* Service Categories - with compact print styling */}
        <div className="space-y-6 print-compact allow-break">
          {/* Discovery Services */}
          <div>
            <h3 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b-2 border-gray-300">
              Discovery & Assessment Services
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="text-left py-2 w-12">{!isMaster && 'Select'}</th>
                  <th className="text-left py-2">Service Description</th>
                  {isMaster ? (
                    <>
                      <th className="text-right py-2 w-24">Individual</th>
                      <th className="text-right py-2 w-24">Small</th>
                      <th className="text-right py-2 w-24">Mid-Size</th>
                      <th className="text-right py-2 w-24">Large</th>
                    </>
                  ) : (
                    <th className="text-right py-2 w-32">Your Price</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {SERVICES.discovery.filter(serviceApplies).map(service => (
                  <tr 
                    key={service.id} 
                    className={`border-b border-gray-200 service-row ${!isMaster && selectedServices.has(service.id) ? 'selected' : ''}`}
                    onClick={() => !isMaster && toggleService(service.id)}
                  >
                    <td className="py-3">
                      {!isMaster && (
                        <>
                          <input 
                            type="checkbox" 
                            className="interactive-checkbox"
                            checked={selectedServices.has(service.id)}
                            onChange={() => toggleService(service.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <span className="form-box"></span>
                        </>
                      )}
                    </td>
                    <td className="py-3">
                      <div className="font-medium">{service.name}</div>
                      {isMaster && <div className="service-description">{service.description}</div>}
                    </td>
                    {isMaster ? (
                      <>
                        <td className="price-cell py-3">${service.individual}</td>
                        <td className="price-cell py-3">${service.small}</td>
                        <td className="price-cell py-3">${service.mid}</td>
                        <td className="price-cell py-3">${service.large}</td>
                      </>
                    ) : (
                      <td className="price-cell py-3">{getServicePrice(service)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Grant Writing Services */}
          <div>
            <h3 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b-2 border-gray-300">
              Grant Writing & Application Services
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="text-left py-2 w-12">{!isMaster && 'Select'}</th>
                  <th className="text-left py-2">Service Description</th>
                  {isMaster ? (
                    <>
                      <th className="text-right py-2 w-24">Individual</th>
                      <th className="text-right py-2 w-24">Small</th>
                      <th className="text-right py-2 w-24">Mid-Size</th>
                      <th className="text-right py-2 w-24">Large</th>
                    </>
                  ) : (
                    <th className="text-right py-2 w-32">Your Price</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {SERVICES.writing.filter(serviceApplies).map(service => (
                  <tr 
                    key={service.id} 
                    className={`border-b border-gray-200 service-row ${!isMaster && selectedServices.has(service.id) ? 'selected' : ''}`}
                    onClick={() => !isMaster && toggleService(service.id)}
                  >
                    <td className="py-3">
                      {!isMaster && (
                        <>
                          <input 
                            type="checkbox" 
                            className="interactive-checkbox"
                            checked={selectedServices.has(service.id)}
                            onChange={() => toggleService(service.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <span className="form-box"></span>
                        </>
                      )}
                    </td>
                    <td className="py-3">
                      <div className="font-medium">{service.name}</div>
                      {isMaster && <div className="service-description">{service.description}</div>}
                    </td>
                    {isMaster ? (
                      <>
                        <td className="price-cell py-3">${service.individual}</td>
                        <td className="price-cell py-3">${service.small}</td>
                        <td className="price-cell py-3">${service.mid}</td>
                        <td className="price-cell py-3">${service.large}</td>
                      </>
                    ) : (
                      <td className="price-cell py-3">{getServicePrice(service)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Support Services */}
          <div>
            <h3 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b-2 border-gray-300">
              Support & Compliance Services
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="text-left py-2 w-12">{!isMaster && 'Select'}</th>
                  <th className="text-left py-2">Service Description</th>
                  {isMaster ? (
                    <>
                      <th className="text-right py-2 w-24">Individual</th>
                      <th className="text-right py-2 w-24">Small</th>
                      <th className="text-right py-2 w-24">Mid-Size</th>
                      <th className="text-right py-2 w-24">Large</th>
                    </>
                  ) : (
                    <th className="text-right py-2 w-32">Your Price</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {SERVICES.support.filter(serviceApplies).map(service => (
                  <tr 
                    key={service.id} 
                    className={`border-b border-gray-200 service-row ${!isMaster && selectedServices.has(service.id) ? 'selected' : ''}`}
                    onClick={() => !isMaster && toggleService(service.id)}
                  >
                    <td className="py-3">
                      {!isMaster && (
                        <>
                          <input 
                            type="checkbox" 
                            className="interactive-checkbox"
                            checked={selectedServices.has(service.id)}
                            onChange={() => toggleService(service.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <span className="form-box"></span>
                        </>
                      )}
                    </td>
                    <td className="py-3">
                      <div className="font-medium">{service.name}</div>
                      {isMaster && <div className="service-description">{service.description}</div>}
                    </td>
                    {isMaster ? (
                      <>
                        <td className="price-cell py-3">${service.individual}</td>
                        <td className="price-cell py-3">${service.small}</td>
                        <td className="price-cell py-3">${service.mid}</td>
                        <td className="price-cell py-3">${service.large}</td>
                      </>
                    ) : (
                      <td className="price-cell py-3">{getServicePrice(service)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Hourly Services */}
          <div>
            <h3 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b-2 border-gray-300">
              Hourly Services
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="text-left py-2 w-12">{!isMaster && 'Select'}</th>
                  <th className="text-left py-2">Service Description</th>
                  {isMaster ? (
                    <>
                      <th className="text-right py-2 w-24">Individual</th>
                      <th className="text-right py-2 w-24">Small</th>
                      <th className="text-right py-2 w-24">Mid-Size</th>
                      <th className="text-right py-2 w-24">Large</th>
                    </>
                  ) : (
                    <th className="text-right py-2 w-32">Your Rate</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {SERVICES.hourly.filter(serviceApplies).map(service => (
                  <tr key={service.id} className="border-b border-gray-200">
                    <td className="py-3">
                      {!isMaster && <span className="form-box"></span>}
                    </td>
                    <td className="py-3">
                      <div className="font-medium">{service.name}</div>
                      {isMaster && <div className="service-description">{service.description}</div>}
                    </td>
                    {isMaster ? (
                      <>
                        <td className="price-cell py-3">${settings?.hourly_rates?.individual_household || 85}/hr</td>
                        <td className="price-cell py-3">${settings?.hourly_rates?.small_ministry_nonprofit || 85}/hr</td>
                        <td className="price-cell py-3">${settings?.hourly_rates?.midsize_org || 115}/hr</td>
                        <td className="price-cell py-3">${settings?.hourly_rates?.large_org || 150}/hr</td>
                      </>
                    ) : (
                      <td className="price-cell py-3">{getServicePrice(service)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer Group - keep everything together */}
        <div className="print-footer-group">
          {/* Special Discounts Section */}
          {!isMaster && organization && (
            <div className="mt-6 p-4 bg-amber-50 rounded-lg border-2 border-amber-300 avoid-break special-pricing-box">
              <h3 className="font-bold text-base text-amber-900 mb-2">Special Pricing Considerations</h3>
              <div className="space-y-1 text-xs text-amber-900">
                {organization.pro_bono && (
                  <p className="font-bold">✓ PRO BONO CLIENT - Services provided at no charge (invoice generated for tax write-off only)</p>
                )}
                {!organization.pro_bono && [
                  organization.ssi_recipient,
                  organization.ssdi_recipient,
                  organization.medicaid_enrolled,
                  organization.cancer_survivor,
                  organization.disaster_survivor,
                  organization.domestic_violence_survivor,
                  organization.trafficking_survivor,
                  (organization.household_income && organization.household_size && (organization.household_income / organization.household_size < 25000))
                ].some(q => q === true) && (
                    <p>✓ May qualify for hardship pricing caps on select services</p>
                  )}
                {!organization.pro_bono && ((organization.faith_based || organization.clergy || organization.missionary) && (!organization.annual_budget || organization.annual_budget < 250000)) && (
                  <p>✓ Qualifies for 25% ministry discount</p>
                )}
              </div>
            </div>
          )}

          {/* Payment Terms - more compact */}
          <div className="mt-6 p-4 bg-gray-50 rounded-lg border-2 border-gray-300 avoid-break payment-terms-box">
            <h3 className="font-bold text-base text-gray-900 mb-2">Payment Terms & Structure</h3>
            <div className="space-y-1 text-xs text-gray-700">
              <p><strong>Milestone-Based Payments:</strong></p>
              <ul className="ml-4 space-y-0">
                <li>• 40% due at project kickoff (scope locked, calendar set)</li>
                <li>• 40% due at complete draft delivery</li>
                <li>• 20% due at submission and handoff package delivery</li>
              </ul>
              <p className="mt-2"><strong>Standard Terms:</strong> Net 15 days from invoice date</p>
              <p><strong>Late Fees:</strong> 1.5% monthly interest on overdue balances</p>
              
              <p className="mt-3"><strong>Payment Methods:</strong></p>
              <ul className="ml-4 space-y-0">
                <li>• <strong>Check</strong> - Make payable to: <span className="font-semibold">John White</span></li>
                <li>• <strong>Venmo:</strong> @John-White-1384</li>
                <li>• <strong>CashApp:</strong> $jwhiternmba</li>
                <li>• ACH / Bank Transfer</li>
                <li>• Credit Card (processing fee may apply)</li>
                <li>• Bill-to-Grant (when allowed by funder)</li>
              </ul>
            </div>
          </div>

          {/* Signature Section - compact */}
          {!isMaster && (
            <div className="mt-6 pt-4 border-t-2 border-gray-900 avoid-break signature-section">
              <h3 className="font-bold text-base text-gray-900 mb-3">Service Agreement</h3>
              <p className="text-xs text-gray-700 mb-4">
                By signing below, I authorize GrantFlow to provide the selected services at the prices indicated.
                I understand that fees are for professional services rendered and are not contingent on award outcomes.
                I agree to the payment terms and ethical billing standards outlined above.
              </p>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <p className="text-xs mb-1 font-semibold">Client Signature:</p>
                  <div className="border-b-2 border-gray-900 signature-line"></div>
                </div>
                <div>
                  <p className="text-xs mb-1 font-semibold">Date:</p>
                  <div className="border-b-2 border-gray-900 signature-line"></div>
                </div>
              </div>
            </div>
          )}

          {/* Contract Terms & Conditions */}
          <div className="mt-8 avoid-break">
            <h3 className="font-bold text-xl text-gray-900 mb-4 border-b-2 border-gray-900 pb-2">
              CONTRACT TERMS & CONDITIONS
            </h3>
            
            <div className="space-y-3 text-xs text-gray-700 leading-relaxed">
              <div>
                <p className="font-bold text-gray-900 mb-1">1. SERVICES AGREEMENT</p>
                <p>
                  This agreement is between {settings?.business_name || settings?.consultant_name || 'John White'} ("Consultant") and the 
                  undersigned Client for grant writing and consulting services as selected above. Consultant agrees to provide 
                  professional services in accordance with industry standards, Grant Professionals Association (GPA) Code of Ethics, 
                  and all applicable laws and regulations.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">2. PAYMENT TERMS</p>
                <p>
                  Client agrees to pay for selected services at the rates specified. Payment is due within {settings?.net_terms_days || 15} days 
                  of invoice date unless otherwise agreed in writing. Late payments may incur a monthly service charge of 
                  {settings?.late_fee_monthly_percent || 1.5}%. For milestone-based projects: {settings?.milestone_deposit_percent || 40}% 
                  deposit at start, {settings?.milestone_draft_percent || 40}% upon draft delivery, {settings?.milestone_final_percent || 20}% upon final submission. 
                  Returned checks subject to $35 fee plus any bank charges.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">3. NO GUARANTEE OF AWARD</p>
                <p>
                  <strong>CONSULTANT MAKES NO WARRANTY, GUARANTEE, OR REPRESENTATION THAT ANY GRANT APPLICATION WILL BE FUNDED.</strong> Grant 
                  awards are solely at the discretion of funding agencies. Consultant's fee is for professional services rendered, not for 
                  results obtained. Client remains responsible for full payment regardless of whether a grant is awarded. Success depends on 
                  many factors beyond Consultant's control including funder priorities, competition, budget availability, and application requirements.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">4. CLIENT RESPONSIBILITIES</p>
                <p>
                  Client agrees to: (a) provide accurate, complete, and truthful information in a timely manner; (b) review all drafts and 
                  provide feedback within 5 business days or agreed timeframe; (c) ensure all submitted information is accurate and that Client 
                  has authority to enter this agreement; (d) obtain necessary approvals from board or governing body; (e) respond promptly to 
                  Consultant requests for information; (f) maintain confidentiality of proprietary research or strategy; and (g) notify Consultant 
                  immediately of any material changes affecting eligibility or project scope.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">5. SCOPE CHANGES & ADDITIONAL WORK</p>
                <p>
                  Scope of work is limited to services selected above. Any changes, additions, or extra work beyond the original scope must be 
                  documented in writing and will be billed separately at applicable rates. Examples of additional work include: responding to 
                  funder questions after submission, major rewrites due to changed funder requirements, preparing appeals, or work on 
                  different grant opportunities. Client will receive written notice and cost estimate before additional charges are incurred.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">6. CANCELLATION & REFUND POLICY</p>
                <p>
                  Either party may terminate with 7 days written notice. Upon cancellation: (a) Client pays for all work completed through 
                  cancellation date; (b) For flat fee projects, deposits are non-refundable after work commences, milestone payments refunded 
                  only for work not yet completed; (c) For hourly projects, Client pays for all documented hours worked; (d) Consultant will 
                  provide all work completed to date; (e) No refunds for "Quick Eligibility" or "Strategy Session" services after delivery. 
                  Consultant may terminate immediately if Client breaches this agreement, fails to pay, or requests unethical/illegal practices.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">7. DEADLINES & TIMELY PERFORMANCE</p>
                <p>
                  Consultant will make reasonable efforts to meet agreed deadlines. However, timely performance depends on Client providing 
                  information and feedback as requested. Consultant is not liable for missed funder deadlines caused by: Client delays in 
                  providing information, Client delays in reviewing/approving drafts, funder portal technical issues, or other circumstances 
                  beyond Consultant's reasonable control. Rush fees apply when Client requests completion in less than normal timeframes.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">8. CONFIDENTIALITY & DATA PRIVACY</p>
                <p>
                  Consultant agrees to maintain confidentiality of all client information and will not disclose sensitive data to third parties 
                  without written permission, except as: (a) required by law; (b) necessary to perform services (e.g., submitting to funders); 
                  or (c) necessary to defend against legal claims. Client data will be stored securely and not sold or shared for marketing purposes.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">9. INTELLECTUAL PROPERTY & WORK PRODUCT</p>
                <p>
                  Upon receipt of full payment, all work product created specifically for Client (proposals, budgets, narratives, etc.) becomes 
                  Client's property for use, modification, and submission. Consultant retains right to: (a) use general methodologies, processes, 
                  and templates for other clients; (b) reuse non-identifying information and lessons learned; (c) use project as portfolio/reference 
                  example unless Client objects in writing. Consultant retains ownership of proprietary research databases, software tools, and 
                  assessment methodologies.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">10. LIMITATION OF LIABILITY</p>
                <p>
                  <strong>CONSULTANT'S TOTAL LIABILITY UNDER THIS AGREEMENT SHALL NOT EXCEED THE TOTAL FEES PAID BY CLIENT FOR THE SPECIFIC PROJECT.</strong> 
                  Consultant is not liable for: (a) funding decisions or award amounts; (b) changes in funder requirements after submission; 
                  (c) delays caused by Client, funders, or third parties; (d) technical failures of funder portals or systems; (e) Client's 
                  failure to meet grant requirements post-award; or (f) any consequential, indirect, special, incidental, or punitive damages. 
                  CONSULTANT MAKES NO WARRANTIES EXPRESS OR IMPLIED INCLUDING MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">11. COMPLIANCE, ETHICS & PROFESSIONAL STANDARDS</p>
                <p>
                  All work conducted in accordance with: Grant Professionals Association Code of Ethics, applicable federal grant regulations 
                  (2 CFR 200), IRS rules for charitable organizations, and state/local laws. Consultant will not: lobby with grant funds, make 
                  false statements, submit plagiarized content, guarantee outcomes, charge percentage-based fees on grant awards, or engage in 
                  conflicts of interest. Client certifies eligibility for applied-for funding and authority to submit applications on behalf of 
                  organization if applicable.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">12. DISPUTE RESOLUTION & GOVERNING LAW</p>
                <p>
                  Disputes shall first be addressed through good-faith negotiation within 30 days of written notice. If unresolved, parties 
                  agree to non-binding mediation before pursuing litigation. This agreement is governed by Tennessee law without regard to 
                  conflicts of law provisions. Venue for any legal action shall be in Hamilton County, Tennessee. Prevailing party in any 
                  dispute may recover reasonable attorney fees and costs.
                </p>
              </div>

              <div>
                <p className="font-bold text-gray-900 mb-1">13. ENTIRE AGREEMENT & AMENDMENTS</p>
                <p>
                  This document constitutes the entire agreement between parties and supersedes all prior oral or written agreements, 
                  understandings, or representations. Any modifications, amendments, or waivers must be made in writing and signed by both 
                  parties. No oral modifications are valid. If any provision is found unenforceable, remaining provisions remain in full effect.
                </p>
              </div>

              <div className="mt-4 p-3 bg-slate-200 rounded border-2 border-slate-400">
                <p className="text-xs text-slate-800 text-center italic">
                  <strong>NOTICE:</strong> Client has the right to seek independent legal counsel before signing this agreement. 
                  This contract becomes binding when signed by both parties.
                </p>
              </div>
            </div>
          </div>

          {/* Signature Block - Contract Execution */}
          <div className="mt-6 p-4 bg-white rounded-lg border-4 border-slate-900 avoid-break">
            <p className="text-sm text-slate-700 mb-4 text-center font-bold bg-yellow-100 p-2 rounded border-2 border-yellow-400">
              ⚠️ By signing below, both parties acknowledge they have read, understand, and agree to be bound by all terms and 
              conditions in this contract, including the selected services and pricing above.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-4">
              {/* Client Signature */}
              <div className="space-y-2">
                <p className="font-bold text-slate-900 text-base border-b-2 border-slate-300 pb-1">CLIENT SIGNATURE:</p>
                
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-1">Printed Name:</p>
                  <div className="border-b-2 border-slate-900 pb-1">&nbsp;</div>
                </div>
                
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-1">Title/Position (if org):</p>
                  <div className="border-b-2 border-slate-900 pb-1">&nbsp;</div>
                </div>
                
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-1">Organization Name (if applicable):</p>
                  <div className="border-b-2 border-slate-900 pb-1">&nbsp;</div>
                </div>
                
                <div className="pt-2">
                  <p className="text-xs font-semibold text-slate-700 mb-1">Signature:</p>
                  <div className="border-b-2 border-slate-900 pb-8">&nbsp;</div>
                </div>
                
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-1">Date:</p>
                  <div className="border-b-2 border-slate-900 pb-1">&nbsp;</div>
                </div>
              </div>

              {/* Consultant Signature */}
              <div className="space-y-2">
                <p className="font-bold text-slate-900 text-base border-b-2 border-slate-300 pb-1">CONSULTANT SIGNATURE:</p>
                
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-1">Printed Name:</p>
                  <div className="border-b-2 border-slate-900 pb-1 text-slate-700">
                    {settings?.consultant_name || 'John White'}
                  </div>
                </div>
                
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-1">Title:</p>
                  <div className="border-b-2 border-slate-900 pb-1 text-slate-700">
                    Grant Writing Consultant
                  </div>
                </div>
                
                <div className="pt-2">
                  <p className="text-xs font-semibold text-slate-700 mb-1">Signature:</p>
                  <div className="border-b-2 border-slate-900 pb-8">&nbsp;</div>
                </div>
                
                <div>
                  <p className="text-xs font-semibold text-slate-700 mb-1">Date:</p>
                  <div className="border-b-2 border-slate-900 pb-1">&nbsp;</div>
                </div>
              </div>
            </div>

            <div className="mt-3 pt-2 border-t-2 border-slate-300">
              <p className="text-xs text-slate-600 text-center italic">
                Each party should retain a signed copy of this contract for their records. 
                This agreement becomes effective on the date of the last signature.
              </p>
            </div>
          </div>

          {/* Footer - compact */}
          <div className="mt-6 pt-3 border-t border-gray-300 text-center text-xs text-gray-500 avoid-break print-footer">
            <p>GrantFlow Professional Grant Writing Services • Created by John White</p>
            <p className="mt-1">Dr.JohnWhite@axiombiolabs.org • Cell: 423-504-7778 • Fax: 423-414-5290</p>
            <p className="mt-2 italic">
              We reserve {settings?.pro_bono_tithe_percent || 10}% of revenue for pro bono services to those in crisis
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}