import React from 'react';
import { Button } from '@/components/ui/button';
import { FileDown } from 'lucide-react';
import PrintableApplicationStyles from '@/components/printable/PrintableApplicationStyles';

export default function PrintableApplication() {
  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="min-h-screen bg-white">
      <PrintableApplicationStyles />

      <div className="no-print fixed top-4 right-4 z-50">
        <Button onClick={handlePrint} className="bg-blue-600 hover:bg-blue-700 shadow-lg">
          <FileDown className="w-4 h-4 mr-2" />
          Save as PDF
        </Button>
      </div>

      <div className="max-w-4xl mx-auto p-8 bg-white">
        <div className="text-center mb-6 pb-3 border-b-2 border-black avoid-break">
          <h1>COMPREHENSIVE PROFILE APPLICATION</h1>
          <p className="text-sm mt-2">Complete all relevant sections. Leave blank sections that don't apply. This comprehensive form ensures we serve you effectively.</p>
          <p className="text-xs text-slate-500 mt-3">Created by John White</p>
        </div>

        <div className="form-section avoid-break">
          <h2>1. PRIMARY PROFILE TYPE</h2>
          <p className="mb-2">Select your PRIMARY profile type (you can indicate additional qualifications in later sections):</p>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> Organization (Nonprofit, Business, School)</div>
              <p className="text-xs italic text-slate-600 ml-7">501(c)(3), business, school district, hospital, or other entity applying for grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> High School Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Grades 9-12 - seeking scholarships for college</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> College Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Undergraduate pursuing bachelor's degree</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Graduate Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Masters, PhD, or professional degree program (medical, law, business school)</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Homeschool Family</div>
              <p className="text-xs italic text-slate-600 ml-7">Homeschooling family seeking educational support</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Individual Seeking Assistance</div>
              <p className="text-xs italic text-slate-600 ml-7">Person needing financial assistance, housing, food, utilities, or emergency help</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Medical/Healthcare Assistance</div>
              <p className="text-xs italic text-slate-600 ml-7">Needing help with medical bills, treatment costs, medications, or healthcare access</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Family/Household</div>
              <p className="text-xs italic text-slate-600 ml-7">Family seeking assistance with childcare, housing, or household needs</p>
            </div>
            <div><span className="form-box"></span> Other: <span className="inline-entry" style={{ width: '200px' }}></span></div>
          </div>
          <p className="text-xs mt-2" style={{ marginLeft: '16px' }}>
            Note: You may fit multiple categories. Choose the one that best describes your PRIMARY reason for seeking funding. 
            Additional qualifications (medical needs, family situation, demographics, etc.) will be captured in Sections 5-14.
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
            <span className="inline-entry" style={{ width: '150px', marginLeft: '8px' }}></span>
            <span style={{ marginLeft: '16px' }}><strong>Age:</strong> <span className="inline-entry" style={{ width: '50px', marginLeft: '8px' }}></span></span>
          </div>
          <div className="mb-2">
            <strong>Social Security Number (if applicable):</strong>
            <span className="inline-entry" style={{ width: '150px', marginLeft: '8px' }}></span>
          </div>
          <div className="mb-2">
            <strong>Green Card Number (if applicable):</strong>
            <span className="inline-entry" style={{ width: '200px', marginLeft: '8px' }}></span>
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
            <span className="inline-entry" style={{ width: '200px', marginLeft: '8px' }}></span>
            <span style={{ marginLeft: '24px' }}><strong>State:</strong> <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span></span>
            <span style={{ marginLeft: '24px' }}><strong>ZIP:</strong> <span className="inline-entry" style={{ width: '100px', marginLeft: '8px' }}></span></span>
          </div>
        </div>

        <div className="form-section">
          <h2>4. ORGANIZATION DETAILS (Organizations Only)</h2>
          <div className="mb-2">
            <strong>EIN (Tax ID):</strong>
            <span className="inline-entry" style={{ width: '150px', marginLeft: '8px' }}></span>
            <span style={{ marginLeft: '16px' }}><strong>UEI:</strong> <span className="inline-entry" style={{ width: '150px', marginLeft: '8px' }}></span></span>
            <span style={{ marginLeft: '16px' }}><strong>CAGE Code:</strong> <span className="inline-entry" style={{ width: '100px', marginLeft: '8px' }}></span></span>
          </div>
          <p className="text-xs italic text-slate-600 ml-4 mb-2">UEI replaces DUNS. CAGE Code required for DoD/FEMA/federal contractor grants.</p>
          
          <div className="mb-2">
            <strong>Organization Type:</strong>
            <div className="form-line"></div>
          </div>
          <div className="mb-2">
            <strong>Annual Budget:</strong> $<span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span>
            <span style={{ marginLeft: '24px' }}><strong>Staff Count:</strong> <span className="inline-entry" style={{ width: '50px', marginLeft: '8px' }}></span></span>
          </div>
          
          <h3 className="mt-3">Federal Registration & Compliance:</h3>
          <div className="ml-4 mt-2">
            <div className="mb-1">
              <div><span className="form-box"></span> SAM.gov Registered</div>
              <p className="text-xs italic text-slate-600 ml-7">System for Award Management - required for federal grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Grants.gov Account Active</div>
              <p className="text-xs italic text-slate-600 ml-7">Increases eligibility surface for federal opportunities</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> eRA Commons Account (NIH/health research)</div>
              <p className="text-xs italic text-slate-600 ml-7">Required for NIH and many health research grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> State Vendor Registration</div>
              <p className="text-xs italic text-slate-600 ml-7">Registered on state's supplier/vendor portal</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Charitable Solicitation Registration</div>
              <p className="text-xs italic text-slate-600 ml-7">Registered to solicit donations in your state(s)</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> SAM Exclusions Check Passed</div>
              <p className="text-xs italic text-slate-600 ml-7">Not debarred or excluded from federal contracts/grants</p>
            </div>
          </div>

          <h3 className="mt-3">Financial & Audit Status:</h3>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> Audited Financials Available</div>
              <p className="text-xs italic text-slate-600 ml-7">Has independent financial audit</p>
            </div>
            <div className="mb-2">
              <strong>Single Audit (2 CFR 200) - Most Recent Year:</strong>
              <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
              <p className="text-xs italic text-slate-600 ml-4">Required if federal funding exceeds $750,000/year</p>
            </div>
            <div className="mb-2">
              <div><span className="form-box"></span> NICRA (Federally Negotiated Indirect Cost Rate)</div>
              <div className="ml-8">
                Rate: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span>%
              </div>
              <p className="text-xs italic text-slate-600 ml-7">Allows you to charge indirect costs on federal grants</p>
            </div>
          </div>

          <h3 className="mt-3">General Qualifications:</h3>
          <div className="ml-4 mt-2">
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
            
            <div className="mb-2">
              <strong>NTEE Code (Nonprofits):</strong>
              <span className="inline-entry" style={{ width: '100px', marginLeft: '8px' }}></span>
              <p className="text-xs italic text-slate-600 ml-4">National Taxonomy of Exempt Entities - improves foundation matching</p>
            </div>
            <div className="mb-2">
              <strong>Evidence-Based Program Model:</strong>
              <span className="inline-entry" style={{ width: '250px', marginLeft: '8px' }}></span>
              <p className="text-xs italic text-slate-600 ml-4">e.g., "Home Visiting—NFP," "Cognitive-Behavioral—MRT" - many grants require tiered evidence</p>
            </div>
            
            <div className="mb-1">
              <div><span className="form-box"></span> Data Protections: HIPAA Compliant</div>
              <p className="text-xs italic text-slate-600 ml-7">HIPAA compliance - opens health/medical grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Data Protections: FERPA Compliant</div>
              <p className="text-xs italic text-slate-600 ml-7">FERPA compliance - required for education grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Data Protections: 42 CFR Part 2 Compliant</div>
              <p className="text-xs italic text-slate-600 ml-7">Substance abuse treatment confidentiality compliance</p>
            </div>
          </div>

          <h3 className="mt-3">Partnerships & MOUs:</h3>
          <div className="ml-4 mb-2">
            <strong>Existing MOUs/LOIs with (check all):</strong>
            <div className="ml-4 mt-1">
              <div><span className="form-box"></span> Schools/School Districts</div>
              <div><span className="form-box"></span> Hospitals/Health Systems</div>
              <div><span className="form-box"></span> Universities/Colleges</div>
              <div><span className="form-box"></span> Tribal Governments</div>
              <div><span className="form-box"></span> Other: <span className="inline-entry" style={{ width: '200px', marginLeft: '4px' }}></span></div>
            </div>
            <p className="text-xs italic text-slate-600 ml-4 mt-1">
              Memoranda of Understanding (MOUs) or Letters of Intent (LOIs) with partner organizations demonstrate collaborative capacity and institutional support. 
              These partnership assets significantly strengthen grant proposals by showing established relationships and shared commitment, 
              often earning extra points in competitive scoring and satisfying partnership requirements common in federal, foundation, and collaborative grants.
            </p>
          </div>

          <h3 className="mt-3">Insurance & Risk Management:</h3>
          <div className="ml-4">
            <div className="mb-2">
              <strong>General Liability Coverage Limits:</strong> $<span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span>
              <p className="text-xs italic text-slate-600 ml-4">Many grants require minimum $1M coverage</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Workers' Compensation Insurance</div>
              <p className="text-xs italic text-slate-600 ml-7">Often required for grants with employees</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Cyber Insurance</div>
              <p className="text-xs italic text-slate-600 ml-7">Increasingly required for data-sensitive grants</p>
            </div>
          </div>

          <h3 className="mt-3">Specialized Organization Types:</h3>
          <div className="ml-4">
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> School District / Charter School</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> Title I School/District</div>
                <div className="ml-4">
                  Free/Reduced Lunch %: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span>%
                </div>
                <div className="mt-1"><span className="form-box"></span> Comprehensive Support & Improvement (CSI/TSI) Designation</div>
                <div className="mt-1"><span className="form-box"></span> CTE (Career & Technical Education) Pathways Offered</div>
                <div className="mt-1"><span className="form-box"></span> Perkins V Ready</div>
                <div className="mt-1"><span className="form-box"></span> School Safety Team & SRO MOU</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Schools serving low-income students - extensive federal and foundation support available</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> University / College</div>
              <div className="ml-8 mt-1">
                <div>Carnegie Classification: <span className="inline-entry" style={{ width: '200px', marginLeft: '4px' }}></span></div>
                <div className="mt-1">Research Expenditures (HERD band): $<span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span></div>
                <div className="mt-1">IRB/FWA Number: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span></div>
                <div className="mt-1"><span className="form-box"></span> Tech Transfer Office</div>
                <div className="mt-1"><span className="form-box"></span> SBIR/STTR Partner Experience</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Higher education institution - research grants, Title III/V support available</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Hospital / Clinic / FQHC</div>
              <div className="ml-8 mt-1">
                <div>HPSA Score: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span></div>
                <div className="mt-1"><span className="form-box"></span> UDS (Uniform Data System) Reporter</div>
                <p className="text-xs italic text-slate-600 ml-7">Reports data to HRSA - required for health centers receiving federal grants</p>
                <div className="mt-1"><span className="form-box"></span> 340B Drug Pricing Program Participation</div>
                <p className="text-xs italic text-slate-600 ml-7">Qualified to purchase discounted outpatient drugs - enhances sustainability</p>
                <div className="mt-1"><span className="form-box"></span> Joint Commission Accreditation</div>
                <p className="text-xs italic text-slate-600 ml-7">Gold standard hospital/healthcare accreditation - demonstrates quality standards</p>
                <div className="mt-1"><span className="form-box"></span> NCQA PCMH (Patient-Centered Medical Home)</div>
                <p className="text-xs italic text-slate-600 ml-7">National Committee for Quality Assurance recognition for coordinated primary care</p>
                <div className="mt-1"><span className="form-box"></span> CARF Accreditation (Behavioral Health)</div>
                <p className="text-xs italic text-slate-600 ml-7">Commission on Accreditation of Rehabilitation Facilities - for behavioral health services</p>
                <div className="mt-1"><span className="form-box"></span> Telehealth Capacity</div>
                <p className="text-xs italic text-slate-600 ml-7">Can deliver remote healthcare services - increasingly required for rural health grants</p>
                <div className="mt-1">EHR Vendor: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span></div>
                <p className="text-xs italic text-slate-600 ml-4">Electronic Health Records system - Epic, Cerner, Athena, etc.</p>
                <div className="mt-1"><span className="form-box"></span> HIE (Health Information Exchange) Participation</div>
                <p className="text-xs italic text-slate-600 ml-7">Shares patient data with regional health information network</p>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">FQHC = Federally Qualified Health Center - extensive HRSA and federal health funding</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Tribal Government / Tribally Controlled Organization</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> PL 93-638 Compacting (Self-Governance)</div>
                <p className="text-xs italic text-slate-600 ml-7">Self-governance compact with IHS or BIA - demonstrates tribal management capacity</p>
                <div className="mt-1">IHS Service Unit: <span className="inline-entry" style={{ width: '200px', marginLeft: '4px' }}></span></div>
                <p className="text-xs italic text-slate-600 ml-4">Indian Health Service geographic service area - identifies service region</p>
                <div className="mt-1"><span className="form-box"></span> ICDBG/NAHASDA Experience</div>
                <p className="text-xs italic text-slate-600 ml-7">Indian Community Development Block Grant or Native American Housing - HUD tribal programs</p>
                <div className="mt-1"><span className="form-box"></span> BIA/BIE Relationships</div>
                <p className="text-xs italic text-slate-600 ml-7">Works with Bureau of Indian Affairs or Bureau of Indian Education</p>
                <div className="mt-1"><span className="form-box"></span> Tribal Resolution Process</div>
                <p className="text-xs italic text-slate-600 ml-7">Tribal council approval process for grants - required for most tribal applications</p>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Federally recognized tribe - access to Indian Affairs, IHS, and tribal-specific programs</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Community Action Agency (CAA)</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> CSBG Eligible Entity Status</div>
                <p className="text-xs italic text-slate-600 ml-7">Community Services Block Grant designated entity - qualifies for federal anti-poverty funding</p>
                <div className="mt-1"><span className="form-box"></span> ROMA Outcomes System</div>
                <p className="text-xs italic text-slate-600 ml-7">Results Oriented Management and Accountability - performance measurement for CAAs</p>
                <div className="mt-1"><span className="form-box"></span> Weatherization Assistance Program (WAP) Participation</div>
                <p className="text-xs italic text-slate-600 ml-7">Provides energy efficiency improvements for low-income homes - DOE funded</p>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Federally designated anti-poverty organization - Community Services Block Grant funding</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Community Development Corporation (CDC)</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> HUD CHDO Status</div>
                <div className="mt-1"><span className="form-box"></span> LIHTC Development History</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Nonprofit focused on community revitalization - HUD and economic development grants</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Housing Authority</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> MTW (Moving to Work) Status</div>
                <div className="mt-1"><span className="form-box"></span> RAD (Rental Assistance Demonstration) Experience</div>
                <div className="mt-1"><span className="form-box"></span> FSS and HCV Metrics</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Public or tribal housing agency - HUD capital and operating grants</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Workforce Development Board</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> WIOA Performance Metrics</div>
                <div className="mt-1"><span className="form-box"></span> ETPL (Eligible Training Provider List) Role</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Local workforce investment board - WIOA formula and competitive grants</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Veterans Service Organization</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> VA SSVF/GPD Experience</div>
                <div className="mt-1"><span className="form-box"></span> VSO Accreditation</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Organization serving veterans - VA grants and veteran assistance programs</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Volunteer Fire/EMS</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> NFPA Compliance</div>
                <div className="mt-1">ISO Rating: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span></div>
                <div className="mt-1"><span className="form-box"></span> AFG/SAFER Grant History</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Volunteer fire/emergency services - FEMA AFG and SAFER grants for equipment/staffing</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Research Institute / Lab</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> IACUC/IBC Approvals (Animal Care, Biosafety)</div>
                <div className="mt-1"><span className="form-box"></span> Data Use Agreements Capacity</div>
                <div className="mt-1">Prior Grant Numbers: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span></div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Academic or independent research facility - NIH, NSF, and research foundation grants</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Cooperative (Ag/Electric/Housing/Worker)</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> REAP/USDA Experience</div>
                <div className="mt-1">Member Count: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span></div>
                <div className="mt-1">Service Territory: <span className="inline-entry" style={{ width: '200px', marginLeft: '4px' }}></span></div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Member-owned cooperative - USDA rural development and cooperative grants</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> CDFI Partner</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> CDFI Certified (or Applicant)</div>
                <div className="mt-1">Target Market: <span className="inline-entry" style={{ width: '200px', marginLeft: '4px' }}></span></div>
                <div className="mt-1">Deployment Ratio: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span>%</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Community Development Financial Institution - Treasury CDFI Fund awards</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> MSI/HBCU/HSI/TCU (Minority-Serving Institution)</div>
              <div className="ml-8 mt-1">
                <div>Official Designation Year: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span></div>
                <div className="mt-1"><span className="form-box"></span> Student Percentage Thresholds Met</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Historically Black College / Hispanic-Serving / Tribal College - Title III/V funding</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Rural Health Clinic (RHC)</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> CMS Certified Rural Health Clinic</div>
                <div className="mt-1"><span className="form-box"></span> Cost-Based Reimbursement Status</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Medicare-certified rural primary care facility - HRSA rural health grants</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Environmental/Conservation Organization</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> Land Trust Accreditation</div>
                <div className="mt-1">Stewardship Acres: <span className="inline-entry" style={{ width: '100px', marginLeft: '4px' }}></span></div>
                <div className="mt-1"><span className="form-box"></span> NEPA Readiness</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Environmental protection or conservation - EPA, NOAA, and conservation foundation grants</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Labor Union Organization</div>
              <div className="ml-8 mt-1">
                <div>Registered Apprenticeship Program #: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span></div>
                <div className="mt-1"><span className="form-box"></span> Labor-Management Taft-Hartley Training Funds</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Labor union - apprenticeship grants and workforce development funding</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Agricultural Extension Partner</div>
              <div className="ml-8 mt-1">
                <div><span className="form-box"></span> Smith-Lever Projects</div>
                <div className="mt-1"><span className="form-box"></span> County Extension MOU</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Partner with USDA Cooperative Extension - agricultural research and outreach funding</p>
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
            <div className="mb-1">
              <div><span className="form-box"></span> Minority-Owned Business</div>
              <p className="text-xs italic text-slate-600 ml-7">Business owned by racial/ethnic minority - eligible for minority business development grants and contracts</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Women-Owned Business</div>
              <p className="text-xs italic text-slate-600 ml-7">Business owned by women - access to women's business grants, SBA programs, and corporate supplier diversity initiatives</p>
            </div>
            
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> SBIR/STTR Eligible</div>
              <div className="ml-8">
                Employee Count: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Small Business Innovation Research - ≤500 employees, for-profit, U.S.-owned</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> CMMC / NIST 800-171 Posture</div>
              <p className="text-xs italic text-slate-600 ml-7">Cybersecurity maturity for DoD contracts and grants</p>
            </div>
            <div className="mb-2">
              <div><span className="form-box"></span> ISO Certifications</div>
              <div className="ml-8">
                <div><span className="form-box"></span> ISO 9001 (Quality Management)</div>
                <div><span className="form-box"></span> ISO 14001 (Environmental)</div>
                <div><span className="form-box"></span> ISO 27001 (Information Security)</div>
              </div>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Energy Star / Green Certifications</div>
              <p className="text-xs italic text-slate-600 ml-7">Opens sustainability and energy efficiency funding</p>
            </div>
            <div className="mb-2">
              <div>Primary NAICS Code(s): <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span></div>
              <p className="text-xs italic text-slate-600 ml-4">Industry classification codes - used for targeted industry grants</p>
            </div>
            <div className="mb-2">
              <div>SBA Size Standard Status: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span></div>
              <p className="text-xs italic text-slate-600 ml-4">Determines small business status for federal contracts</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Export-Ready (EXIM / SBA STEP)</div>
              <p className="text-xs italic text-slate-600 ml-7">International trade readiness - export assistance grants available</p>
            </div>
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
            
            <div className="mb-1">
              <div><span className="form-box"></span> Promise Zone Boundaries</div>
              <p className="text-xs italic text-slate-600 ml-7">HUD high-poverty community designation - priority points for federal grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Choice Neighborhood</div>
              <p className="text-xs italic text-slate-600 ml-7">HUD neighborhood transformation initiative area</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Delta Regional Authority Region</div>
              <p className="text-xs italic text-slate-600 ml-7">Delta states economic development region</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Northern Border Commission Region</div>
              <p className="text-xs italic text-slate-600 ml-7">Maine, New Hampshire, Vermont, New York economic development</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Denali Commission Region</div>
              <p className="text-xs italic text-slate-600 ml-7">Alaska economic development and infrastructure</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Colonias Designation</div>
              <p className="text-xs italic text-slate-600 ml-7">Border communities - Texas, New Mexico, Arizona, California - special assistance programs</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> New Markets Tax Credit (NMTC) Eligible Tract</div>
              <p className="text-xs italic text-slate-600 ml-7">Low-income community investment area</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Brownfield Site Status</div>
              <p className="text-xs italic text-slate-600 ml-7">EPA brownfields cleanup and redevelopment grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Broadband-Unserved (FCC Map Block)</div>
              <p className="text-xs italic text-slate-600 ml-7">No high-speed internet access - USDA ReConnect and NTIA grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Wildland-Urban Interface (WUI) Fire Risk</div>
              <p className="text-xs italic text-slate-600 ml-7">High wildfire risk area - FEMA and forestry grants for mitigation</p>
            </div>
            <div className="mb-2">
              <div><span className="form-box"></span> Floodplain Location</div>
              <div className="ml-8">
                CRS Score: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7">Flood hazard area - FEMA mitigation and buyout programs</p>
            </div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>5. EDUCATION INFORMATION (Students Only)</h2>
          <p className="mb-2">Check all grade levels that apply:</p>
          <div className="ml-4 mb-2">
            <div className="mb-1">
              <div><span className="form-box"></span> High School Freshman</div>
              <p className="text-xs italic text-slate-600 ml-7">9th grade - many scholarships available for high school students planning for college</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> High School Sophomore</div>
              <p className="text-xs italic text-slate-600 ml-7">10th grade - eligible for early planning scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> High School Junior</div>
              <p className="text-xs italic text-slate-600 ml-7">11th grade - prime time to apply for college scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> High School Senior</div>
              <p className="text-xs italic text-slate-600 ml-7">12th grade - most scholarships are for graduating seniors</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> College Freshman</div>
              <p className="text-xs italic text-slate-600 ml-7">First year undergraduate</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> College Sophomore</div>
              <p className="text-xs italic text-slate-600 ml-7">Second year undergraduate</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> College Junior</div>
              <p className="text-xs italic text-slate-600 ml-7">Third year undergraduate</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> College Senior</div>
              <p className="text-xs italic text-slate-600 ml-7">Fourth year undergraduate, graduating soon</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Graduate Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Masters, PhD, or professional degree program</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> GED Graduate</div>
              <p className="text-xs italic text-slate-600 ml-7">General Education Development certificate holder - eligible for many scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Returning Adult Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Non-traditional student returning to education - special scholarships available</p>
            </div>
          </div>

          <h3 className="mt-3">Education Type & Setting:</h3>
          <div className="ml-4 mb-2">
            <div className="mb-1">
              <div><span className="form-box"></span> Homeschool Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Educated at home - many scholarships specifically for homeschoolers</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Private School Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Attending private or independent school</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Charter or Micro-School Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Charter school or micro-school participant</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Virtual Academy Participant</div>
              <p className="text-xs italic text-slate-600 ml-7">Online or virtual school student</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Parent-Led Education</div>
              <p className="text-xs italic text-slate-600 ml-7">Parent-directed learning approach</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Homeschool Co-op Member</div>
              <p className="text-xs italic text-slate-600 ml-7">Part of homeschool cooperative group</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> ESA (Education Savings Account) Eligible</div>
              <p className="text-xs italic text-slate-600 ml-7">State-funded account for educational expenses</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Education Choice/Parental Choice Participant</div>
              <p className="text-xs italic text-slate-600 ml-7">Using school choice vouchers or tax credit scholarships</p>
            </div>
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
            <strong>Planned Enrollment Term:</strong>
            <span style={{ marginLeft: '8px' }}>
              <span className="form-box"></span> Fall
              <span className="form-box" style={{ marginLeft: '16px' }}></span> Spring
              <span className="form-box" style={{ marginLeft: '16px' }}></span> Summer
            </span>
            <span style={{ marginLeft: '24px' }}><strong>Year:</strong> <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span></span>
            <p className="text-xs italic text-slate-600 ml-4">When do you plan to start college? This determines which application deadlines apply to you.</p>
          </div>
          <div className="mb-2">
            <strong>GPA:</strong>
            <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
          </div>
          
          <h3 className="mt-3">Standardized Test Scores (if applicable):</h3>
          <div className="ml-4 mb-2">
            <div className="mb-2">
              <strong>ACT:</strong>
              <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
              <span className="text-xs text-slate-500 ml-2">(Composite score 1-36)</span>
              <p className="text-xs italic text-slate-600 ml-4">Many scholarships have minimum ACT requirements (typically 21-30)</p>
            </div>
            <div className="mb-2">
              <strong>SAT:</strong>
              <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
              <span className="text-xs text-slate-500 ml-2">(Total score 400-1600)</span>
              <p className="text-xs italic text-slate-600 ml-4">Competitive scholarships often require 1200+ (merit-based)</p>
            </div>
            <div className="mb-2">
              <strong>GRE:</strong>
              <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
              <span className="text-xs text-slate-500 ml-2">(Total score 260-340, for graduate school)</span>
              <p className="text-xs italic text-slate-600 ml-4">Required for many graduate fellowships and assistantships</p>
            </div>
            <div className="mb-2">
              <strong>GMAT:</strong>
              <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
              <span className="text-xs text-slate-500 ml-2">(Total score 200-800, for business school)</span>
              <p className="text-xs italic text-slate-600 ml-4">MBA scholarships often require 550+ score</p>
            </div>
            <div className="mb-2">
              <strong>LSAT:</strong>
              <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
              <span className="text-xs text-slate-500 ml-2">(Score 120-180, for law school)</span>
              <p className="text-xs italic text-slate-600 ml-4">Law school merit scholarships based on LSAT performance</p>
            </div>
            <div className="mb-2">
              <strong>MCAT:</strong>
              <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
              <span className="text-xs text-slate-500 ml-2">(Total score 472-528, for medical school)</span>
              <p className="text-xs italic text-slate-600 ml-4">Medical school scholarships for high-achieving students</p>
            </div>
            <div className="mb-2">
              <strong>Community Service Hours:</strong>
              <span className="inline-entry" style={{ width: '80px', marginLeft: '8px' }}></span>
              <p className="text-xs italic text-slate-600 ml-4">Many scholarships require or reward community service (50-200+ hours)</p>
            </div>
          </div>
          
          <h3 className="mt-3">Advanced Student Qualifiers:</h3>
          <div className="ml-4 mb-2">
            <div className="mb-1">
              <div><span className="form-box"></span> Attends Title I School</div>
              <p className="text-xs italic text-slate-600 ml-7">School serving low-income students - opens access to equity scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> IEP/504 Status</div>
              <p className="text-xs italic text-slate-600 ml-7">Has disability accommodations plan - scholarships for students with disabilities</p>
            </div>
            <div className="mb-2">
              <div>IDEA Disability Category: <span className="inline-entry" style={{ width: '200px', marginLeft: '4px' }}></span></div>
              <p className="text-xs italic text-slate-600 ml-4">Specific learning disability, autism, etc. - specialized support available</p>
            </div>
            <div className="mb-2">
              <div>CTE Pathway: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span></div>
              <p className="text-xs italic text-slate-600 ml-4">Career/Technical Education (EMT, welding, cybersecurity, nursing, etc.) - industry scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Dual Enrollment / Early College Participation</div>
              <p className="text-xs italic text-slate-600 ml-7">Taking college courses in high school - recognition scholarships available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> ROTC / JROTC Participation</div>
              <p className="text-xs italic text-slate-600 ml-7">Military training program - ROTC scholarships and military academy nominations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Civil Air Patrol Involvement</div>
              <p className="text-xs italic text-slate-600 ml-7">CAP cadets - aerospace and STEM scholarships</p>
            </div>
            <div className="mb-2">
              <div>Honor Societies: <span className="inline-entry" style={{ width: '300px', marginLeft: '4px' }}></span></div>
              <p className="text-xs italic text-slate-600 ml-4">NHS, Phi Theta Kappa, etc. - society-specific scholarships available</p>
            </div>
            <div className="mb-2">
              <div>Competitions/Awards: <span className="inline-entry" style={{ width: '300px', marginLeft: '4px' }}></span></div>
              <p className="text-xs italic text-slate-600 ml-4">Science Olympiad, HOSA, SkillsUSA, DECA, etc. - competition-based scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Work-Study Eligible</div>
              <p className="text-xs italic text-slate-600 ml-7">Federal work-study qualification - part of financial aid package</p>
            </div>
            <div className="mb-2">
              <div>EFC/SAI Band: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span></div>
              <p className="text-xs italic text-slate-600 ml-4">Expected Family Contribution / Student Aid Index - determines need-based aid</p>
            </div>
            <div className="mb-2">
              <strong>Student Housing Status:</strong>
              <div className="ml-4">
                <div><span className="form-box"></span> On-Campus Housing</div>
                <div><span className="form-box"></span> Off-Campus Housing</div>
                <div><span className="form-box"></span> Commuter Student</div>
                <div><span className="form-box"></span> Independent (Living Alone)</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-4">Housing status affects cost of attendance and aid eligibility</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Faith-Based College Attendance</div>
              <p className="text-xs italic text-slate-600 ml-7">Attending religious college - denominational scholarships available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Athletics Commitment</div>
              <p className="text-xs italic text-slate-600 ml-7">Student athlete - athletic scholarships and sports foundation awards</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Arts Commitment</div>
              <p className="text-xs italic text-slate-600 ml-7">Music, theater, visual arts - performing/fine arts scholarships</p>
            </div>
          </div>
          
          <h3 className="mt-3">Academic Characteristics:</h3>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> First-Generation College Student</div>
              <p className="text-xs italic text-slate-600 ml-7">First in your family to attend college - many scholarships specifically for this</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> STEM Student</div>
              <p className="text-xs italic text-slate-600 ml-7">Science, Technology, Engineering, or Math major - high-demand fields with many scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Arts/Humanities Field</div>
              <p className="text-xs italic text-slate-600 ml-7">Art, music, literature, history, philosophy - creative and cultural studies</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Medical/Nursing/Allied Health Field</div>
              <p className="text-xs italic text-slate-600 ml-7">Healthcare professions - critical need areas with funding support</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Education/Social Work Field</div>
              <p className="text-xs italic text-slate-600 ml-7">Teaching or social services - public service career paths with loan forgiveness options</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Trade/Apprenticeship Participant</div>
              <p className="text-xs italic text-slate-600 ml-7">Learning skilled trades - vocational programs with industry sponsorship</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Recent Graduate</div>
              <p className="text-xs italic text-slate-600 ml-7">Recently completed degree - eligible for continuing education grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Student with Dependent Children</div>
              <p className="text-xs italic text-slate-600 ml-7">Parenting while in school - special support available</p>
            </div>
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
            <strong>Annual Household Income:</strong> $<span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span>
          </div>
          <div className="mb-2">
            <strong>Household Size:</strong>
            <span className="inline-entry" style={{ width: '50px', marginLeft: '8px' }}></span> people
          </div>

          <h3 className="mt-3">Financial Challenges:</h3>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> Low Income</div>
              <p className="text-xs italic text-slate-600 ml-7">Generally defined as income at or below 200% of federal poverty level (varies by household size)</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Unemployed</div>
              <p className="text-xs italic text-slate-600 ml-7">Currently without employment - emergency assistance available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Underemployed</div>
              <p className="text-xs italic text-slate-600 ml-7">Working part-time or below skill level - job training programs available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Displaced Worker</div>
              <p className="text-xs italic text-slate-600 ml-7">Lost job due to plant closure, layoff, or economic changes - retraining grants available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Disabled</div>
              <p className="text-xs italic text-slate-600 ml-7">Physical, mental, or developmental disability affecting employment</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Job Retraining Participant</div>
              <p className="text-xs italic text-slate-600 ml-7">Currently in workforce development or skills training program</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Uninsured / Underinsured</div>
              <p className="text-xs italic text-slate-600 ml-7">Lacking adequate health insurance coverage - medical assistance programs available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Medical Debt</div>
              <p className="text-xs italic text-slate-600 ml-7">Outstanding medical bills - debt relief programs available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Education Debt</div>
              <p className="text-xs italic text-slate-600 ml-7">Student loan burden - loan forgiveness programs available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Bankruptcy / Foreclosure</div>
              <p className="text-xs italic text-slate-600 ml-7">Recent financial crisis - recovery assistance available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> First-Time Homebuyer</div>
              <p className="text-xs italic text-slate-600 ml-7">Seeking to purchase first home - down payment assistance programs available</p>
            </div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>7. GOVERNMENT ASSISTANCE PROGRAMS</h2>
          <p className="mb-2">Check all programs you currently receive:</p>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> Medicaid</div>
              <p className="text-xs italic text-slate-600 ml-7">State health insurance for low-income individuals/families - opens eligibility for many medical assistance programs</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Medicare</div>
              <p className="text-xs italic text-slate-600 ml-7">Federal health insurance for seniors 65+ and disabled individuals - qualifies for supplemental assistance programs</p>
            </div>
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
            <div className="mb-1">
              <div><span className="form-box"></span> WIC</div>
              <p className="text-xs italic text-slate-600 ml-7">Women, Infants, and Children nutrition program</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> CHIP</div>
              <p className="text-xs italic text-slate-600 ml-7">Children's Health Insurance Program - low-cost health coverage for children</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Head Start / Early Head Start</div>
              <p className="text-xs italic text-slate-600 ml-7">Early childhood education program for low-income families</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Section 8 Housing</div>
              <p className="text-xs italic text-slate-600 ml-7">Housing Choice Voucher program - rental assistance for low-income families, elderly, and disabled persons</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Public Housing Resident</div>
              <p className="text-xs italic text-slate-600 ml-7">Living in public housing development - qualifies for resident services and educational programs</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> LIHEAP</div>
              <p className="text-xs italic text-slate-600 ml-7">Low Income Home Energy Assistance Program - help with heating/cooling bills</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Lifeline / ACP (Broadband Assistance)</div>
              <p className="text-xs italic text-slate-600 ml-7">Affordable Connectivity Program - discounted internet service</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> WIOA Services</div>
              <p className="text-xs italic text-slate-600 ml-7">Workforce Innovation and Opportunity Act - job training and placement</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Vocational Rehabilitation (VR)</div>
              <p className="text-xs italic text-slate-600 ml-7">Employment services for people with disabilities</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> EITC Eligible</div>
              <p className="text-xs italic text-slate-600 ml-7">Earned Income Tax Credit eligible - working low-income families</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Ryan White HIV/AIDS Program</div>
              <p className="text-xs italic text-slate-600 ml-7">HIV/AIDS treatment and care assistance</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Veterans Benefits (Post-9/11 GI Bill)</div>
              <p className="text-xs italic text-slate-600 ml-7">Education benefits for recent veterans</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> VR&E (Veteran Readiness & Employment)</div>
              <p className="text-xs italic text-slate-600 ml-7">Vocational rehabilitation for service-connected disabled veterans</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> CHAMPVA</div>
              <p className="text-xs italic text-slate-600 ml-7">Health care for dependents of disabled/deceased veterans</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Medicaid Number (if applicable):</div>
              <p className="text-xs italic text-slate-600 ml-7">Please provide your Medicaid number for verification purposes</p>
            </div>
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
              <div className="mb-1">
                <div><span className="form-box"></span> Self-Determination</div>
                <p className="text-xs italic text-slate-600 ml-7">Person-centered Medicaid waiver allowing individuals with disabilities to direct their own services and supports</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Family Support</div>
                <p className="text-xs italic text-slate-600 ml-7">Medicaid waiver providing flexible support services to keep individuals with disabilities living at home with family</p>
              </div>
              <div><span className="form-box"></span> Other: <span className="inline-entry" style={{ width: '200px', marginLeft: '4px' }}></span></div>
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
                Type: <span className="inline-entry" style={{ width: '180px', marginLeft: '4px' }}></span>
                <span style={{ marginLeft: '16px' }}>Year: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7">Diagnosed with cancer - many support organizations offer financial assistance</p>
            </div>
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Chronic Illness</div>
              <div className="ml-8">
                Type: <span className="inline-entry" style={{ width: '300px', marginLeft: '4px' }}></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7">Long-term health condition requiring ongoing treatment</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Dialysis Patient</div>
              <p className="text-xs italic text-slate-600 ml-7">Receiving kidney dialysis treatment - assistance for treatment costs available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Organ Transplant Recipient</div>
              <p className="text-xs italic text-slate-600 ml-7">Received organ transplant - medication and care assistance available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> HIV/AIDS</div>
              <p className="text-xs italic text-slate-600 ml-7">Living with HIV or AIDS - medication assistance and support services available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Long COVID</div>
              <p className="text-xs italic text-slate-600 ml-7">Persistent symptoms after COVID-19 infection</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Traumatic Brain Injury (TBI)</div>
              <p className="text-xs italic text-slate-600 ml-7">Brain injury from trauma - rehabilitation support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Amputee</div>
              <p className="text-xs italic text-slate-600 ml-7">Missing limb - prosthetics and adaptive equipment funding available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Neurodivergent (Autism, ADHD, etc.)</div>
              <p className="text-xs italic text-slate-600 ml-7">Autism, ADHD, dyslexia, or other neurological differences - accommodations and support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Visual Impairment</div>
              <p className="text-xs italic text-slate-600 ml-7">Blind or low vision - assistive technology and scholarship support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Hearing Impairment</div>
              <p className="text-xs italic text-slate-600 ml-7">Deaf or hard of hearing - assistive devices and educational support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Wheelchair User</div>
              <p className="text-xs italic text-slate-600 ml-7">Uses wheelchair for mobility - accessibility equipment funding available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Substance Recovery Participant</div>
              <p className="text-xs italic text-slate-600 ml-7">In recovery from addiction - treatment and reintegration support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Mental Health Condition (PTSD, Depression, etc.)</div>
              <p className="text-xs italic text-slate-600 ml-7">Mental health diagnosis - treatment assistance and support services available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Maternal/Prenatal/Perinatal Health Needs</div>
              <p className="text-xs italic text-slate-600 ml-7">Pregnancy-related health needs - maternal health programs available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Hospice / Palliative Care</div>
              <p className="text-xs italic text-slate-600 ml-7">End-of-life care - comfort care and family support available</p>
            </div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>9. DEMOGRAPHICS & BACKGROUND</h2>
          <p className="mb-2"><strong>Immigration/Citizenship Status:</strong></p>
          <div className="ml-4 mb-2">
            <div className="mb-1">
              <div><span className="form-box"></span> U.S. Citizen</div>
              <p className="text-xs italic text-slate-600 ml-7">Born in U.S. or naturalized citizen</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Permanent Resident (Green Card)</div>
              <p className="text-xs italic text-slate-600 ml-7">Legal permanent resident with green card</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Refugee</div>
              <p className="text-xs italic text-slate-600 ml-7">Granted refugee status for persecution fears</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Asylee</div>
              <p className="text-xs italic text-slate-600 ml-7">Granted asylum after arriving in U.S.</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> DACA Recipient</div>
              <p className="text-xs italic text-slate-600 ml-7">Deferred Action for Childhood Arrivals program participant</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Visa Holder</div>
              <p className="text-xs italic text-slate-600 ml-7">Temporary visa (student, work, etc.)</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> New Immigrant (within last 5 years)</div>
              <p className="text-xs italic text-slate-600 ml-7">Recently arrived in the United States</p>
            </div>
            <div><span className="form-box"></span> Other</div>
          </div>
          <p className="mb-2"><strong>Race/Ethnicity (Check all that apply):</strong></p>
          <p className="text-xs text-slate-500 mb-2 ml-4">Many scholarships and grants are available for specific ethnic and cultural backgrounds</p>
          <div className="ml-4 mb-2">
            <div className="mb-1">
              <div><span className="form-box"></span> African American / Black</div>
              <p className="text-xs italic text-slate-600 ml-7">Descendants of African diaspora - thousands of scholarships and grants available from HBCUs, foundations, and organizations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Hispanic / Latino</div>
              <p className="text-xs italic text-slate-600 ml-7">Hispanic or Latino heritage - extensive scholarship opportunities from HSIs, Hispanic organizations, and national foundations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Asian American</div>
              <p className="text-xs italic text-slate-600 ml-7">Asian heritage - scholarships from Asian American foundations, professional associations, and cultural organizations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Pacific Islander / Native Hawaiian</div>
              <p className="text-xs italic text-slate-600 ml-7">Native Hawaiian or Pacific Islander heritage - specialized funding from tribal and cultural preservation organizations</p>
            </div>
            <div className="avoid-break mb-1">
              <div><span className="form-box"></span> Native American / Alaska Native</div>
              <div className="ml-8">
                Tribal Affiliation: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7">Enrolled tribal member - extensive federal funding, tribal scholarships, and specialized programs available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Middle Eastern / North African</div>
              <p className="text-xs italic text-slate-600 ml-7">MENA heritage - scholarships from cultural associations and diaspora organizations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> White / Caucasian</div>
              <p className="text-xs italic text-slate-600 ml-7">European heritage - eligible for heritage-specific and general scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Multiracial / Mixed Heritage</div>
              <p className="text-xs italic text-slate-600 ml-7">Multiple racial backgrounds - eligible for scholarships recognizing diversity and mixed heritage</p>
            </div>
          </div>

          <h3 className="mt-3">Cultural/Ethnic Heritage:</h3>
          <p className="text-xs text-slate-500 mb-2 ml-4">Many diaspora organizations offer scholarships and grants</p>
          <div className="ml-4 mb-2">
            <div className="mb-1">
              <div><span className="form-box"></span> Jewish Heritage</div>
              <p className="text-xs italic text-slate-600 ml-7">Jewish ancestry or faith - extensive funding from Jewish federations, synagogues, Hillel, and Israeli programs</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Irish Heritage</div>
              <p className="text-xs italic text-slate-600 ml-7">Irish descent - scholarships from Hibernian societies, Irish cultural organizations, and ancestral associations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Italian Heritage</div>
              <p className="text-xs italic text-slate-600 ml-7">Italian ancestry - funding from Italian-American organizations, Sons of Italy, and cultural societies</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Polish Heritage</div>
              <p className="text-xs italic text-slate-600 ml-7">Polish descent - scholarships from Polish-American clubs, cultural foundations, and heritage organizations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Greek Heritage</div>
              <p className="text-xs italic text-slate-600 ml-7">Greek ancestry - funding from AHEPA, Greek Orthodox churches, and Hellenic societies</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Armenian Heritage</div>
              <p className="text-xs italic text-slate-600 ml-7">Armenian descent - scholarships from Armenian General Benevolent Union and cultural preservation organizations</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Cajun / Creole Heritage</div>
              <p className="text-xs italic text-slate-600 ml-7">Louisiana Cajun or Creole ancestry - regional cultural preservation and heritage scholarships available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Appalachian White</div>
              <p className="text-xs italic text-slate-600 ml-7">Appalachian region heritage - scholarships from Appalachian Regional Commission and local foundations serving mountain communities</p>
            </div>
          </div>
          
          <h3 className="mt-3">Religious Affiliation:</h3>
          <p className="text-xs text-slate-500 mb-2 ml-4">Many religious organizations and denominations offer scholarships and grants to their members or communities</p>
          
          <div className="ml-4 mb-2">
            <p className="font-semibold text-sm mb-1">Christianity:</p>
            <div className="ml-4">
              <div className="mb-1">
                <div><span className="form-box"></span> Christian (General)</div>
                <p className="text-xs italic text-slate-600 ml-7">General Christian faith - eligible for broad Christian scholarships and ministry support</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Catholic</div>
                <p className="text-xs italic text-slate-600 ml-7">Roman Catholic - scholarships from Catholic Charities, Knights of Columbus, dioceses, and Catholic universities</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Protestant</div>
                <p className="text-xs italic text-slate-600 ml-7">Protestant denomination - eligible for mainline Protestant church scholarships and seminary support</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Baptist</div>
                <p className="text-xs italic text-slate-600 ml-7">Baptist church member - funding from Southern Baptist Convention, state conventions, and local Baptist associations</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Methodist</div>
                <p className="text-xs italic text-slate-600 ml-7">United Methodist - scholarships from UMC foundations, annual conferences, and Methodist universities</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Lutheran</div>
                <p className="text-xs italic text-slate-600 ml-7">Lutheran church member - funding from ELCA, LCMS, Lutheran Aid Association, and Lutheran colleges</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Presbyterian</div>
                <p className="text-xs italic text-slate-600 ml-7">Presbyterian church member - scholarships from PC(USA), presbyteries, and Presbyterian colleges</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Pentecostal</div>
                <p className="text-xs italic text-slate-600 ml-7">Pentecostal/Charismatic - funding from Assemblies of God, Church of God, and Pentecostal denominations</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Orthodox Christian</div>
                <p className="text-xs italic text-slate-600 ml-7">Eastern or Oriental Orthodox - scholarships from Orthodox Christian Fellowship and ethnic Orthodox churches</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Latter-day Saints (Mormon)</div>
                <p className="text-xs italic text-slate-600 ml-7">LDS church member - extensive funding from LDS Philanthropies and Church Education System</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Amish</div>
                <p className="text-xs italic text-slate-600 ml-7">Amish community member - specialized grants for healthcare, emergency assistance, and community needs</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Mennonite</div>
                <p className="text-xs italic text-slate-600 ml-7">Mennonite church member - funding from Mennonite Central Committee, conferences, and Mennonite colleges</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Quaker (Society of Friends)</div>
                <p className="text-xs italic text-slate-600 ml-7">Quaker meeting member - scholarships from Friends General Conference and Quaker colleges</p>
              </div>
            </div>
          </div>

          <div className="ml-4 mb-2">
            <p className="font-semibold text-sm mb-1">Judaism:</p>
            <div className="ml-4">
              <div className="mb-1">
                <div><span className="form-box"></span> Jewish (General)</div>
                <p className="text-xs italic text-slate-600 ml-7">Jewish faith - extensive scholarships from Jewish federations, synagogues, Hillel, and Israeli programs</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Reform Jewish</div>
                <p className="text-xs italic text-slate-600 ml-7">Reform Judaism - funding from Union for Reform Judaism and Reform congregations</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Conservative Jewish</div>
                <p className="text-xs italic text-slate-600 ml-7">Conservative Judaism - scholarships from United Synagogue and Conservative movement institutions</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Orthodox Jewish</div>
                <p className="text-xs italic text-slate-600 ml-7">Orthodox Judaism - funding from Orthodox Union, yeshivas, and Orthodox Jewish communities</p>
              </div>
            </div>
          </div>

          <div className="ml-4 mb-2">
            <p className="font-semibold text-sm mb-1">Islam:</p>
            <div className="ml-4">
              <div className="mb-1">
                <div><span className="form-box"></span> Muslim/Islamic (General)</div>
                <p className="text-xs italic text-slate-600 ml-7">Muslim faith - scholarships from ISNA, Muslim Student Association, and Islamic relief organizations</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Sunni Muslim</div>
                <p className="text-xs italic text-slate-600 ml-7">Sunni Islam - funding from Sunni Islamic centers, mosques, and educational foundations</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Shia Muslim</div>
                <p className="text-xs italic text-slate-600 ml-7">Shia Islam - scholarships from Shia Islamic organizations and community centers</p>
              </div>
            </div>
          </div>

          <div className="ml-4 mb-2">
            <p className="font-semibold text-sm mb-1">Other World Religions:</p>
            <div className="ml-4">
              <div className="mb-1">
                <div><span className="form-box"></span> Buddhist</div>
                <p className="text-xs italic text-slate-600 ml-7">Buddhist faith - funding from Buddhist Peace Fellowship, temples, and meditation centers</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Hindu</div>
                <p className="text-xs italic text-slate-600 ml-7">Hindu faith - scholarships from Hindu American Foundation and temple associations</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Sikh</div>
                <p className="text-xs italic text-slate-600 ml-7">Sikh faith - funding from Sikh Coalition, gurdwaras, and Sikh American organizations</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Wiccan / Pagan</div>
                <p className="text-xs italic text-slate-600 ml-7">Wiccan, Pagan, or earth-based spirituality - support from interfaith and diversity scholarships</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Unitarian Universalist</div>
                <p className="text-xs italic text-slate-600 ml-7">UU faith community - scholarships from UUA, congregations, and denominational foundations</p>
              </div>
              <div className="avoid-break">
                <div><span className="form-box"></span> Other (please specify):</div>
                <div className="ml-8">
                  <span className="inline-entry" style={{ width: '300px', marginLeft: '4px' }}></span>
                </div>
              </div>
            </div>
          </div>
          
          <div className="ml-4 mt-3">
            <div className="mb-1">
              <div><span className="form-box"></span> LGBTQ+</div>
              <p className="text-xs italic text-slate-600 ml-7">Lesbian, gay, bisexual, transgender, queer, or other sexual/gender minority - numerous LGBTQ+ scholarships, advocacy organizations, and inclusive foundations offer support</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Good Credit Score (700+)</div>
              <p className="text-xs italic text-slate-600 ml-7">Credit score of 700 or above - qualifies for emergency assistance programs, financial literacy workshops, and non-loan support from credit counseling agencies and financial empowerment programs</p>
            </div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>10. FAMILY & LIFE SITUATION</h2>
          <p className="mb-2">Check all that apply:</p>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> Single Parent</div>
              <p className="text-xs italic text-slate-600 ml-7">Raising children without a spouse or partner</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Foster Youth / Former Foster Care</div>
              <p className="text-xs italic text-slate-600 ml-7">Currently or previously in foster care system</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Orphan</div>
              <p className="text-xs italic text-slate-600 ml-7">Both parents deceased</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Adopted</div>
              <p className="text-xs italic text-slate-600 ml-7">Legally adopted by non-biological parents</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Foster or Adoptive Parent</div>
              <p className="text-xs italic text-slate-600 ml-7">Currently fostering or have adopted children</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Family Caregiver</div>
              <p className="text-xs italic text-slate-600 ml-7">Caring for ill, disabled, or elderly family member</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Widow / Widower</div>
              <p className="text-xs italic text-slate-600 ml-7">Spouse is deceased</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Grandparent Raising Grandchildren</div>
              <p className="text-xs italic text-slate-600 ml-7">Primary caregiver for grandchildren</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> First-Time Parent</div>
              <p className="text-xs italic text-slate-600 ml-7">First child, may qualify for parenting support programs</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Homeless / Housing Insecure</div>
              <p className="text-xs italic text-slate-600 ml-7">Without stable housing or at risk of losing housing</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Domestic Violence Survivor</div>
              <p className="text-xs italic text-slate-600 ml-7">Survivor of intimate partner violence</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Human Trafficking Survivor</div>
              <p className="text-xs italic text-slate-600 ml-7">Survivor of sex or labor trafficking</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Disaster Survivor</div>
              <p className="text-xs italic text-slate-600 ml-7">Affected by natural disaster, fire, or catastrophic event</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Formerly Incarcerated / Returning Citizen</div>
              <p className="text-xs italic text-slate-600 ml-7">Previously incarcerated, now reentering society</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Minor Child (Under 18)</div>
              <p className="text-xs italic text-slate-600 ml-7">Under 18 years old</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Young Adult (18-24)</div>
              <p className="text-xs italic text-slate-600 ml-7">Age 18-24, transitional life stage</p>
            </div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>11. MILITARY SERVICE</h2>
          <div className="ml-4">
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Veteran</div>
              <div className="ml-8 mt-1">
                <div>Branch & MOS: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span></div>
                <div className="mt-1">Campaign Medals: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span></div>
                <div className="mt-1">Character of Discharge: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span></div>
                <div className="mt-1"><span className="form-box"></span> DD-214 on File</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Served in U.S. Armed Forces - extensive VA benefits, veteran scholarships, and service organization support</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Active Duty Military</div>
              <p className="text-xs italic text-slate-600 ml-7">Currently serving - tuition assistance, family support programs</p>
            </div>
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> National Guard / Reserve</div>
              <div className="ml-8">
                Recent Activation Date: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7">Part-time military service - Guard/Reserve specific benefits</p>
            </div>
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Disabled Veteran</div>
              <div className="ml-8">
                VA Disability Rating: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span>%
              </div>
              <p className="text-xs italic text-slate-600 ml-7">Service-connected disability - enhanced VA benefits, vocational rehab, and DAV support</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Military Spouse</div>
              <p className="text-xs italic text-slate-600 ml-7">Married to service member - My Career Advancement Account (MyCAA), spouse scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Military Dependent</div>
              <p className="text-xs italic text-slate-600 ml-7">Child of service member - numerous dependent scholarships and education benefits</p>
            </div>
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Gold Star Family Member</div>
              <div className="ml-8">
                Relationship: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7">Family of service member killed in action - Folds of Honor, survivor benefits, memorial scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Post-9/11 GI Bill Recipient</div>
              <p className="text-xs italic text-slate-600 ml-7">Using Post-9/11 education benefits - full tuition at public schools</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> VR&E (Veteran Readiness & Employment)</div>
              <p className="text-xs italic text-slate-600 ml-7">Vocational rehabilitation for service-connected disabled veterans</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> CHAMPVA Recipient</div>
              <p className="text-xs italic text-slate-600 ml-7">Healthcare for dependents of disabled/deceased veterans</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> VSO Representation</div>
              <p className="text-xs italic text-slate-600 ml-7">Working with Veterans Service Organization for claims/benefits</p>
            </div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>12. OCCUPATION & WORK</h2>
          <div className="ml-4">
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Healthcare Worker</div>
              <div className="ml-8 mt-1">
                Type: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span>
                <p className="text-xs text-slate-500 mt-1">Examples: RN, LPN, CNA, PTA, MD, DO, NP, PA, EMT-P, Paramedic, Respiratory Therapist, Occupational Therapist, Speech Therapist, Medical Assistant, Phlebotomist, Radiology Tech, Pharmacy Tech, etc.</p>
              </div>
              <div className="ml-8 mt-1">
                Licensure/Certifications: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Nurse, doctor, PTA, EMT, CNA, or other medical professional - NHSC loan forgiveness, HRSA scholarships, and state workforce programs</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Teacher / Educator</div>
              <p className="text-xs italic text-slate-600 ml-7">K-12 or higher education teacher - loan forgiveness and grants for educators</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Firefighter</div>
              <p className="text-xs italic text-slate-600 ml-7">Career or volunteer firefighter - equipment grants and training support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Law Enforcement Officer</div>
              <p className="text-xs italic text-slate-600 ml-7">Police, sheriff, corrections officer - education benefits available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Public Servant / Government Employee</div>
              <p className="text-xs italic text-slate-600 ml-7">Local, state, or federal government worker - public service loan forgiveness available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Clergy / Minister / Religious Worker</div>
              <p className="text-xs italic text-slate-600 ml-7">Pastor, priest, rabbi, imam, or religious leader - denominational support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Missionary / Evangelist</div>
              <p className="text-xs italic text-slate-600 ml-7">Religious missionary or evangelist - mission support grants available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Nonprofit Employee</div>
              <p className="text-xs italic text-slate-600 ml-7">Works for charitable organization - public service benefits available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Small Business Owner</div>
              <p className="text-xs italic text-slate-600 ml-7">Owns small business - SBA loans and grants available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Union Member</div>
              <p className="text-xs italic text-slate-600 ml-7">Member of labor union - union scholarships and benefits available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Farmer / Agricultural Worker</div>
              <p className="text-xs italic text-slate-600 ml-7">Works in agriculture - USDA programs and farm support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Truck Driver / Transportation Worker</div>
              <p className="text-xs italic text-slate-600 ml-7">Commercial driver or transportation industry - training grants available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Construction / Trades Worker</div>
              <p className="text-xs italic text-slate-600 ml-7">Electrician, plumber, carpenter, HVAC - apprenticeship support available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Researcher / Scientist</div>
              <p className="text-xs italic text-slate-600 ml-7">Research professional - research grants and fellowships available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Environmental / Conservation Worker</div>
              <p className="text-xs italic text-slate-600 ml-7">Environmental protection or conservation field - green sector grants available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Energy Sector Worker (incl. Renewables)</div>
              <p className="text-xs italic text-slate-600 ml-7">Oil, gas, solar, wind, or other energy industry - transition training available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Artist / Musician / Cultural Worker</div>
              <p className="text-xs italic text-slate-600 ml-7">Creative professional - arts grants and fellowships available</p>
            </div>
            
            <h3 className="mt-3">Additional Work Characteristics:</h3>
            <div className="ml-4">
              <div className="mb-2">
                <div>Union Local & Apprenticeship Registration #: <span className="inline-entry" style={{ width: '200px', marginLeft: '4px' }}></span></div>
                <p className="text-xs italic text-slate-600 ml-4">Union members - access to union scholarships and training funds</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> Shift Work / Overtime Exposure</div>
                <p className="text-xs italic text-slate-600 ml-7">Non-traditional work hours - recognized in some assistance programs</p>
              </div>
              <div className="mb-1">
                <div><span className="form-box"></span> High-Hazard Industry</div>
                <p className="text-xs italic text-slate-600 ml-7">Mining, logging, EMS, construction - safety training grants and hardship assistance</p>
              </div>
              <div className="avoid-break mb-2">
                <div><span className="form-box"></span> Farmer / Agricultural Worker</div>
                <div className="ml-8 mt-1">
                  <div>Farm Acreage: <span className="inline-entry" style={{ width: '100px', marginLeft: '4px' }}></span> acres</div>
                  <div className="mt-1">USDA Programs: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span></div>
                  <p className="text-xs text-slate-500 mt-1">(EQIP, CSP, Organic Certification, GAP, etc.)</p>
                </div>
                <p className="text-xs italic text-slate-600 ml-7 mt-1">Farm operators - USDA grants, FSA loans, conservation programs</p>
              </div>
            </div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>13. FIREARMS / SECOND AMENDMENT (if applicable)</h2>
          <p className="text-xs text-slate-500 mb-2 ml-4">Many shooting sports, hunting, and Second Amendment organizations offer scholarships and assistance programs</p>
          <div className="ml-4">
            <div className="mb-1">
              <div><span className="form-box"></span> Gun Owner / Firearm Owner</div>
              <p className="text-xs italic text-slate-600 ml-7">Own firearms - eligible for shooting sports and hunter education scholarships</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Has Concealed Carry Permit</div>
              <p className="text-xs italic text-slate-600 ml-7">Licensed to carry concealed - demonstrates commitment to responsible gun ownership</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> NRA Member</div>
              <p className="text-xs italic text-slate-600 ml-7">National Rifle Association member - access to NRA Foundation scholarships and grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> NRA Certified Instructor</div>
              <p className="text-xs italic text-slate-600 ml-7">NRA certified firearms instructor - specialized instructor grants available</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Firearms Safety Instructor</div>
              <p className="text-xs italic text-slate-600 ml-7">Certified firearms safety instructor - eligible for safety education grants</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Second Amendment Rights Advocate</div>
              <p className="text-xs italic text-slate-600 ml-7">Active in Second Amendment advocacy - Second Amendment Foundation and GOA support</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Works in Firearms Industry</div>
              <p className="text-xs italic text-slate-600 ml-7">Employed in firearms industry - industry association scholarships and training programs</p>
            </div>
            <div className="mb-1">
              <div><span className="form-box"></span> Competitive Shooter</div>
              <p className="text-xs italic text-slate-600 ml-7">USPSA, IDPA, 3-Gun, Olympic shooting, etc. - competition sponsorships and scholarships</p>
            </div>
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Hunter</div>
              <div className="ml-8">
                State(s) Licensed: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Licensed hunter - hunting conservation organizations (Ducks Unlimited, NWTF, Safari Club) offer scholarships</p>
            </div>
          </div>
        </div>

        <div className="form-section avoid-break">
          <h2>14. POLITICAL / CIVIC ENGAGEMENT (if applicable)</h2>
          <p className="text-xs text-slate-500 mb-2 ml-4">Elected officials, candidates, and civic leaders have access to specialized training, campaign support, and leadership development funding</p>
          <div className="ml-4">
            <div className="avoid-break mb-2">
              <div><span className="form-box"></span> Current or Former Elected Official</div>
              <div className="ml-8 mt-1">
                <div>Office Held: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span></div>
                <p className="text-xs text-slate-500 mt-1">(City Council, School Board, Mayor, State Representative, County Commissioner, etc.)</p>
                <div className="mt-1">Years in Office: <span className="inline-entry" style={{ width: '80px', marginLeft: '4px' }}></span></div>
              </div>
              <p className="text-xs italic text-slate-600 ml-7 mt-1">Elected official - access to municipal associations, leadership development programs, and governance training</p>
            </div>
            
            <div className="mb-1">
              <div><span className="form-box"></span> Political Candidate</div>
              <p className="text-xs italic text-slate-600 ml-7">Current or former candidate - campaign finance support and training programs available</p>
            </div>
            
            <div className="mb-2">
              <strong>Political Party Affiliation:</strong>
              <div className="ml-4 mt-1">
                <div><span className="form-box"></span> Democratic</div>
                <div><span className="form-box"></span> Republican</div>
                <div><span className="form-box"></span> Independent</div>
                <div><span className="form-box"></span> Libertarian</div>
                <div><span className="form-box"></span> Green</div>
                <div><span className="form-box"></span> Other: <span className="inline-entry" style={{ width: '150px', marginLeft: '4px' }}></span></div>
                <div><span className="form-box"></span> None / No Affiliation</div>
              </div>
              <p className="text-xs italic text-slate-600 ml-4 mt-1">Party affiliation opens access to party committees, leadership PACs, and political training programs</p>
            </div>
            
            <div className="mb-1">
              <div><span className="form-box"></span> Political Party Committee Member</div>
              <p className="text-xs italic text-slate-600 ml-7">Member of local, county, or state party committee</p>
            </div>
            
            <div className="mb-2">
              <div>Party Leadership Position: <span className="inline-entry" style={{ width: '250px', marginLeft: '4px' }}></span></div>
              <p className="text-xs text-slate-500 ml-4">(Chair, Vice-Chair, Treasurer, Secretary, etc.)</p>
            </div>
            
            <div className="mb-1">
              <div><span className="form-box"></span> Campaign Volunteer</div>
              <p className="text-xs italic text-slate-600 ml-7">Active volunteer in political campaigns</p>
            </div>
            
            <div className="mb-1">
              <div><span className="form-box"></span> Political Activist or Organizer</div>
              <p className="text-xs italic text-slate-600 ml-7">Community organizing and political activism - fellowship and training opportunities</p>
            </div>
            
            <div className="mb-2">
              <strong>Level of Civic/Political Engagement:</strong>
              <div className="ml-4">
                <div><span className="form-box"></span> Voter</div>
                <div><span className="form-box"></span> Volunteer</div>
                <div><span className="form-box"></span> Activist</div>
                <div><span className="form-box"></span> Candidate</div>
                <div><span className="form-box"></span> Elected Official</div>
              </div>
            </div>
            
            <h3 className="mt-3">Type of Office/Role:</h3>
            <div className="ml-4 mt-1">
              <div><span className="form-box"></span> Municipal/Local Government Official (city/town)</div>
              <div><span className="form-box"></span> County Government Official</div>
              <div><span className="form-box"></span> State Government Official</div>
              <div><span className="form-box"></span> Federal Government Official</div>
            </div>
            
            <div className="mt-3 mb-1">
              <div><span className="form-box"></span> Campaign Finance Experience</div>
              <p className="text-xs italic text-slate-600 ml-7">Experience with fundraising, compliance, and campaign finance - specialized training available</p>
            </div>
            
            <div className="mt-2 mb-2">
              <strong>Policy Expertise Areas:</strong>
              <div className="form-line"></div>
              <p className="text-xs text-slate-500 ml-4">(Education, Healthcare, Economic Development, Public Safety, Environment, etc.)</p>
            </div>
            
            <div className="mt-4 p-3 bg-slate-50 rounded">
              <p className="text-xs font-semibold mb-1">Organizations That May Provide Support:</p>
              <ul className="text-xs ml-4 list-disc space-y-1">
                <li>National League of Cities (NLC) - training and leadership development for municipal officials</li>
                <li>U.S. Conference of Mayors - programs for mayors and municipal leaders</li>
                <li>National Association of Counties (NACo) - support for county officials</li>
                <li>State municipal leagues and county associations</li>
                <li>Political party committees (DNC, RNC, DLCC, RSLC) - campaign support and training</li>
                <li>Leadership PACs - financial support from senior elected officials</li>
                <li>Young Elected Officials (YEO) Network - emerging leaders support</li>
                <li>Policy institutes (Brookings, AEI, CAP) - research and analysis support</li>
                <li>Harvard Kennedy School - executive education for public servants</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="page-break"></div>

        <div className="form-section">
          <h2>15. YOUR STORY & GOALS</h2>
          
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
          <h2>16. ADDITIONAL INFORMATION</h2>
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
            <strong>Signature:</strong> <span className="inline-entry" style={{ width: '350px', marginLeft: '16px' }}></span>
          </p>
          <p className="text-sm mb-4">
            <strong>Date:</strong> <span className="inline-entry" style={{ width: '200px', marginLeft: '16px' }}></span>
          </p>
          <p className="text-sm mt-4">
            <strong>INSTRUCTIONS:</strong> After completing this form, hand it back to John White, fax it to: 423-414-5290, or email it to: Dr.JohnWhite@axiombiolabs.org
          </p>
        </div>
      </div>
    </div>
  );
}