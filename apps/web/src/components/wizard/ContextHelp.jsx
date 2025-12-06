import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { HelpCircle, Lightbulb, BookOpen, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * Context-Sensitive Help Panel
 * Provides tips, examples, and resources for each step
 */
export default function ContextHelp({ stepId, grant, organization }) {
  const [expandedSections, setExpandedSections] = useState(['tips']);

  const toggleSection = (section) => {
    setExpandedSections(prev =>
      prev.includes(section)
        ? prev.filter(s => s !== section)
        : [...prev, section]
    );
  };

  const helpContent = {
    basic: {
      tips: [
        'Use a clear, descriptive project title that reflects your goals',
        'Request an amount that matches your actual needs and the grant range',
        'Keep your executive summary concise - 2-3 sentences maximum',
        'Ensure contact information is for someone who can answer questions'
      ],
      examples: (() => {
        // Generate contextual examples based on grant info
        const grantTitle = grant?.title?.toLowerCase() || '';
        const applicantType = organization?.applicant_type || '';
        
        // Music/Arts grants
        if (grantTitle.includes('music') || grantTitle.includes('concerto') || grantTitle.includes('arts') || grantTitle.includes('performance')) {
          return [
            {
              title: 'Good Project Title',
              content: `"${organization?.name || 'Student'} Concerto Competition Entry and Professional Development"`,
              why: 'Specific, action-oriented, and clearly states the project'
            },
            {
              title: 'Poor Project Title',
              content: '"Music Project"',
              why: 'Too vague, doesn\'t explain what you\'re doing'
            }
          ];
        }
        
        // Student scholarships
        if (applicantType?.includes('student') || grantTitle.includes('scholarship')) {
          return [
            {
              title: 'Good Project Title',
              content: '"Academic Year 2025-26 Tuition and Educational Expenses"',
              why: 'Clear timeframe and purpose for funding'
            },
            {
              title: 'Poor Project Title',
              content: '"College Expenses"',
              why: 'Too generic, lacks specificity'
            }
          ];
        }
        
        // Individual assistance
        if (applicantType?.includes('individual') || grantTitle.includes('assistance')) {
          return [
            {
              title: 'Good Project Title',
              content: '"Medical Equipment and Accessibility Improvements"',
              why: 'Specific items and clear benefit'
            },
            {
              title: 'Poor Project Title',
              content: '"Help with Bills"',
              why: 'Vague and unprofessional'
            }
          ];
        }
        
        // Default for organizations
        return [
          {
            title: 'Good Project Title',
            content: '"Mobile Health Clinic Expansion for Rural Communities"',
            why: 'Specific, action-oriented, and clearly states the project'
          },
          {
            title: 'Poor Project Title',
            content: '"Community Health Project"',
            why: 'Too vague, doesn\'t explain what you\'re doing'
          }
        ];
      })(),
      resources: [
        { title: 'Grant Writing Tips', url: '#' },
        { title: 'Budget Planning Guide', url: '#' }
      ]
    },
    narrative: {
      tips: [
        'Start with compelling data or a real story to illustrate the problem',
        'Use SMART goals (Specific, Measurable, Achievable, Relevant, Time-bound)',
        'Explain your methods clearly - what, when, who, how',
        'Show how you\'ll measure success with specific metrics'
      ],
      examples: [
        {
          title: 'Strong Problem Statement',
          content: '"In our county, 45% of families lack reliable transportation to medical appointments, resulting in a 60% increase in emergency room visits..."',
          why: 'Uses specific data and shows clear consequences'
        }
      ],
      resources: [
        { title: 'Writing Effective Narratives', url: '#' },
        { title: 'Logic Model Guide', url: '#' }
      ]
    },
    budget: {
      tips: [
        'Every expense should have a clear justification',
        'Personnel costs are typically the largest category',
        'Include fringe benefits (usually 25-30% of salary)',
        'Be realistic - underestimating costs hurts your credibility'
      ],
      examples: [
        {
          title: 'Good Justification',
          content: '"Project Manager (0.5 FTE): Needed to coordinate partners, manage timeline, and ensure deliverables are met"',
          why: 'Explains specific responsibilities and why role is needed'
        }
      ],
      resources: [
        { title: 'Federal Budget Guidelines', url: '#' },
        { title: 'Indirect Cost Rates', url: '#' }
      ]
    },
    organization: {
      tips: [
        'Verify all IDs (EIN, UEI, CAGE) are current and correct',
        'Use the exact legal name from your IRS determination letter',
        'Ensure contact information is for authorized signatories',
        'Highlight your organization\'s relevant experience'
      ],
      examples: [],
      resources: [
        { title: 'SAM.gov Registration', url: 'https://sam.gov' },
        { title: 'UEI Lookup', url: 'https://sam.gov/content/entity-information' }
      ]
    },
    attachments: {
      tips: [
        'Scan documents at high quality (300 DPI minimum)',
        'Use PDF format for all documents when possible',
        'Name files clearly (e.g., "OrganizationName_IRS_Letter.pdf")',
        'Keep file sizes reasonable (under 10MB each)'
      ],
      examples: [],
      resources: [
        { title: 'Document Requirements Guide', url: '#' }
      ]
    }
  };

  const content = helpContent[stepId] || { tips: [], examples: [], resources: [] };

  return (
    <div className="space-y-4">
      {/* Tips Section */}
      <Card className="bg-blue-50 border-blue-200">
        <CardHeader 
          className="cursor-pointer"
          onClick={() => toggleSection('tips')}
        >
          <CardTitle className="flex items-center justify-between text-blue-900 text-sm">
            <div className="flex items-center gap-2">
              <Lightbulb className="w-4 h-4" />
              Quick Tips
            </div>
            {expandedSections.includes('tips') ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </CardTitle>
        </CardHeader>
        {expandedSections.includes('tips') && (
          <CardContent className="pt-0">
            <ul className="space-y-2">
              {content.tips.map((tip, index) => (
                <li key={index} className="flex items-start gap-2 text-sm text-blue-900">
                  <span className="text-blue-600 mt-1">•</span>
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      {/* Examples Section */}
      {content.examples.length > 0 && (
        <Card className="bg-purple-50 border-purple-200">
          <CardHeader 
            className="cursor-pointer"
            onClick={() => toggleSection('examples')}
          >
            <CardTitle className="flex items-center justify-between text-purple-900 text-sm">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4" />
                Examples
              </div>
              {expandedSections.includes('examples') ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </CardTitle>
          </CardHeader>
          {expandedSections.includes('examples') && (
            <CardContent className="pt-0 space-y-4">
              {content.examples.map((example, index) => (
                <div key={index} className="p-3 bg-white rounded-lg border border-purple-200">
                  <p className="font-semibold text-sm text-purple-900 mb-1">
                    {example.title}
                  </p>
                  <p className="text-sm text-slate-700 italic mb-2">
                    "{example.content}"
                  </p>
                  <p className="text-xs text-slate-600">
                    <strong>Why it works:</strong> {example.why}
                  </p>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {/* Resources Section */}
      {content.resources.length > 0 && (
        <Card className="bg-green-50 border-green-200">
          <CardHeader 
            className="cursor-pointer"
            onClick={() => toggleSection('resources')}
          >
            <CardTitle className="flex items-center justify-between text-green-900 text-sm">
              <div className="flex items-center gap-2">
                <ExternalLink className="w-4 h-4" />
                Resources
              </div>
              {expandedSections.includes('resources') ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </CardTitle>
          </CardHeader>
          {expandedSections.includes('resources') && (
            <CardContent className="pt-0">
              <div className="space-y-2">
                {content.resources.map((resource, index) => (
                  <a
                    key={index}
                    href={resource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-green-800 hover:text-green-900 hover:underline"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {resource.title}
                  </a>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}