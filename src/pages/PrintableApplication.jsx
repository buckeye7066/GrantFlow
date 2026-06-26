import React from 'react';
import { Button } from '@/components/ui/button';
import { FileDown } from 'lucide-react';

const PRINT_STYLES = `
  @media print {
    .no-print {
      display: none !important;
    }
    @page {
      margin: 0.6in 0.5in;
      size: letter portrait;
    }
    body {
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
      overflow: visible !important;
    }
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      overflow: visible !important;
    }
    .max-w-4xl {
      max-width: 100% !important;
    }
    .p-8 {
      padding: 0 !important;
    }
    .pt-20 {
      padding-top: 0 !important;
    }
    body, p, div, span {
      font-size: 11px !important;
      line-height: 1.3 !important;
    }
    .text-xs {
      font-size: 9px !important;
    }
    .text-sm {
      font-size: 10px !important;
    }
    .ml-4 {
      margin-left: 12px !important;
    }
    .ml-7 {
      margin-left: 20px !important;
    }
    .ml-8 {
      margin-left: 24px !important;
    }
    .mb-1 {
      margin-bottom: 3px !important;
    }
    .mb-2 {
      margin-bottom: 5px !important;
    }
    .mt-2 {
      margin-top: 5px !important;
    }
    .mt-3 {
      margin-top: 8px !important;
    }
    .mt-4 {
      margin-top: 10px !important;
    }
    .pb-3 {
      padding-bottom: 8px !important;
    }
  }

  .form-line {
    border-bottom: 1px solid #000;
    min-height: 18px;
    margin-bottom: 5px;
    display: block;
  }
  .form-box {
    border: 1px solid #000;
    padding: 2px;
    min-height: 16px;
    display: inline-block;
    width: 16px;
    margin-right: 6px;
    vertical-align: middle;
  }
  .inline-entry {
    border-bottom: 1px solid #000;
    display: inline-block;
    min-height: 16px;
    vertical-align: baseline;
  }
  .form-section {
    margin-bottom: 16px;
    page-break-inside: auto;
  }
  h1, h2, h3 {
    font-weight: bold;
    margin-bottom: 8px;
  }
  h1 { font-size: 20px; }
  h2 {
    font-size: 15px;
    margin-top: 16px;
    padding-top: 6px;
  }
  h3 {
    font-size: 12px;
    margin-top: 10px;
  }
  .page-break {
    page-break-after: always;
    break-after: page;
    height: 0;
    margin: 0;
    padding: 0;
  }
  .avoid-break {
    page-break-inside: avoid;
    break-inside: avoid;
  }
`;

