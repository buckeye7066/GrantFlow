/**
 * utilityAssistance.js
 *
 * Curated database of utility company low-income assistance programs, payment
 * aid, and weatherization programs across the United States.
 *
 * These programs are often easier to qualify for than LIHEAP and cover
 * millions of households who are unaware they exist. Every entry links directly
 * to the utility's assistance program page (not the company homepage).
 *
 * Income limits are typically 200% FPL unless otherwise noted.
 * `recurring: true`  → ongoing discount / rate reduction
 * `recurring: false` → one-time or seasonal crisis assistance
 */

export const UTILITY_ASSISTANCE_PROGRAMS = [

  // ════════════════════════════════════════════════════════════════
  // FEDERAL / NATIONAL PROGRAMS
  // ════════════════════════════════════════════════════════════════

  {
    id: 'util-lifeline',
    name: 'Lifeline Program — Phone & Internet Discount (FCC)',
    description: 'Federal program providing up to $9.25/month discount on phone or broadband service for qualifying low-income households. Tribal benefit is $34.25/month. Available in all 50 states through participating carriers.',
    url: 'https://www.fcc.gov/consumers/guides/lifeline-support-affordable-communications',
    categories: ['utilities', 'internet'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities', 'internet'],
    eligibility: { incomeLimit: '135% FPL or participation in SNAP, Medicaid, SSI, federal public housing, or Lifeline-qualifying programs' },
    recurring: true,
  },

  {
    id: 'util-acp-successor',
    name: 'Affordable Connectivity Program (ACP) — Ended May 2024',
    description: 'The ACP broadband subsidy (up to $30/month) ended May 2024. Current options: Lifeline ($9.25/month discount), low-cost ISP plans (e.g., Comcast Internet Essentials, AT&T Access), and state broadband programs. Check BroadbandNow for current low-income broadband options.',
    url: 'https://www.fcc.gov/broadbandbenefits',
    categories: ['utilities', 'internet'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities', 'internet'],
    eligibility: { incomeLimit: 'ACP ended — see Lifeline and ISP low-income plans' },
    recurring: false,
  },

  {
    id: 'util-doe-weatherization',
    name: 'DOE Weatherization Assistance Program (WAP)',
    description: 'Free home weatherization for low-income households — insulation, air sealing, heating/cooling system upgrades, and health and safety repairs. Reduces energy bills by an average of $283/year. Delivered through state agencies and local nonprofits. Available nationwide.',
    url: 'https://www.energy.gov/scep/wap/weatherization-assistance-program',
    categories: ['utilities', 'weatherization', 'housing'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities', 'housing'],
    eligibility: { incomeLimit: '200% FPL or LIHEAP-eligible' },
    recurring: false,
  },

  {
    id: 'util-doe-home-energy-audit',
    name: 'DOE Home Energy Score / Free Energy Audit Programs',
    description: 'Free home energy audits help identify where homes lose energy and what improvements save money. Many utilities offer free audits to all customers. DOE\'s Home Energy Score program certifies auditors nationwide. Low-income households often qualify for free upgrades after the audit.',
    url: 'https://www.energy.gov/eere/buildings/home-energy-score',
    categories: ['utilities', 'weatherization'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: 'Free audits available to all; upgrades at 200% FPL or below' },
    recurring: false,
  },

  // ════════════════════════════════════════════════════════════════
  // SOUTHEAST — Duke Energy, Dominion, Georgia/Alabama/Mississippi Power
  // ════════════════════════════════════════════════════════════════

  {
    id: 'util-duke-energy-share',
    name: 'Duke Energy SHARE Program',
    description: 'One-time bill payment grants for Duke Energy customers in the Carolinas, Florida, Indiana, Ohio, and Kentucky who are experiencing a financial crisis. Administered through local social service agencies. Grants are typically $150–$500 per household per year.',
    url: 'https://www.duke-energy.com/home/products/share',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; proof of disconnect notice or inability to pay' },
    recurring: false,
    stateRestriction: 'NC',
  },

  {
    id: 'util-duke-energy-bill-assistance',
    name: 'Duke Energy Bill Payment Assistance Program',
    description: 'Ongoing low-income rate reduction and payment assistance for Duke Energy residential customers in the Carolinas, Florida, Indiana, Ohio, and Kentucky. Includes budget billing, extended payment plans, and referrals to LIHEAP and weatherization.',
    url: 'https://www.duke-energy.com/home/billing/financial-assistance',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; income verification required' },
    recurring: true,
    stateRestriction: 'NC',
  },

  {
    id: 'util-dominion-energy-share',
    name: 'Dominion Energy EnergyShare',
    description: 'Bill assistance, payment arrangements, and weatherization assistance for Dominion Energy customers in Virginia, North Carolina, South Carolina, Ohio, Utah, Idaho, and Wyoming. Crisis grants available year-round; weatherization program available seasonally.',
    url: 'https://www.dominionenergy.com/home/billing-and-payments/energy-assistance',
    categories: ['utilities', 'weatherization'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL for crisis assistance; 60% AMI for weatherization' },
    recurring: true,
    stateRestriction: 'VA',
  },

  {
    id: 'util-georgia-power-share',
    name: 'Georgia Power Project SHARE',
    description: 'Emergency bill assistance grants for Georgia Power customers in financial crisis. Funded by customer and company donations. Distributed through local social service agencies. Available year-round for qualifying low-income households in Georgia.',
    url: 'https://www.georgiapower.com/residential/billing-payment/payment-assistance.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; must be Georgia Power customer facing disconnection' },
    recurring: false,
    stateRestriction: 'GA',
  },

  {
    id: 'util-alabama-power-share',
    name: 'Alabama Power Project SHARE',
    description: 'Emergency electric bill assistance for Alabama Power customers experiencing financial hardship. Grants distributed through the American Red Cross and local agencies. Available year-round while funds last.',
    url: 'https://www.alabamapower.com/residential/billing-payment/payment-assistance.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Alabama Power customer in hardship' },
    recurring: false,
    stateRestriction: 'AL',
  },

  {
    id: 'util-mississippi-power-share',
    name: 'Mississippi Power Project SHARE',
    description: 'Emergency bill assistance grants for Mississippi Power customers in financial hardship. Administered through local social service agencies. Limited funds available annually.',
    url: 'https://www.mississippipower.com/residential/billing-payment/payment-assistance',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Mississippi Power customer' },
    recurring: false,
    stateRestriction: 'MS',
  },

  {
    id: 'util-entergy-lica',
    name: 'Entergy Low Income Customer Assistance (LICA)',
    description: 'Discounted electric rates and bill assistance for low-income residential customers of Entergy in Texas, Arkansas, Louisiana, and Mississippi. Includes the Low Income Assistance (LIA) rate discount program and bill payment assistance.',
    url: 'https://www.entergy.com/residential/bill-help/',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; must be Entergy customer' },
    recurring: true,
    stateRestriction: 'LA',
  },

  {
    id: 'util-piedmont-share-warmth',
    name: 'Piedmont Natural Gas Share the Warmth',
    description: 'Emergency natural gas bill assistance grants for Piedmont Natural Gas customers in North Carolina, South Carolina, and Tennessee. Funded by customer donations and company match. Distributed through local community action agencies.',
    url: 'https://www.piedmontng.com/help-with-your-bill/financial-assistance',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; disconnect notice or inability to pay' },
    recurring: false,
    stateRestriction: 'NC',
  },

  {
    id: 'util-ky-lge-cap',
    name: 'LG&E and KU Energy Customer Assistance Program (CAP)',
    description: 'Income-qualified rate reduction for LG&E and Kentucky Utilities (KU) customers in Kentucky. Qualifying households receive a percentage reduction on their monthly electric and gas bills based on income level.',
    url: 'https://lge-ku.com/my-account/billing-payments/financial-assistance',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Kentucky residents who are LG&E or KU customers' },
    recurring: true,
    stateRestriction: 'KY',
  },

  {
    id: 'util-fpl-care-to-share',
    name: 'Florida Power & Light FPL Care-to-Share',
    description: 'Emergency bill payment assistance for FPL customers in financial crisis in Florida. Funded by customer donations. Distributed through local nonprofit agencies. Available year-round while funds last.',
    url: 'https://www.fpl.com/residential/customer-service/payment-arrangements/care-to-share.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; FPL customer facing disconnection' },
    recurring: false,
    stateRestriction: 'FL',
  },

  {
    id: 'util-tampa-electric-share',
    name: 'Tampa Electric Share the Warmth / Energy Assistance',
    description: 'Emergency utility bill assistance for Tampa Electric and TECO Peoples Gas customers in Florida. The EF3 Community Assistance Fund provides grants through local agencies for customers in crisis.',
    url: 'https://www.tampaelectric.com/residential/billing/financialassistance/',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Tampa Electric or TECO customer' },
    recurring: false,
    stateRestriction: 'FL',
  },

  // ════════════════════════════════════════════════════════════════
  // NORTHEAST — Con Edison, National Grid, Eversource, PSE&G, PECO, PPL
  // ════════════════════════════════════════════════════════════════

  {
    id: 'util-coned-heap',
    name: 'Con Edison Home Energy Assistance Program',
    description: 'Discounted electric and gas rates and bill assistance for low-income Con Edison customers in New York City and Westchester County, NY. Includes the Backup Heating Program and connection to HEAP (New York state LIHEAP).',
    url: 'https://www.coned.com/en/help-center/energy-assistance-resources',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '60% State Median Income; Con Edison customer in NY' },
    recurring: true,
    stateRestriction: 'NY',
  },

  {
    id: 'util-national-grid-discount',
    name: 'National Grid Low-Income Discount Rate',
    description: 'Income-qualified bill discount programs for National Grid electric and gas customers in New York, Massachusetts, and Rhode Island. Discounts range from 25–50% on monthly bills for qualifying households.',
    url: 'https://www.nationalgridus.com/our-company/initiatives/energy-efficiency/assistance-programs/',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL or income-qualified based on state guidelines' },
    recurring: true,
    stateRestriction: 'NY',
  },

  {
    id: 'util-eversource-low-income',
    name: 'Eversource Energy Low-Income Discount Rate',
    description: 'Income-qualified electricity and gas discount programs for Eversource customers in Connecticut, Massachusetts, and New Hampshire. Qualifying customers receive 30–50% discounts on monthly bills plus access to energy efficiency programs.',
    url: 'https://www.eversource.com/content/ema-c/residential/account-billing/manage-bills/getting-help-paying-your-bill',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Eversource customer in CT, MA, or NH' },
    recurring: true,
    stateRestriction: 'CT',
  },

  {
    id: 'util-pseg-usf',
    name: 'PSE&G Universal Service Fund (USF) and Weatherization',
    description: 'Income-qualified bill assistance and free weatherization for PSE&G customers in New Jersey. The USF provides monthly bill credits; the Comfort Partners program delivers free home efficiency upgrades. Also includes the Medical Emergency Assistance Fund.',
    url: 'https://www.pseg.com/home/products_services/residential/customer_assistance/',
    categories: ['utilities', 'weatherization'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '225% FPL for USF; 250% FPL for weatherization; NJ PSE&G customers' },
    recurring: true,
    stateRestriction: 'NJ',
  },

  {
    id: 'util-atlantic-city-electric-usf',
    name: 'Atlantic City Electric Universal Service Fund (USF)',
    description: 'Income-qualified electric bill assistance for Atlantic City Electric customers in New Jersey. Monthly bill credits based on income level. Also provides access to the New Jersey Comfort Partners weatherization program.',
    url: 'https://www.atlanticcityelectric.com/en/help/help-paying-bills/low-income-assistance.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '225% FPL; Atlantic City Electric customer in NJ' },
    recurring: true,
    stateRestriction: 'NJ',
  },

  {
    id: 'util-peco-cap',
    name: 'PECO Customer Assistance Program (CAP)',
    description: 'Income-qualified electric and gas bill assistance for PECO customers in southeastern Pennsylvania. CAP provides a reduced monthly payment based on household income, not actual usage. Also includes arrearage forgiveness over time.',
    url: 'https://www.peco.com/Accounts/CustomerAssistance/Pages/default.aspx',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '150% FPL; PECO customer in southeastern PA' },
    recurring: true,
    stateRestriction: 'PA',
  },

  {
    id: 'util-ppl-ontrack',
    name: 'PPL Electric Utilities OnTrack Program',
    description: 'Income-qualified electric bill assistance for PPL Electric Utilities customers in central and eastern Pennsylvania. Sets monthly bill at an affordable percentage of household income. Includes CAP-Plus arrearage forgiveness.',
    url: 'https://www.pplelectric.com/customer-assistance/ontrack',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '150% FPL; PPL customer in central/eastern PA' },
    recurring: true,
    stateRestriction: 'PA',
  },

  {
    id: 'util-avangrid-assistance',
    name: 'Avangrid / UIL Low-Income Assistance Programs',
    description: 'Income-qualified electric and gas bill discounts for Avangrid (United Illuminating, Connecticut Natural Gas, Southern CT Gas) and Central Maine Power customers in Connecticut and Maine. Also serves New York through NY State Electric & Gas (NYSEG) and Rochester Gas & Electric (RG&E).',
    url: 'https://www.avangrid.com/en/about/foundation/community/energy-assistance',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Avangrid/UIL customer in CT, ME, or NY' },
    recurring: true,
    stateRestriction: 'CT',
  },

  {
    id: 'util-delmarva-usp',
    name: 'Delmarva Power Universal Service Program (USP)',
    description: 'Income-qualified electric bill assistance for Delmarva Power customers in Delaware and Maryland. Monthly bill credits based on household income. Includes referrals to weatherization and the Maryland Office of Home Energy Programs.',
    url: 'https://www.delmarva.com/en/help/help-paying-bills/low-income-assistance.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Delmarva Power customer in DE or MD' },
    recurring: true,
    stateRestriction: 'DE',
  },

  {
    id: 'util-columbia-gas-assistance',
    name: 'Columbia Gas Customer Assistance Programs',
    description: 'Income-qualified natural gas bill assistance for Columbia Gas customers across multiple states including Ohio, Pennsylvania, Virginia, Kentucky, Maryland, and Massachusetts. Programs include budget billing, CAP rates, arrearage management, and weatherization referrals.',
    url: 'https://www.columbiagasohio.com/help-center/payment-assistance',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Columbia Gas customer in OH, PA, VA, KY, MD, or MA' },
    recurring: true,
    stateRestriction: 'OH',
  },

  // ════════════════════════════════════════════════════════════════
  // MIDWEST — Ameren, ComEd, AEP, Xcel, CenterPoint, Evergy, WPS
  // ════════════════════════════════════════════════════════════════

  {
    id: 'util-ameren-care',
    name: 'Ameren Illinois & Missouri CARE Program',
    description: 'Income-qualified electric and natural gas bill assistance for Ameren customers in Illinois and Missouri. The CARE (Customer Assistance for Residential Energy) program provides monthly bill credits. Illinois customers also have access to the Ameren Illinois Residential Income-Qualified Program for free energy efficiency upgrades.',
    url: 'https://www.ameren.com/residential/bill-help',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Ameren customer in IL or MO' },
    recurring: true,
    stateRestriction: 'IL',
  },

  {
    id: 'util-comed-care',
    name: 'ComEd CARE and SARAP Programs',
    description: 'Income-qualified electric bill assistance for ComEd customers in northern and central Illinois. CARE (Customer Assistance for Residential Energy) provides monthly discounts. SARAP (Supplemental Arrearage Reduction Assistance Program) helps customers reduce past-due balances.',
    url: 'https://www.comed.com/MyAccount/CustomerSupport/Pages/FinancialAssistancePrograms.aspx',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; ComEd customer in northern/central IL' },
    recurring: true,
    stateRestriction: 'IL',
  },

  {
    id: 'util-peoples-energy-assistance',
    name: 'Peoples Energy (Integrys) Payment Assistance',
    description: 'Income-qualified natural gas bill assistance for Peoples Energy customers in Chicago, Illinois. Programs include the Peoples Energy Low Income Program (LIP) for ongoing bill discounts and emergency assistance for customers facing disconnection.',
    url: 'https://www.peoplesenergy.com/en/help/help-paying-bills.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Peoples Energy customer in Chicago area' },
    recurring: true,
    stateRestriction: 'IL',
  },

  {
    id: 'util-aep-assistance',
    name: 'AEP Customer Assistance Programs',
    description: 'Bill assistance, budget billing, and payment plans for AEP (American Electric Power) customers across Texas, Ohio, West Virginia, Virginia, Oklahoma, Arkansas, Louisiana, Michigan, and Indiana. Programs vary by AEP subsidiary (AEP Texas, Ohio Power, Appalachian Power, etc.).',
    url: 'https://www.aep.com/residential/customer-service/assistance/',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; AEP customer in service territory' },
    recurring: true,
    stateRestriction: 'OH',
  },

  {
    id: 'util-xcel-income-qualified',
    name: 'Xcel Energy Income-Qualified Rate Programs',
    description: 'Income-qualified electric and natural gas rate discounts for Xcel Energy customers in Minnesota, Colorado, Texas, New Mexico, South Dakota, North Dakota, Wisconsin, and Michigan. The Xcel Energy Affordability Program (EAP) provides reduced monthly bills and bill credits for qualifying households.',
    url: 'https://www.xcelenergy.com/programs_and_rebates/residential_programs_and_rebates/assistance_programs',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Xcel Energy customer in MN, CO, TX, NM, SD, ND, WI, or MI' },
    recurring: true,
    stateRestriction: 'MN',
  },

  {
    id: 'util-centerpoint-assistance',
    name: 'CenterPoint Energy Customer Assistance Programs',
    description: 'Bill assistance and payment plans for CenterPoint Energy natural gas and electric customers in Texas, Minnesota, Indiana, Ohio, Arkansas, Louisiana, and Mississippi. Includes the Energy Assistance program for low-income households and emergency payment arrangements.',
    url: 'https://www.centerpointenergy.com/en-us/residential/Pages/assistance-programs.aspx',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; CenterPoint Energy customer' },
    recurring: true,
    stateRestriction: 'MN',
  },

  {
    id: 'util-evergy-lira',
    name: 'Evergy Low Income Rate Assistance (LIRA)',
    description: 'Income-qualified electric rate reduction for Evergy customers in Kansas and Missouri. LIRA provides a percentage discount on monthly electric bills for qualifying low-income households.',
    url: 'https://www.evergy.com/residential/payment-help/financial-assistance',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Evergy customer in KS or MO' },
    recurring: true,
    stateRestriction: 'KS',
  },

  {
    id: 'util-wps-home-energy-plus',
    name: 'WPS / Wisconsin Public Service Home Energy Plus',
    description: 'Low-income electric and natural gas rate assistance for Wisconsin Public Service (WPS) customers in northeastern Wisconsin. Wisconsin\'s Home Energy Plus program (state-administered) also provides arrearage management and weatherization referrals for WPS customers.',
    url: 'https://www.integrysgroup.com/wps/portal/wps/internet/HelpPayBill',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; WPS customer in WI' },
    recurring: true,
    stateRestriction: 'WI',
  },

  // ════════════════════════════════════════════════════════════════
  // CALIFORNIA — PG&E, SCE, SDG&E
  // ════════════════════════════════════════════════════════════════

  {
    id: 'util-pge-care-fera',
    name: 'PG&E CARE and FERA Programs (California)',
    description: 'CARE (California Alternate Rates for Energy) provides a 20–35% discount on monthly electric and gas bills for low-income PG&E customers. FERA (Family Electric Rate Assistance) provides 18% discount for households of 3+ that slightly exceed CARE income limits. Available to all PG&E residential customers in northern and central California.',
    url: 'https://www.pge.com/en/account/discount-services/care.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: 'CARE: 200% FPL; FERA: household of 3 at 250% FPL or higher' },
    recurring: true,
    stateRestriction: 'CA',
  },

  {
    id: 'util-sce-care-fera',
    name: 'Southern California Edison CARE and FERA Programs',
    description: 'CARE provides 30–35% discount on monthly electric bills for income-qualified SCE customers in southern California. FERA provides 18% discount for larger households that narrowly exceed CARE limits. Auto-enrollment available through Medi-Cal/Medicaid data matching.',
    url: 'https://www.sce.com/residential/assistance-programs/care',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: 'CARE: 200% FPL; FERA: household of 3+ at 250% FPL' },
    recurring: true,
    stateRestriction: 'CA',
  },

  {
    id: 'util-sdge-care-fera',
    name: 'San Diego Gas & Electric CARE and FERA Programs',
    description: 'CARE provides 30–35% discount on monthly electric and gas bills for income-qualified SDG&E customers in San Diego and southern Orange County. FERA provides 18% discount for larger households. SDG&E also offers the Energy Savings Assistance (ESA) Program for free home upgrades.',
    url: 'https://www.sdge.com/customer-care/financial-assistance/care-fera',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: 'CARE: 200% FPL; FERA: household of 3+ at 250% FPL' },
    recurring: true,
    stateRestriction: 'CA',
  },

  // ════════════════════════════════════════════════════════════════
  // PACIFIC NORTHWEST — Puget Sound Energy, Pacific Power
  // ════════════════════════════════════════════════════════════════

  {
    id: 'util-pse-helping-hand',
    name: 'Puget Sound Energy Helping Hand Program',
    description: 'Emergency utility bill assistance for Puget Sound Energy customers in western and central Washington State. Funded by customer and employee donations. Grants distributed through local community action agencies. Available year-round while funds last.',
    url: 'https://www.pse.com/en/account-and-billing/account-help/assistance-programs',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; PSE customer in WA' },
    recurring: false,
    stateRestriction: 'WA',
  },

  {
    id: 'util-pacific-power-assistance',
    name: 'Pacific Power Energy Assistance Programs',
    description: 'Low-income electric bill assistance for Pacific Power customers in Oregon, Washington, California, Utah, and Wyoming. Includes the Energy Assistance Fund, the Blue Sky renewable energy program rebates, and referrals to LIHEAP and weatherization programs.',
    url: 'https://www.pacificpower.net/account/billing-payment/assistance.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Pacific Power customer in OR, WA, CA, UT, or WY' },
    recurring: true,
    stateRestriction: 'OR',
  },

  // ════════════════════════════════════════════════════════════════
  // SOUTHWEST — PNM, APS, Salt River Project, Rocky Mountain Power
  // ════════════════════════════════════════════════════════════════

  {
    id: 'util-pnm-assistance',
    name: 'PNM Low Income Assistance Program (New Mexico)',
    description: 'Income-qualified electric rate reduction and bill assistance for PNM customers in central and northern New Mexico. PNM also offers the Affordable Energy Program providing monthly bill credits, and connects customers with LIHEAP and the New Mexico Gas Company assistance programs.',
    url: 'https://www.pnm.com/assistance-programs',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; PNM customer in NM' },
    recurring: true,
    stateRestriction: 'NM',
  },

  {
    id: 'util-aps-energy-support',
    name: 'Arizona Public Service (APS) Energy Support Program',
    description: 'Income-qualified electric bill discount for APS customers in most of Arizona (except Tucson). The APS Energy Support program provides monthly bill credits of up to 25% for qualifying households.',
    url: 'https://www.aps.com/en/residential/account-services/assistance-programs/energy-support-program',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; APS customer in AZ' },
    recurring: true,
    stateRestriction: 'AZ',
  },

  {
    id: 'util-srp-assistance',
    name: 'Salt River Project (SRP) Affordable Home Energy Assistance',
    description: 'Income-qualified electric rate discount for Salt River Project customers in the Phoenix metropolitan area of Arizona. The SRP Low Income Program provides monthly rate discounts for qualifying residential customers.',
    url: 'https://www.srpnet.com/customer-service/payment-options/bill-assistance',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; SRP customer in Phoenix metro area, AZ' },
    recurring: true,
    stateRestriction: 'AZ',
  },

  {
    id: 'util-rocky-mountain-power',
    name: 'Rocky Mountain Power Low Income Programs',
    description: 'Income-qualified electric rate assistance for Rocky Mountain Power customers in Utah, Idaho, and Wyoming. Programs include the Low Income Assistance Program (LIAP) providing monthly bill credits and weatherization referrals.',
    url: 'https://www.rockymountainpower.net/account/financial-assistance.html',
    categories: ['utilities'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities'],
    eligibility: { incomeLimit: '200% FPL; Rocky Mountain Power customer in UT, ID, or WY' },
    recurring: true,
    stateRestriction: 'UT',
  },

];
