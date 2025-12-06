import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, MapPin, Phone, Mail, Globe, Printer, Users, Calendar, CheckCircle, XCircle, ExternalLink, Music, Trophy, Mic2, Palette, GraduationCap } from 'lucide-react';

// Build interest-specific queries based on student activities
function buildInterestQueries(activities) {
  if (!activities || activities.length === 0) return '';
  
  const queries = [];
  const activitiesLower = activities.map(a => a.toLowerCase());
  
  if (activitiesLower.some(a => a.includes('band') || a.includes('music') || a.includes('orchestra') || a.includes('choir') || a.includes('marching'))) {
    queries.push(`
6. MUSIC/BAND PROGRAM (IMPORTANT - Student is interested in music):
   - School of Music or Music Department contact info (director name, email, phone)
   - Marching band director name and contact
   - Band/Music scholarship opportunities
   - Audition requirements and dates
   - Ensemble participation opportunities`);
  }
  
  if (activitiesLower.some(a => a.includes('forensic') || a.includes('debate') || a.includes('speech') || a.includes('model un'))) {
    queries.push(`
7. FORENSICS/SPEECH & DEBATE (IMPORTANT - Student is interested in forensics/debate):
   - Speech and Debate team information
   - Team coach/director name and contact
   - Forensics scholarships available
   - Competition schedule and opportunities
   - Tryout/audition information`);
  }
  
  if (activitiesLower.some(a => a.includes('theater') || a.includes('theatre') || a.includes('drama') || a.includes('acting'))) {
    queries.push(`
8. THEATER/DRAMA (IMPORTANT - Student is interested in theater):
   - Theater department contact information
   - Drama scholarships available
   - Audition requirements
   - Production opportunities`);
  }
  
  if (activitiesLower.some(a => a.includes('sport') || a.includes('athletic') || a.includes('intramural'))) {
    queries.push(`
9. INTRAMURAL SPORTS (IMPORTANT - Student interested in intramurals):
   - Full list of intramural sports offered
   - Club sports teams and contacts
   - Recreation center information`);
  }
  
  if (activitiesLower.some(a => a.includes('art') || a.includes('paint') || a.includes('draw') || a.includes('photo') || a.includes('design'))) {
    queries.push(`
10. VISUAL ARTS (IMPORTANT - Student is interested in art):
    - Art department contact information  
    - Portfolio requirements
    - Art scholarships available`);
  }

  return queries.join('\n');
}

function getInterestIcon(interest) {
  const lower = interest?.toLowerCase() || '';
  if (lower.includes('music') || lower.includes('band')) return <Music className="w-4 h-4" />;
  if (lower.includes('forensic') || lower.includes('debate') || lower.includes('speech')) return <Mic2 className="w-4 h-4" />;
  if (lower.includes('sport') || lower.includes('intramural') || lower.includes('athletic')) return <Trophy className="w-4 h-4" />;
  if (lower.includes('art') || lower.includes('theater') || lower.includes('theatre')) return <Palette className="w-4 h-4" />;
  return <GraduationCap className="w-4 h-4" />;
}