export default function PrintableApplication() {
  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="min-h-screen bg-white">
      {/*
        PRINT_STYLES is a static, hard-coded constant defined in this module.
        It contains no dynamic or user-supplied input, so it is safe to render
        as a <style> element. Do NOT interpolate untrusted/user data into this
        string.
      */}
      <style>{PRINT_STYLES}</style>

      <div className="no-print fixed top-4 right-4 z-50">
        <Button onClick={handlePrint} className="bg-blue-600 hover:bg-blue-700 shadow-lg">
          <FileDown className="w-4 h-4 mr-2" />
          Save as PDF
        </Button>
      </div>

      <div className="max-w-4xl mx-auto p-8 pt-20 bg-white">
        <div className="text-center mb-6 pb-3 border-b-2 border-black avoid-break">
          <h1>COMPREHENSIVE PROFILE APPLICATION</h1>
          <p className="text-sm mt-2">Please complete all relevant sections below. If a section does not apply to you, simply leave it blank. This form helps us get to know you better, your background, achievements, and goals, all of which ensure we can serve you most effectively.</p>
        </div>

        <div className="form-section avoid-break">
          <h2>1. PRIMARY PROFILE TYPE</h2>
          <p className="mb-2">Select your PRIMARY profile type (you can indicate additional qualifications in later sections):</p>
          <div className="ml-4">
            <div><span className="form-box"></span> Organization (Nonprofit, Business, School)</div>
            <div><span className="form-box"></span> High School Student</div>
            <div><span className="form-box"></span> College Student</div>
            <div><span className="form-box"></span> Graduate Student</div>
            <div><span className="form-box"></span> Homeschool Family</div>
            <div><span className="form-box"></span> Individual Seeking Assistance</div>
            <div><span className="form-box"></span> Medical/Healthcare Assistance</div>
            <div><span className="form-box"></span> Family/Household</div>
            <div><span className="form-box"></span> Other: <span className="inline-entry" style={{width: '200px'}}></span></div>
          </div>
          <p className="text-xs mt-2" style={{marginLeft: '16px'}}>
            Note: You may fit multiple categories. Choose the one that best describes your PRIMARY reason for seeking funding. 
            Additional qualifications (medical needs, family situation, demographics, etc.) will be captured in Sections 5-13.
          </p>
        </div>

        <div className="form-section avoid-break">
          <h2>2. BASIC INFORMATION</h2>
          <div className="mb-2">
            <strong>Full Name / Organization Name: *</strong>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Date of Birth (Individuals only):</strong>
            <span className="inline-entry" style={{width: '150px', marginLeft: '8px'}}></span>
            <span style={{marginLeft: '16px'}}><strong>Age:</strong> <span className="inline-entry" style={{width: '50px', marginLeft: '8px'}}></span></span>
          </div>
          <div className="mb-2">
            <strong>Social Security Number (if applicable):</strong>
            <span className="inline-entry" style={{width: '150px', marginLeft: '8px'}}></span>
          </div>
          <div className="mb-2">
            <strong>Green Card Number (if applicable):</strong>
            <span className="inline-entry" style={{width: '200px', marginLeft: '8px'}}></span>
          </div>
          <div className="mb-2">
            <strong>Email Address(es):</strong>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Phone Number(s):</strong>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Website (if applicable):</strong>
            <div className="form-line"></div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>3. ADDRESS</h2>
          <div className="mb-2">
            <strong>Street Address:</strong>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>City:</strong>
            <span className="inline-entry" style={{width: '200px', marginLeft: '8px'}}></span>
            <span style={{marginLeft: '24px'}}><strong>State:</strong> <span className="inline-entry" style={{width: '80px', marginLeft: '8px'}}></span></span>
            <span style={{marginLeft: '24px'}}><strong>ZIP:</strong> <span className="inline-entry" style={{width: '100px', marginLeft: '8px'}}></span></span>
          </div>
        </div>

        <div className="form-section">
          <h2>4. ORGANIZATION DETAILS (Organizations Only)</h2>
          <div className="mb-2">
            <strong>EIN (Tax ID):</strong>
            <span className="inline-entry" style={{width: '200px', marginLeft: '8px'}}></span>
            <span style={{marginLeft: '24px'}}><strong>UEI:</strong> <span className="inline-entry" style={{width: '200px', marginLeft: '8px'}}></span></span>
          </div>
          <div className="mb-2">
            <strong>Organization Type:</strong>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Annual Budget:</strong> $<span className="inline-entry" style={{width: '150px', marginLeft: '4px'}}></span>
            <span style={{marginLeft: '24px'}}><strong>Staff Count:</strong> <span className="inline-entry" style={{width: '50px', marginLeft: '8px'}}></span></span>
          </div>
          
          <h3 className="mt-3">General Qualifications:</h3>
          <div className="ml-4 mt-2">
            <div className="mb-1">
              <div><span className="form-box"></span> SAM.gov Registered</div>
              <p className="text-xs italic text-slate-600 ml-7">System for Award Management - required for federal grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Faith-Based Organization / Church / Ministry</div>
              <p className="text-xs italic text-slate-600 ml-7">Religious nonprofit, church, ministry, or denominational organization</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Serves Rural Area</div>
              <p className="text-xs italic text-slate-600 ml-7">Organization primarily serves rural communities or populations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Minority-Serving Organization</div>
              <p className="text-xs italic text-slate-600 ml-7">Organization primarily serves minority populations or communities</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> 501(c)(3) Public Charity</div>
              <p className="text-xs italic text-slate-600 ml-7">Tax-exempt nonprofit that receives public support</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> 501(c)(3) Private Foundation</div>
              <p className="text-xs italic text-slate-600 ml-7">Tax-exempt nonprofit funded by single source/family</p>
            </div>
          </div>

          <h3 className="mt-3">Specialized Organization Types:</h3>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> School District / Charter School</div>
              <p className="text-xs italic text-slate-600 ml-7">Public school district or charter school network</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> University / College</div>
              <p className="text-xs italic text-slate-600 ml-7">Higher education institution</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Hospital / Clinic / FQHC</div>
              <p className="text-xs italic text-slate-600 ml-7">FQHC = Federally Qualified Health Center</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Tribal Government / Tribally Controlled Org</div>
              <p className="text-xs italic text-slate-600 ml-7">Federally recognized tribe or tribal organization</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Community Action Agency</div>
              <p className="text-xs italic text-slate-600 ml-7">Federally designated anti-poverty organization</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Community Development Corporation (CDC)</div>
              <p className="text-xs italic text-slate-600 ml-7">Nonprofit focused on revitalizing communities</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Housing Authority</div>
              <p className="text-xs italic text-slate-600 ml-7">Public or tribal housing agency</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Workforce Development Board</div>
              <p className="text-xs italic text-slate-600 ml-7">Local workforce investment board</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Veterans Service Organization</div>
              <p className="text-xs italic text-slate-600 ml-7">Organization serving veterans and military families</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Volunteer Fire/EMS</div>
              <p className="text-xs italic text-slate-600 ml-7">Volunteer fire department or emergency medical services</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Research Institute / Lab</div>
              <p className="text-xs italic text-slate-600 ml-7">Academic or independent research facility</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Cooperative (Ag/Electric/Housing/Worker)</div>
              <p className="text-xs italic text-slate-600 ml-7">Member-owned cooperative enterprise</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> CDFI Partner</div>
              <p className="text-xs italic text-slate-600 ml-7">Community Development Financial Institution</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> MSI/HBCU/HSI/TCU</div>
              <p className="text-xs italic text-slate-600 ml-7">Minority-Serving Institution / Historically Black College / Hispanic-Serving / Tribal College</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Rural Health Clinic</div>
              <p className="text-xs italic text-slate-600 ml-7">Medicare-certified rural primary care facility</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Environmental/Conservation Organization</div>
              <p className="text-xs italic text-slate-600 ml-7">Organization focused on environmental protection or conservation</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Labor Union Organization</div>
              <p className="text-xs italic text-slate-600 ml-7">Labor union or worker advocacy organization</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Agricultural Extension Partner</div>
              <p className="text-xs italic text-slate-600 ml-7">Partner with USDA Cooperative Extension programs</p>
            </div>
          </div>

          <h3 className="mt-3">Business Certifications (if applicable):</h3>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> 8(a) Certified</div>
              <p className="text-xs italic text-slate-600 ml-7">SBA program for disadvantaged business enterprises</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Service-Disabled Veteran-Owned Small Business (SDVOSB)</div>
              <p className="text-xs italic text-slate-600 ml-7">VA-verified certification for veteran-owned businesses</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> HUBZone Certified</div>
              <p className="text-xs italic text-slate-600 ml-7">Historically Underutilized Business Zone certification</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Disadvantaged Business Enterprise (DBE)</div>
              <p className="text-xs italic text-slate-600 ml-7">DOT certification for minority/women-owned businesses</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Minority Business Enterprise (MBE)</div>
              <p className="text-xs italic text-slate-600 ml-7">State/local certification for minority-owned businesses</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Women Business Enterprise (WBE)</div>
              <p className="text-xs italic text-slate-600 ml-7">State/local certification for women-owned businesses</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Small Business Enterprise (SBE)</div>
              <p className="text-xs italic text-slate-600 ml-7">State/local small business certification</p>
            </div>
            <div><span className="form-box"></span> Minority-Owned Business</div>
            <div><span className="form-box"></span> Women-Owned Business</div>
          </div>

          <h3 className="mt-3">Geographic & Special Designations:</h3>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> Qualified Census Tract (QCT) Location</div>
              <p className="text-xs italic text-slate-600 ml-7">HUD-designated low-income area</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Opportunity Zone</div>
              <p className="text-xs italic text-slate-600 ml-7">Economically distressed community eligible for tax incentives</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> EPA Environmental Justice Area</div>
              <p className="text-xs italic text-slate-600 ml-7">Community with environmental and health disparities</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> USDA Persistent-Poverty County</div>
              <p className="text-xs italic text-slate-600 ml-7">County with 20%+ poverty for 30+ years</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Tribal Reservation/Trust Land</div>
              <p className="text-xs italic text-slate-600 ml-7">Located on tribal land or reservation</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> U.S. Territory (PR, GU, USVI, AS, MP)</div>
              <p className="text-xs italic text-slate-600 ml-7">Puerto Rico, Guam, Virgin Islands, American Samoa, Northern Mariana Islands</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> FEMA Disaster Declaration Area</div>
              <p className="text-xs italic text-slate-600 ml-7">Area with active or recent federal disaster declaration</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Appalachian Region</div>
              <p className="text-xs italic text-slate-600 ml-7">Region served by Appalachian Regional Commission</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Urban Underserved Area</div>
              <p className="text-xs italic text-slate-600 ml-7">Low-income urban community with limited resources</p>
            </div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>5. EDUCATION INFORMATION (Students Only)</h2>
          <p className="mb-2">Check all grade levels that apply:</p>
          <div className="ml-4 mb-2">
            <div><span className="form-box"></span> High School Freshman</div>
            <div><span className="form-box"></span> High School Sophomore</div>
            <div><span className="form-box"></span> High School Junior</div>
            <div><span className="form-box"></span> High School Senior</div>
            <div><span className="form-box"></span> College Freshman</div>
            <div><span className="form-box"></span> College Sophomore</div>
            <div><span className="form-box"></span> College Junior</div>
            <div><span className="form-box"></span> College Senior</div>
            <div><span className="form-box"></span> Graduate Student</div>
            <div><span className="form-box"></span> GED Graduate</div>
            <div><span className="form-box"></span> Returning Adult Student</div>
          </div>

          <h3 className="mt-3">Education Type & Setting:</h3>
          <div className="ml-4 mb-2">
            <div><span className="form-box"></span> Homeschool Student</div>
            <div><span className="form-box"></span> Private School Student</div>
            <div><span className="form-box"></span> Charter or Micro-School Student</div>
            <div><span className="form-box"></span> Virtual Academy Participant</div>
            <div><span className="form-box"></span> Parent-Led Education</div>
            <div><span className="form-box"></span> Homeschool Co-op Member</div>
            <div className="mb-1">
              <div><span className="form-box"></span> ESA (Education Savings Account) Eligible</div>
              <p className="text-xs italic text-slate-600 ml-7">State-funded account for educational expenses</p>
            </div>
            <div><span className="form-box"></span> Education Choice/Parental Choice Participant</div>
          </div>
          
          <div className="mb-2">
            <strong>Current College/University:</strong>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Target/Interested Colleges (list all):</strong>
            <div className="form-line"></div>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Intended Major/Field of Study:</strong>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>GPA:</strong>
            <span className="inline-entry" style={{width: '80px', marginLeft: '8px'}}></span>
            <span style={{marginLeft: '24px'}}><strong>ACT:</strong> <span className="inline-entry" style={{width: '80px', marginLeft: '8px'}}></span></span>
            <span style={{marginLeft: '24px'}}><strong>SAT:</strong> <span className="inline-entry" style={{width: '80px', marginLeft: '8px'}}></span></span>
            <span style={{marginLeft: '24px'}}><strong>Service Hrs:</strong> <span className="inline-entry" style={{width: '80px', marginLeft: '8px'}}></span></span>
          </div>
          
          <h3 className="mt-3">Academic Characteristics:</h3>
          <div className="ml-4">
            <div><span className="form-box"></span> First-Generation College Student</div>
            <div><span className="form-box"></span> STEM Student</div>
            <div><span className="form-box"></span> Arts/Humanities Field</div>
            <div><span className="form-box"></span> Medical/Nursing/Allied Health Field</div>
            <div><span className="form-box"></span> Education/Social Work Field</div>
            <div><span className="form-box"></span> Trade/Apprenticeship Participant</div>
            <div><span className="form-box"></span> Recent Graduate</div>
            <div><span className="form-box"></span> Student with Dependent Children</div>
            <div className="mb-1">
              <div><span className="form-box"></span> Pell Grant Eligible</div>
              <p className="text-xs italic text-slate-600 ml-7">Federal grant for low-income students (typically household income under $60,000)</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> FAFSA Completed</div>
              <p className="text-xs italic text-slate-600 ml-7">Free Application for Federal Student Aid - required for most financial aid</p>
            </div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>6. FINANCIAL SITUATION</h2>
          <div className="mb-2">
            <strong>Annual Household Income:</strong> $<span className="inline-entry" style={{width: '150px', marginLeft: '4px'}}></span>
          </div>
          <div className="mb-2">
            <strong>Household Size:</strong>
            <span className="inline-entry" style={{width: '50px', marginLeft: '8px'}}></span> people
          </div>

          <h3 className="mt-3">Financial Challenges:</h3>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> Low Income</div>
              <p className="text-xs italic text-slate-600 ml-7">Generally defined as income at or below 200% of federal poverty level (varies by household size)</p>
            </div>
            <div><span className="form-box"></span> Unemployed</div>
            <div><span className="form-box"></span> Underemployed</div>
            <div><span className="form-box"></span> Displaced Worker</div>
            <div><span className="form-box"></span> Disabled</div>
            <div><span className="form-box"></span> Job Retraining Participant</div>
            <div><span className="form-box"></span> Uninsured / Underinsured</div>
            <div><span className="form-box"></span> Medical Debt</div>
            <div><span className="form-box"></span> Education Debt</div>
            <div><span className="form-box"></span> Bankruptcy / Foreclosure</div>
            <div><span className="form-box"></span> First-Time Homebuyer</div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>7. GOVERNMENT ASSISTANCE PROGRAMS</h2>
          <p className="mb-2">Check all programs you currently receive:</p>
          <div className="ml-4">
            <div><span className="form-box"></span> Medicaid</div>
            <div><span className="form-box"></span> Medicare</div>
            <div className="mb-1">
              <div><span className="form-box"></span> SSI (Supplemental Security Income)</div>
              <p className="text-xs italic text-slate-600 ml-7">Cash assistance for disabled, blind, or elderly with limited income</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> SSDI (Social Security Disability)</div>
              <p className="text-xs italic text-slate-600 ml-7">Social Security Disability Insurance for those who worked and paid Social Security taxes</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> SNAP (Food Stamps)</div>
              <p className="text-xs italic text-slate-600 ml-7">Supplemental Nutrition Assistance Program</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> TANF (Temporary Assistance)</div>
              <p className="text-xs italic text-slate-600 ml-7">Temporary Assistance for Needy Families - cash assistance and support services</p>
            </div>
            <div><span className="form-box"></span> Section 8 Housing</div>
            <div><span className="form-box"></span> Public Housing Resident</div>
          </div>
          <div className="mt-2 mb-2">
            <strong>If Medicaid, Waiver Program:</strong>
            <div className="ml-4">
              <div className="mb-1">
                <div><span className="form-box"></span> ECF CHOICES (TN)</div>
                <p className="text-xs italic text-slate-600 ml-7">Employment and Community First CHOICES - Tennessee Medicaid long-term services for adults with disabilities</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Katie Beckett</div>
                <p className="text-xs italic text-slate-600 ml-7">Medicaid coverage for children with disabilities regardless of parent income</p>
              </div>
              <div><span className="form-box"></span> Self-Determination</div>
              <div><span className="form-box"></span> Family Support</div>
              <div><span className="form-box"></span> Other: <span className="inline-entry" style={{width: '200px', marginLeft: '4px'}}></span></div>
            </div>
          </div>
          <div className="mb-2">
            <strong>Medicaid Number (if applicable):</strong>
            <div className="form-line"></div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>8. HEALTH & MEDICAL CONDITIONS</h2>
          <div className="ml-4 mb-2">
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Cancer Survivor / Current Cancer Patient</div>
              <div className="ml-8">
                Type: <span className="inline-entry" style={{width: '180px', marginLeft: '4px'}}></span>
                <span style={{marginLeft: '16px'}}>Year: <span className="inline-entry" style={{width: '80px', marginLeft: '4px'}}></span></span>
              </div>
            </div>
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Chronic Illness</div>
              <div className="ml-8">
                Type: <span className="inline-entry" style={{width: '300px', marginLeft: '4px'}}></span>
              </div>
            </div>
            <div><span className="form-box"></span> Dialysis Patient</div>
            <div><span className="form-box"></span> Organ Transplant Recipient</div>
            <div><span className="form-box"></span> HIV/AIDS</div>
            <div><span className="form-box"></span> Long COVID</div>
            <div><span className="form-box"></span> Traumatic Brain Injury (TBI)</div>
            <div><span className="form-box"></span> Amputee</div>
            <div><span className="form-box"></span> Neurodivergent (Autism, ADHD, etc.)</div>
            <div><span className="form-box"></span> Visual Impairment</div>
            <div><span className="form-box"></span> Hearing Impairment</div>
            <div><span className="form-box"></span> Wheelchair User</div>
            <div><span className="form-box"></span> Substance Recovery Participant</div>
            <div><span className="form-box"></span> Mental Health Condition (PTSD, Depression, etc.)</div>
            <div><span className="form-box"></span> Maternal/Prenatal/Perinatal Health Needs</div>
            <div><span className="form-box"></span> Hospice / Palliative Care</div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>9. DEMOGRAPHICS & BACKGROUND</h2>
          <p className="mb-2"><strong>Immigration/Citizenship Status:</strong></p>
          <div className="ml-4 mb-2">
            <div><span className="form-box"></span> U.S. Citizen</div>
            <div><span className="form-box"></span> Permanent Resident (Green Card)</div>
            <div><span className="form-box"></span> Refugee</div>
            <div><span className="form-box"></span> Asylee</div>
            <div><span className="form-box"></span> DACA Recipient</div>
            <div><span className="form-box"></span> Visa Holder</div>
            <div><span className="form-box"></span> New Immigrant (within last 5 years)</div>
            <div><span className="form-box"></span> Other</div>
          </div>
          <p className="mb-2"><strong>Race/Ethnicity (Check all that apply):</strong></p>
          <div className="ml-4 mb-2">
            <div><span className="form-box"></span> African American / Black</div>
            <div><span className="form-box"></span> Hispanic / Latino</div>
            <div><span className="form-box"></span> Asian American</div>
            <div className="avoid-break">
              <div><span className="form-box"></span> Native American / Alaska Native</div>
              <div className="ml-8">
                Tribal Affiliation: <span className="inline-entry" style={{width: '250px', marginLeft: '4px'}}></span>
              </div>
            </div>
          </div>
          <div className="ml-4">
            <div><span className="form-box"></span> LGBTQ+</div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>10. FAMILY & LIFE SITUATION</h2>
          <p className="mb-2">Check all that apply:</p>
          <div className="ml-4">
            <div><span className="form-box"></span> Single Parent</div>
            <div><span className="form-box"></span> Foster Youth / Former Foster Care</div>
            <div><span className="form-box"></span> Orphan</div>
            <div><span className="form-box"></span> Adopted</div>
            <div><span className="form-box"></span> Foster or Adoptive Parent</div>
            <div><span className="form-box"></span> Family Caregiver</div>
            <div><span className="form-box"></span> Widow / Widower</div>
            <div><span className="form-box"></span> Grandparent Raising Grandchildren</div>
            <div><span className="form-box"></span> First-Time Parent</div>
            <div><span className="form-box"></span> Homeless / Housing Insecure</div>
            <div><span className="form-box"></span> Domestic Violence Survivor</div>
            <div><span className="form-box"></span> Human Trafficking Survivor</div>
            <div><span className="form-box"></span> Disaster Survivor</div>
            <div><span className="form-box"></span> Formerly Incarcerated / Returning Citizen</div>
            <div><span className="form-box"></span> Minor Child (Under 18)</div>
            <div><span className="form-box"></span> Young Adult (18-24)</div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>11. MILITARY SERVICE</h2>
          <div className="ml-4">
            <div><span className="form-box"></span> Veteran</div>
            <div><span className="form-box"></span> Active Duty Military</div>
            <div><span className="form-box"></span> National Guard / Reserve</div>
            <div><span className="form-box"></span> Disabled Veteran</div>
            <div><span className="form-box"></span> Military Spouse</div>
            <div><span className="form-box"></span> Military Dependent</div>
            <div><span className="form-box"></span> Gold Star Family Member</div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>12. OCCUPATION & WORK</h2>
          <div className="ml-4">
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Healthcare Worker</div>
              <div className="ml-8">
                Type: <span className="inline-entry" style={{width: '250px', marginLeft: '4px'}}></span>
              </div>
            </div>
            <div><span className="form-box"></span> EMS Worker / First Responder</div>
            <div><span className="form-box"></span> Teacher / Educator</div>
            <div><span className="form-box"></span> Firefighter</div>
            <div><span className="form-box"></span> Law Enforcement Officer</div>
            <div><span className="form-box"></span> Public Servant / Government Employee</div>
            <div><span className="form-box"></span> Clergy / Minister / Religious Worker</div>
            <div><span className="form-box"></span> Missionary / Evangelist</div>
            <div><span className="form-box"></span> Nonprofit Employee</div>
            <div><span className="form-box"></span> Small Business Owner</div>
            <div><span className="form-box"></span> Union Member</div>
            <div><span className="form-box"></span> Farmer / Agricultural Worker</div>
            <div><span className="form-box"></span> Truck Driver / Transportation Worker</div>
            <div><span className="form-box"></span> Construction / Trades Worker</div>
            <div><span className="form-box"></span> Researcher / Scientist</div>
            <div><span className="form-box"></span> Environmental / Conservation Worker</div>
            <div><span className="form-box"></span> Energy Sector Worker (incl. Renewables)</div>
            <div><span className="form-box"></span> Artist / Musician / Cultural Worker</div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>13. YOUR STORY & GOALS</h2>
          
          <h3>What are your goals? What do you hope to achieve?</h3>
          <div className="form-line"></div>
          <div className="form-line"></div>
          <div className="form-line"></div>
          
          <h3>What makes you unique? Tell us your story.</h3>
          <div className="form-line"></div>
          <div className="form-line"></div>
          <div className="form-line"></div>
          
          <h3>How much funding do you need and what will it be used for?</h3>
          <div className="form-line"></div>
          <div className="form-line"></div>
          
          <h3>What challenges or barriers have you faced?</h3>
          <div className="form-line"></div>
          <div className="form-line"></div>
          
          <h3>Who supports you? (Family, mentors, organizations)</h3>
          <div className="form-line"></div>
          <div className="form-line"></div>
        </div>

        <div className="form-section avoid-break">
          <h2>14. ADDITIONAL INFORMATION</h2>
          <div className="mb-2">
            <strong>Extracurricular Activities / Interests (list all):</strong>
            <div className="form-line"></div>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Awards & Achievements:</strong>
            <div className="form-line"></div>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Keywords (topics relevant to your needs/interests):</strong>
            <div className="form-line"></div>
            <div className="form-line"></div>
          </div>
        </div>

        <div className="mt-8 pt-4 border-t-2 border-black avoid-break">
          <p className="text-sm mb-2">
            <strong>Signature:</strong> <span className="inline-entry" style={{width: '350px', marginLeft: '16px'}}></span>
          </p>
          <p className="text-sm mb-4">
            <strong>Date:</strong> <span className="inline-entry" style={{width: '200px', marginLeft: '16px'}}></span>
          </p>
          <p className="text-sm mt-4">
            <strong>INSTRUCTIONS:</strong> After completing this form, hand it back to John White, fax it to: 423-414-5290, or email it to: Dr.JohnWhite@axiombiolabs.org
          </p>
        </div>
      </div>
    </div>
  );
}
