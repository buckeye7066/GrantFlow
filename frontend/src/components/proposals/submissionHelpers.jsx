export const getPrimaryEmail = (emailData) => {
  if (Array.isArray(emailData) && emailData.length > 0) {
    return emailData[0];
  }
  return emailData || '';
};

export const getPrimaryPhone = (phoneData) => {
  if (Array.isArray(phoneData) && phoneData.length > 0) {
    return phoneData[0];
  }
  return phoneData || '';
};

export const slugifyFilename = (title) => {
  return title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
};

export const buildCoverLetterPrompt = (organization, grant) => {
  const org = organization || {};
  const isIndividual = ['high_school_student', 'college_student', 'graduate_student', 'individual_need', 'medical_assistance', 'family', 'other'].includes(org.applicant_type);
  
  const voiceGuidance = isIndividual 
    ? 'Write in FIRST PERSON SINGULAR (I, my, me). This is an individual applicant, NOT an organization.'
    : 'Write in FIRST PERSON PLURAL (we, our, us). This is an organization.';

  return `Write a professional cover letter for this grant application submission:

${isIndividual ? 'Individual Applicant' : 'Organization'}: ${org.name || 'Applicant'}
Grant: ${grant?.title || 'Grant Opportunity'}
Funder: ${grant?.funder || 'Funder'}

CRITICAL: ${voiceGuidance}

The letter should:
1. Express gratitude for the opportunity
2. Briefly state the purpose of the application (1-2 sentences)
3. Mention key qualifications ${isIndividual ? 'or achievements' : ''}
4. Express enthusiasm and availability for questions
5. Be formal but warm
6. Be concise (under 150 words)

${isIndividual ? `
Examples of proper first-person singular:
- "I am writing to express..."
- "I am currently pursuing..."
- "My dedication to..."
- "I am eager to..."
- "Thank you for considering my application."
` : `
Examples of proper first-person plural:
- "We are writing to express..."
- "We are dedicated to..."
- "Our organization has..."
- "We are eager to..."
- "Thank you for considering our application."
`}

Keep it professional and submission-ready.`;
};

export const buildFallbackCoverLetter = (organization, grant) => {
  const org = organization || {};
  const grantData = grant || {};
  const isIndividual = ['high_school_student', 'college_student', 'graduate_student', 'individual_need', 'medical_assistance', 'family', 'other'].includes(org.applicant_type);
  const applicantName = org.name || 'Applicant';
  const grantTitle = grantData.title || 'this grant opportunity';
  
  if (isIndividual) {
    return `Dear Grant Committee,

I am pleased to submit this application for ${grantTitle}. I believe my background and goals align closely with your mission.

Thank you for your consideration. I am available to answer any questions you may have.

Sincerely,
${applicantName}`;
  } else {
    return `Dear Grant Committee,

${applicantName} is pleased to submit this application for ${grantTitle}. We believe our work aligns closely with your mission and goals.

Thank you for your consideration. We are available to answer any questions you may have.

Sincerely,
${applicantName}`;
  }
};

export const buildContactInfoPrompt = (grant) => {
  return `You are an expert research assistant specializing in finding organizational contact information.

FUNDER TO RESEARCH: "${grant.funder}"
GRANT/PROGRAM: "${grant.title || 'General inquiry'}"
${grant.url ? `KNOWN URL: ${grant.url}` : ''}

YOUR MISSION: Find REAL, VERIFIED contact information for "${grant.funder}".

MANDATORY SEARCH ACTIONS - DO ALL OF THESE:
1. Search "${grant.funder} headquarters address" - get the main office location
2. Search "${grant.funder} contact us" - find their contact page
3. Search "${grant.funder} phone number" - get main switchboard
4. Search "${grant.funder} email" or "${grant.funder} grants email" - find email contacts
5. Search "${grant.funder} 990 tax filing address" - nonprofits have public addresses on Form 990
6. If foundation: Search "${grant.funder} foundation directory" or check foundationcenter.org data

WHAT TO LOOK FOR:
- Physical/mailing address (REQUIRED - every organization has one)
- Main phone number (most organizations publish this)
- General inquiry email or grants-specific email
- Fax number (often listed on contact pages)

ADDRESS FORMAT REQUIRED:
Street Address
City, State ZIP

RULES:
- NEVER return all nulls - ${grant.funder} is a real organization with public contact info
- The address MUST include city, state, and ZIP code
- If you find partial info, INCLUDE IT - something is better than nothing
- Prefer grants/foundation department contacts over general info when available

Return ONLY valid JSON:
{
  "email": "found email or null",
  "phone": "found phone or null", 
  "fax": "found fax or null",
  "address": "FULL address with street, city, state, ZIP"
}`;
};