export default function UniversityDetailDialog({ application, open, onOpenChange, studentInterests = [] }) {
  // Build interest-specific query parts
  const interestQueries = buildInterestQueries(studentInterests);
  
  const { data: details, isLoading } = useQuery({
    queryKey: ['universityDetails', application?.university_name, studentInterests.join(',')],
    queryFn: async () => {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `Research ${application.university_name} and provide comprehensive admissions information:

1. Contact Information:
   - Full mailing address (street, city, state, zip)
   - Main admissions phone number
   - Admissions fax number
   - Admissions email
   - Website URL

2. Admissions Office Personnel (if findable):
   - Dean of Admissions name
   - Director of Admissions name
   - Any other key contacts

3. Application Details:
   - Does this school accept the Common Application? (yes/no)
   - Does this school accept the Coalition Application? (yes/no)
   - Direct application URL
   - Application deadlines for each type (Early Decision, Early Action, Regular Decision)
   - Decision notification dates if known

4. Quick Facts:
   - Acceptance rate (percentage)
   - Average GPA of admitted students
   - Average SAT/ACT scores
   - Tuition (in-state and out-of-state if applicable)

5. Intramural & Club Sports:
   - Available intramural sports programs
   - Club sports teams available
   - Recreational facilities

${interestQueries}

Return accurate, current information.`,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          properties: {
            contact: {
              type: "object",
              properties: {
                address: { type: "string" },
                city: { type: "string" },
                state: { type: "string" },
                zip: { type: "string" },
                phone: { type: "string" },
                fax: { type: "string" },
                email: { type: "string" },
                website: { type: "string" }
              }
            },
            personnel: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  title: { type: "string" },
                  email: { type: "string" }
                }
              }
            },
            applications: {
              type: "object",
              properties: {
                accepts_common_app: { type: "boolean" },
                accepts_coalition: { type: "boolean" },
                direct_url: { type: "string" },
                deadlines: {
                  type: "object",
                  properties: {
                    early_decision: { type: "string" },
                    early_decision_2: { type: "string" },
                    early_action: { type: "string" },
                    regular_decision: { type: "string" }
                  }
                },
                notification_dates: {
                  type: "object",
                  properties: {
                    early_decision: { type: "string" },
                    early_action: { type: "string" },
                    regular_decision: { type: "string" }
                  }
                }
              }
            },
            stats: {
              type: "object",
              properties: {
                acceptance_rate: { type: "string" },
                average_gpa: { type: "string" },
                sat_range: { type: "string" },
                act_range: { type: "string" },
                tuition_in_state: { type: "string" },
                tuition_out_of_state: { type: "string" }
              }
            },
            intramurals: {
              type: "object",
              properties: {
                sports_available: { type: "array", items: { type: "string" } },
                club_sports: { type: "array", items: { type: "string" } },
                recreation_url: { type: "string" }
              }
            },
            interest_departments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  interest_area: { type: "string" },
                  department_name: { type: "string" },
                  contact_name: { type: "string" },
                  contact_title: { type: "string" },
                  contact_email: { type: "string" },
                  contact_phone: { type: "string" },
                  department_url: { type: "string" },
                  scholarships: { type: "array", items: { type: "string" } },
                  audition_info: { type: "string" },
                  tryout_info: { type: "string" },
                  notes: { type: "string" }
                }
              }
            }
          }
        }
      });
      return response;
    },
    enabled: open && !!application?.university_name,
    staleTime: 1000 * 60 * 30 // Cache for 30 minutes
  });

  if (!application) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">{application.university_name}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
            <span className="ml-3 text-slate-600">Loading university details...</span>
          </div>
        ) : details ? (
          <div className="space-y-6">
            {/* Contact Information */}
            <section>
              <h3 className="font-semibold text-sm text-slate-500 uppercase tracking-wide mb-3">
                Contact Information
              </h3>
              <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                {details.contact?.address && (
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 text-slate-400 mt-0.5" />
                    <div className="text-sm">
                      <p>{details.contact.address}</p>
                      <p>{details.contact.city}, {details.contact.state} {details.contact.zip}</p>
                    </div>
                  </div>
                )}
                {details.contact?.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4 text-slate-400" />
                    <a href={`tel:${details.contact.phone}`} className="text-sm text-blue-600 hover:underline">
                      {details.contact.phone}
                    </a>
                  </div>
                )}
                {details.contact?.fax && (
                  <div className="flex items-center gap-2">
                    <Printer className="w-4 h-4 text-slate-400" />
                    <span className="text-sm">Fax: {details.contact.fax}</span>
                  </div>
                )}
                {details.contact?.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-slate-400" />
                    <a href={`mailto:${details.contact.email}`} className="text-sm text-blue-600 hover:underline">
                      {details.contact.email}
                    </a>
                  </div>
                )}
                {details.contact?.website && (
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-slate-400" />
                    <a href={details.contact.website} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline">
                      {details.contact.website}
                    </a>
                  </div>
                )}
              </div>
            </section>

            {/* Admissions Personnel */}
            {details.personnel?.length > 0 && (
              <section>
                <h3 className="font-semibold text-sm text-slate-500 uppercase tracking-wide mb-3">
                  Admissions Office
                </h3>
                <div className="space-y-2">
                  {details.personnel.map((person, idx) => (
                    <div key={idx} className="flex items-center gap-3 bg-slate-50 rounded-lg p-3">
                      <Users className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-sm font-medium">{person.name}</p>
                        <p className="text-xs text-slate-500">{person.title}</p>
                        {person.email && (
                          <a href={`mailto:${person.email}`} className="text-xs text-blue-600 hover:underline">
                            {person.email}
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Application Platforms */}
            <section>
              <h3 className="font-semibold text-sm text-slate-500 uppercase tracking-wide mb-3">
                Application Platforms
              </h3>
              <div className="flex flex-wrap gap-2">
                <Badge className={details.applications?.accepts_common_app ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-500'}>
                  {details.applications?.accepts_common_app ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  Common App
                </Badge>
                <Badge className={details.applications?.accepts_coalition ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-500'}>
                  {details.applications?.accepts_coalition ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  Coalition App
                </Badge>
                {details.applications?.direct_url && (
                  <Button size="sm" variant="outline" className="h-6 text-xs gap-1" onClick={() => window.open(details.applications.direct_url, '_blank')}>
                    <ExternalLink className="w-3 h-3" />
                    Direct Apply
                  </Button>
                )}
              </div>
            </section>

            {/* Deadlines */}
            {details.applications?.deadlines && (
              <section>
                <h3 className="font-semibold text-sm text-slate-500 uppercase tracking-wide mb-3">
                  Application Deadlines
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {details.applications.deadlines.early_decision && (
                    <div className="bg-purple-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-purple-700">Early Decision</p>
                      <p className="text-sm font-semibold">{details.applications.deadlines.early_decision}</p>
                      {details.applications.notification_dates?.early_decision && (
                        <p className="text-xs text-slate-500 mt-1">Decision: {details.applications.notification_dates.early_decision}</p>
                      )}
                    </div>
                  )}
                  {details.applications.deadlines.early_decision_2 && (
                    <div className="bg-purple-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-purple-700">Early Decision II</p>
                      <p className="text-sm font-semibold">{details.applications.deadlines.early_decision_2}</p>
                    </div>
                  )}
                  {details.applications.deadlines.early_action && (
                    <div className="bg-blue-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-blue-700">Early Action</p>
                      <p className="text-sm font-semibold">{details.applications.deadlines.early_action}</p>
                      {details.applications.notification_dates?.early_action && (
                        <p className="text-xs text-slate-500 mt-1">Decision: {details.applications.notification_dates.early_action}</p>
                      )}
                    </div>
                  )}
                  {details.applications.deadlines.regular_decision && (
                    <div className="bg-slate-100 rounded-lg p-3">
                      <p className="text-xs font-medium text-slate-700">Regular Decision</p>
                      <p className="text-sm font-semibold">{details.applications.deadlines.regular_decision}</p>
                      {details.applications.notification_dates?.regular_decision && (
                        <p className="text-xs text-slate-500 mt-1">Decision: {details.applications.notification_dates.regular_decision}</p>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Quick Stats */}
            {details.stats && (
              <section>
                <h3 className="font-semibold text-sm text-slate-500 uppercase tracking-wide mb-3">
                  Quick Facts
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {details.stats.acceptance_rate && (
                    <div className="text-center bg-slate-50 rounded-lg p-3">
                      <p className="text-lg font-bold text-blue-600">{details.stats.acceptance_rate}</p>
                      <p className="text-xs text-slate-500">Acceptance Rate</p>
                    </div>
                  )}
                  {details.stats.average_gpa && (
                    <div className="text-center bg-slate-50 rounded-lg p-3">
                      <p className="text-lg font-bold text-green-600">{details.stats.average_gpa}</p>
                      <p className="text-xs text-slate-500">Avg GPA</p>
                    </div>
                  )}
                  {details.stats.sat_range && (
                    <div className="text-center bg-slate-50 rounded-lg p-3">
                      <p className="text-lg font-bold text-purple-600">{details.stats.sat_range}</p>
                      <p className="text-xs text-slate-500">SAT Range</p>
                    </div>
                  )}
                  {details.stats.act_range && (
                    <div className="text-center bg-slate-50 rounded-lg p-3">
                      <p className="text-lg font-bold text-orange-600">{details.stats.act_range}</p>
                      <p className="text-xs text-slate-500">ACT Range</p>
                    </div>
                  )}
                  {details.stats.tuition_in_state && (
                    <div className="text-center bg-slate-50 rounded-lg p-3">
                      <p className="text-lg font-bold text-slate-700">{details.stats.tuition_in_state}</p>
                      <p className="text-xs text-slate-500">In-State Tuition</p>
                    </div>
                  )}
                  {details.stats.tuition_out_of_state && (
                    <div className="text-center bg-slate-50 rounded-lg p-3">
                      <p className="text-lg font-bold text-slate-700">{details.stats.tuition_out_of_state}</p>
                      <p className="text-xs text-slate-500">Out-of-State Tuition</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Interest-Based Department Info */}
            {details.interest_departments?.length > 0 && (
              <section>
                <h3 className="font-semibold text-sm text-slate-500 uppercase tracking-wide mb-3">
                  🎯 Based on Your Interests
                </h3>
                <div className="space-y-3">
                  {details.interest_departments.map((dept, idx) => (
                    <div key={idx} className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-100">
                      <div className="flex items-center gap-2 mb-2">
                        {getInterestIcon(dept.interest_area)}
                        <h4 className="font-semibold text-blue-900">{dept.interest_area}</h4>
                      </div>
                      <p className="text-sm font-medium text-slate-700 mb-2">{dept.department_name}</p>
                      
                      {/* Contact Info */}
                      {(dept.contact_name || dept.contact_email || dept.contact_phone) && (
                        <div className="bg-white rounded p-2 mb-2 space-y-1">
                          {dept.contact_name && (
                            <p className="text-sm"><span className="text-slate-500">Contact:</span> {dept.contact_name} {dept.contact_title && `(${dept.contact_title})`}</p>
                          )}
                          {dept.contact_email && (
                            <a href={`mailto:${dept.contact_email}`} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                              <Mail className="w-3 h-3" /> {dept.contact_email}
                            </a>
                          )}
                          {dept.contact_phone && (
                            <a href={`tel:${dept.contact_phone}`} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                              <Phone className="w-3 h-3" /> {dept.contact_phone}
                            </a>
                          )}
                        </div>
                      )}
                      
                      {/* Scholarships */}
                      {dept.scholarships?.length > 0 && (
                        <div className="mb-2">
                          <p className="text-xs font-semibold text-green-700 mb-1">💰 Scholarships Available:</p>
                          <ul className="text-xs text-slate-600 space-y-0.5 pl-3">
                            {dept.scholarships.map((s, i) => (
                              <li key={i}>• {s}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      
                      {/* Audition/Tryout Info */}
                      {(dept.audition_info || dept.tryout_info) && (
                        <p className="text-xs text-purple-700 bg-purple-50 p-2 rounded">
                          📋 {dept.audition_info || dept.tryout_info}
                        </p>
                      )}
                      
                      {dept.department_url && (
                        <Button size="sm" variant="outline" className="mt-2 h-6 text-xs gap-1" onClick={() => window.open(dept.department_url, '_blank')}>
                          <ExternalLink className="w-3 h-3" /> Visit Department
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Intramurals & Club Sports */}
            {details.intramurals && (details.intramurals.sports_available?.length > 0 || details.intramurals.club_sports?.length > 0) && (
              <section>
                <h3 className="font-semibold text-sm text-slate-500 uppercase tracking-wide mb-3">
                  <Trophy className="w-4 h-4 inline mr-1" /> Intramurals & Club Sports
                </h3>
                <div className="bg-green-50 rounded-lg p-4 border border-green-100">
                  {details.intramurals.sports_available?.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs font-semibold text-green-700 mb-2">Intramural Sports:</p>
                      <div className="flex flex-wrap gap-1">
                        {details.intramurals.sports_available.map((sport, i) => (
                          <Badge key={i} variant="outline" className="bg-white text-xs">{sport}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {details.intramurals.club_sports?.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs font-semibold text-blue-700 mb-2">Club Sports:</p>
                      <div className="flex flex-wrap gap-1">
                        {details.intramurals.club_sports.map((sport, i) => (
                          <Badge key={i} variant="outline" className="bg-white text-xs">{sport}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {details.intramurals.recreation_url && (
                    <Button size="sm" variant="outline" className="h-6 text-xs gap-1" onClick={() => window.open(details.intramurals.recreation_url, '_blank')}>
                      <ExternalLink className="w-3 h-3" /> Recreation Center
                    </Button>
                  )}
                </div>
              </section>
            )}
          </div>
        ) : (
          <p className="text-center text-slate-500 py-8">Unable to load details</p>
        )}
      </DialogContent>
    </Dialog>
  );
}