export const CONTACT_INFO_SCHEMA = {
  type: "object",
  properties: {
    email: { type: ["string", "null"] },
    phone: { type: ["string", "null"] },
    fax: { type: ["string", "null"] },
    address: { type: ["string", "null"] }
  }
};

export const generateCoverLetterDocument = (grant, organization, coverLetter, contactInfo) => {
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const primaryEmail = getPrimaryEmail(organization.email);
  const primaryPhone = getPrimaryPhone(organization.phone);
  
  const cityStateZip = [organization.city, organization.state, organization.zip]
    .filter(Boolean)
    .join(', ');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Cover Letter - ${grant.title}</title>
  <style>
    @page {
      margin: 1in;
    }
    body {
      font-family: 'Times New Roman', Times, serif;
      font-size: 12pt;
      line-height: 1.6;
      margin: 0;
      padding: 0;
      color: #000;
    }
    .letterhead {
      margin-bottom: 36pt;
    }
    .letterhead-name {
      font-size: 16pt;
      font-weight: bold;
      margin-bottom: 6pt;
    }
    .letterhead-address {
      font-size: 10pt;
      color: #333;
    }
    .date {
      margin-bottom: 24pt;
    }
    .recipient {
      margin-bottom: 24pt;
    }
    .salutation {
      margin-bottom: 12pt;
    }
    .body {
      text-align: justify;
      white-space: pre-wrap;
    }
    .signature {
      margin-top: 36pt;
    }
    .signature-line {
      margin-top: 48pt;
      border-top: 1px solid #000;
      width: 200px;
    }
  </style>
</head>
<body>
  <div class="letterhead">
    <div class="letterhead-name">${organization.name}</div>
    <div class="letterhead-address">
      ${organization.address ? `${organization.address}<br>` : ''}
      ${cityStateZip ? `${cityStateZip}<br>` : ''}
      ${primaryPhone ? `Phone: ${primaryPhone}<br>` : ''}
      ${primaryEmail ? `Email: ${primaryEmail}` : ''}
    </div>
  </div>

  <div class="date">${formattedDate}</div>

  ${contactInfo.recipientAddress ? `
  <div class="recipient">
    ${grant.funder}<br>
    ${contactInfo.recipientAddress.split('\n').join('<br>')}
  </div>
  ` : `
  <div class="recipient">
    ${grant.funder}
  </div>
  `}

  <div class="salutation">Dear Grant Committee,</div>

  <div class="body">${coverLetter}</div>

  <div class="signature">
    <p>Sincerely,</p>
    <div class="signature-line"></div>
    <p>${organization.name}</p>
  </div>
</body>
</html>
  `;
};

export const generateApplicationDocument = (grant, organization, sections, contactInfo, formData = {}, requirements = []) => {
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const primaryEmail = getPrimaryEmail(organization.email);
  const primaryPhone = getPrimaryPhone(organization.phone);
  
  const cityStateZip = [organization.city, organization.state, organization.zip]
    .filter(Boolean)
    .join(', ');

  const awardAmount = grant.award_ceiling || grant.award_floor || grant.typical_award;
  const formattedAwardAmount = awardAmount ? `$${awardAmount.toLocaleString()}` : 'Not specified';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${grant.title} - Application</title>
  <style>
    @page {
      margin: 1in;
    }
    body {
      font-family: 'Times New Roman', Times, serif;
      font-size: 12pt;
      line-height: 1.6;
      margin: 0;
      padding: 0;
      color: #000;
    }
    h1 {
      font-size: 16pt;
      font-weight: bold;
      text-align: center;
      margin-bottom: 24pt;
      text-transform: uppercase;
      border-bottom: 2px solid #000;
      padding-bottom: 12pt;
    }
    h2 {
      font-size: 14pt;
      font-weight: bold;
      margin-top: 24pt;
      margin-bottom: 12pt;
      text-transform: uppercase;
      border-bottom: 1px solid #000;
      padding-bottom: 6pt;
    }
    h3 {
      font-size: 12pt;
      font-weight: bold;
      margin-top: 18pt;
      margin-bottom: 6pt;
    }
    p {
      margin: 0 0 12pt 0;
      text-align: justify;
    }
    .header-block {
      text-align: center;
      margin-bottom: 36pt;
      border: 2px solid #000;
      padding: 18pt;
    }
    .page-break {
      page-break-after: always;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12pt 0;
    }
    td {
      padding: 6pt;
      vertical-align: top;
    }
    .label {
      font-weight: bold;
      width: 200px;
    }
    ul {
      margin: 12pt 0;
      padding-left: 24pt;
    }
    li {
      margin-bottom: 6pt;
    }
  </style>
</head>
<body>

  <div class="header-block">
    <h1>${grant.title}</h1>
    <p style="font-size: 14pt; margin: 12pt 0;"><strong>APPLICATION FOR: ${organization.name.toUpperCase()}</strong></p>
    <p style="font-size: 12pt;"><strong>SUBMITTED TO: ${grant.funder.toUpperCase()}</strong></p>
    <p style="font-size: 12pt;"><strong>DATE: ${formattedDate}</strong></p>
  </div>

  ${sections.length > 0 || requirements.filter(r => r.draft_content).length > 0 ? `
  <h2>Table of Contents</h2>
  <ul>
    ${sections.sort((a, b) => ((a.data || a).section_order || 0) - ((b.data || b).section_order || 0)).map((section, index) => {
      const sectionData = section.data || section;
      return `<li>${index + 1}. ${sectionData.section_name || section.section_name || 'Untitled Section'}</li>`;
    }).join('')}
    ${requirements.filter(r => r.draft_content).map((req, index) => {
      return `<li>${sections.length + index + 1}. ${req.requirement_name}</li>`;
    }).join('')}
  </ul>
  ` : ''}

  <h2>Executive Summary</h2>
  <table>
    <tr>
      <td class="label">Applicant:</td>
      <td>${organization.name}</td>
    </tr>
    <tr>
      <td class="label">Program:</td>
      <td>${grant.title}</td>
    </tr>
    <tr>
      <td class="label">Funder:</td>
      <td>${grant.funder}</td>
    </tr>
    ${awardAmount ? `
    <tr>
      <td class="label">Award Amount:</td>
      <td>${formattedAwardAmount}</td>
    </tr>
    ` : ''}
    ${grant.deadline ? `
    <tr>
      <td class="label">Deadline:</td>
      <td>${new Date(grant.deadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
    </tr>
    ` : ''}
  </table>
  
  ${(organization.mission || formData.organization_mission) ? `
  <h3>Mission Statement</h3>
  <p>${(formData.organization_mission || organization.mission || '').replace(/\n/g, '</p><p>')}</p>
  ` : ''}

  ${formData.executive_summary ? `
  <h2>Executive Summary</h2>
  <p>${formData.executive_summary.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.problem_statement ? `
  <h2>Problem Statement / Need</h2>
  <p>${formData.problem_statement.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.project_goals ? `
  <h2>Project Goals & Objectives</h2>
  <p>${formData.project_goals.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.outcomes ? `
  <h2>Expected Outcomes & Impact</h2>
  <p>${formData.outcomes.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.organization_history ? `
  <h2>Organizational Background</h2>
  <p>${formData.organization_history.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.organizational_capacity ? `
  <h2>Organizational Capacity</h2>
  <p>${formData.organizational_capacity.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.past_relevant_projects ? `
  <h2>Past Relevant Projects</h2>
  <p>${formData.past_relevant_projects.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.target_population ? `
  <h2>Target Population</h2>
  <p>${formData.target_population.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.geographic_service_area ? `
  <h2>Geographic Service Area</h2>
  <p>${formData.geographic_service_area.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.budget_narrative ? `
  <h2>Budget Narrative</h2>
  <p>${formData.budget_narrative.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.sustainability_plan ? `
  <h2>Sustainability Plan</h2>
  <p>${formData.sustainability_plan.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  ${formData.evaluation_plan ? `
  <h2>Evaluation Plan</h2>
  <p>${formData.evaluation_plan.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  ` : ''}

  <div class="page-break"></div>

  ${sections.filter(s => {
    const sectionData = s.data || s;
    return sectionData.draft_content && sectionData.draft_content.trim().length > 0;
  }).sort((a, b) => ((a.data || a).section_order || 0) - ((b.data || b).section_order || 0)).map(section => {
    const sectionData = section.data || section;
    const sectionName = sectionData.section_name || section.section_name || 'Untitled Section';
    const requirements = sectionData.requirements || section.requirements;
    const draftContent = sectionData.draft_content || section.draft_content;

    return `
    <h2>${sectionName}</h2>
    ${requirements ? `<p style="font-style: italic; color: #666;">[Requirements: ${requirements}]</p>` : ''}
    <p>${draftContent.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  `;
  }).join('')}

  ${requirements.filter(r => r.draft_content && ['oration_manuscript', 'essay', 'personal_statement', 'custom_field'].includes(r.requirement_type)).map(req => {
    return `
    <div class="page-break"></div>
    <h2>${req.requirement_name}</h2>
    ${req.word_limit ? `<p style="font-style: italic; color: #666; font-size: 10pt;">Word Limit: ${req.word_limit} words | Actual: ${req.draft_content.split(/\s+/).length} words</p>` : ''}
    ${req.notes ? `<p style="font-style: italic; color: #666; font-size: 10pt; margin-bottom: 12pt;">${req.notes}</p>` : ''}
    <p>${req.draft_content.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
  `;
  }).join('')}

  <div class="page-break"></div>

  <h2>Applicant Information</h2>
  <table>
    <tr>
      <td class="label">Legal Name:</td>
      <td>${organization.name}</td>
    </tr>
    ${organization.ein ? `
    <tr>
      <td class="label">EIN:</td>
      <td>${organization.ein}</td>
    </tr>
    ` : ''}
    ${organization.uei ? `
    <tr>
      <td class="label">UEI:</td>
      <td>${organization.uei}</td>
    </tr>
    ` : ''}
    <tr>
      <td class="label">Applicant Type:</td>
      <td>${organization.applicant_type?.replace(/_/g, ' ') || 'N/A'}</td>
    </tr>
    ${organization.address || cityStateZip ? `
    <tr>
      <td class="label">Address:</td>
      <td>
        ${organization.address ? `${organization.address}<br>` : ''}
        ${cityStateZip}
      </td>
    </tr>
    ` : ''}
    ${primaryEmail ? `
    <tr>
      <td class="label">Email:</td>
      <td>${primaryEmail}</td>
    </tr>
    ` : ''}
    ${primaryPhone ? `
    <tr>
      <td class="label">Phone:</td>
      <td>${primaryPhone}</td>
    </tr>
    ` : ''}
    ${organization.website ? `
    <tr>
      <td class="label">Website:</td>
      <td>${organization.website}</td>
    </tr>
    ` : ''}
  </table>

  ${['high_school_student', 'college_student', 'graduate_student'].includes(organization.applicant_type) ? `
  <h3>Academic Information</h3>
  <table>
    ${organization.student_grade_levels?.length ? `
    <tr>
      <td class="label">Grade Level(s):</td>
      <td>${organization.student_grade_levels.join(', ').replace(/_/g, ' ')}</td>
    </tr>
    ` : ''}
    ${organization.gpa ? `
    <tr>
      <td class="label">GPA:</td>
      <td>${organization.gpa}</td>
    </tr>
    ` : ''}
    ${organization.act_score ? `
    <tr>
      <td class="label">ACT Score:</td>
      <td>${organization.act_score}</td>
    </tr>
    ` : ''}
    ${organization.sat_score ? `
    <tr>
      <td class="label">SAT Score:</td>
      <td>${organization.sat_score}</td>
    </tr>
    ` : ''}
    ${organization.intended_major ? `
    <tr>
      <td class="label">Intended Major:</td>
      <td>${organization.intended_major}</td>
    </tr>
    ` : ''}
    ${organization.first_generation ? `
    <tr>
      <td class="label">First-Generation:</td>
      <td>Yes</td>
    </tr>
    ` : ''}
    ${organization.community_service_hours ? `
    <tr>
      <td class="label">Community Service:</td>
      <td>${organization.community_service_hours} hours</td>
    </tr>
    ` : ''}
  </table>
  ` : ''}

  ${organization.applicant_type === 'organization' ? `
  <h3>Organization Details</h3>
  <table>
    ${organization.nonprofit_type ? `
    <tr>
      <td class="label">Organization Type:</td>
      <td>${organization.nonprofit_type}</td>
    </tr>
    ` : ''}
    ${organization.annual_budget ? `
    <tr>
      <td class="label">Annual Budget:</td>
      <td>$${organization.annual_budget.toLocaleString()}</td>
    </tr>
    ` : ''}
    ${organization.staff_count ? `
    <tr>
      <td class="label">Staff Count:</td>
      <td>${organization.staff_count}</td>
    </tr>
    ` : ''}
    ${organization.sam_registered ? `
    <tr>
      <td class="label">SAM.gov Registered:</td>
      <td>Yes</td>
    </tr>
    ` : ''}
    ${organization.faith_based ? `
    <tr>
      <td class="label">Faith-Based:</td>
      <td>Yes</td>
    </tr>
    ` : ''}
  </table>
  ` : ''}

  <h2>Submission Information</h2>
  <table>
    <tr>
      <td class="label">Submission Date:</td>
      <td>${formattedDate}</td>
    </tr>
    <tr>
      <td class="label">Submission Method:</td>
      <td>Self-Upload (Downloaded Document)</td>
    </tr>
    ${contactInfo.recipientEmail ? `
    <tr>
      <td class="label">Funder Email:</td>
      <td>${contactInfo.recipientEmail}</td>
    </tr>
    ` : ''}
    ${contactInfo.recipientPhone ? `
    <tr>
      <td class="label">Funder Phone:</td>
      <td>${contactInfo.recipientPhone}</td>
    </tr>
    ` : ''}
    ${contactInfo.recipientFax ? `
    <tr>
      <td class="label">Funder Fax:</td>
      <td>${contactInfo.recipientFax}</td>
    </tr>
    ` : ''}
    ${contactInfo.recipientAddress ? `
    <tr>
      <td class="label">Funder Address:</td>
      <td>${contactInfo.recipientAddress.split('\n').join('<br>')}</td>
    </tr>
    ` : ''}
    ${grant.url ? `
    <tr>
      <td class="label">Application Portal:</td>
      <td>${grant.url}</td>
    </tr>
    ` : ''}
  </table>

  <p style="text-align: center; margin-top: 48pt; font-weight: bold;">*** END OF APPLICATION ***</p>

</body>
</html>
  `;
};