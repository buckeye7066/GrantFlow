import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { CheckCircle2, FileText, Send, DollarSign } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';

const APPLICATION_TYPES = [
  { id: 'basic_profile', name: 'Basic Profile Setup', description: 'Initial profile creation and basic grant research', monthlyFee: 149, oneTime: true },
  { id: 'private_foundation', name: 'Private Foundation Grant', description: 'Application to private foundation (typically 5-10 pages)', monthlyFee: 600, range: [600, 1200] },
  { id: 'corporate_grant', name: 'Corporate Grant', description: 'Corporate giving application with alignment documentation', monthlyFee: 800, range: [800, 1500] },
  { id: 'federal_grant', name: 'Federal Grant Application', description: 'Complex federal application (HHS, NIH, DOJ, etc.)', monthlyFee: 2500, range: [2500, 8000] },
  { id: 'state_local', name: 'State / Local Grant', description: 'State or municipal grant application', monthlyFee: 1200, range: [1200, 3000] },
  { id: 'nonprofit_formation', name: 'Nonprofit Formation (501(c)(3))', description: 'Complete IRS 1023 application and state incorporation', monthlyFee: 3500, oneTime: true },
  { id: 'complex_multi', name: 'Complex Multi-Partner Application', description: 'Multi-agency or collaborative grant with multiple partners', monthlyFee: 5000, range: [5000, 12000] },
  { id: 'scholarship', name: 'Scholarship Application', description: 'Student scholarship application assistance', monthlyFee: 199, range: [99, 299] },
  { id: 'other', name: 'Other / Custom', description: 'Custom application support - pricing determined after consultation', monthlyFee: 0, custom: true }
];

export default function PublicApplication() {
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [agreed, setAgreed] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    organization_name: '',
    applicant_type: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    mission: '',
    project_summary: '',
    budget_summary: '',
    prior_funding: '',
    special_circumstances: ''
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleToggleType = (typeId) => {
    setSelectedTypes(prev =>
      prev.includes(typeId)
        ? prev.filter(id => id !== typeId)
        : [...prev, typeId]
    );
  };

  const handleSubmit = async () => {
    if (!formData.name || !formData.email || !formData.applicant_type) {
      setError('Please complete all required fields.');
      return;
    }

    if (selectedTypes.length === 0) {
      setError('Select at least one service before submitting.');
      return;
    }

    if (!agreed) {
      setError('You must agree to the billing terms before submitting.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const selectedServiceDetails = selectedTypes.map(typeId => {
        const type = APPLICATION_TYPES.find(t => t.id === typeId);
        return {
          id: type.id,
          name: type.name,
          monthlyFee: type.monthlyFee,
          range: type.range || null,
          oneTime: type.oneTime || false,
          custom: type.custom || false
        };
      });

      const submissionData = {
        ...formData,
        application_types: selectedServiceDetails,
        total_monthly_cost: calculateTotal()
      };

      const response = await base44.functions.invoke('submitPublicApplication', submissionData);

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Failed to submit application');
      }

      setSubmitted(true);
    } catch (err) {
      console.error('Submission error:', err);
      setError(err.message || 'Failed to submit application. Please try again.');
      toast({
        variant: 'destructive',
        title: 'Submission Failed',
        description: err.message || 'Failed to submit application',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const calculateTotal = () => {
    return selectedTypes.reduce((sum, typeId) => {
      const type = APPLICATION_TYPES.find(t => t.id === typeId);
      return sum + (type?.monthlyFee || 0);
    }, 0);
  };

  // Confirmation Screen
  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-6">
        <Card className="max-w-2xl w-full shadow-xl">
          <CardContent className="p-12 text-center">
            <CheckCircle2 className="w-16 h-16 text-green-600 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-slate-900 mb-2">
              Application Submitted Successfully!
            </h2>
            <p className="text-slate-600 mb-6">
              Thank you for submitting your application. We've received your information and created your GrantFlow profile.
              You'll receive an email confirmation at <strong>{formData.email}</strong>.
            </p>
            <div className="bg-blue-50 rounded-lg p-4 mb-6 border border-blue-200">
              <p className="text-sm text-slate-700 mb-2">
                <strong>Next Steps:</strong>
              </p>
              <p className="text-sm text-slate-600 mb-3">
                Dr. John White will reach out to you directly at <strong>Dr.JohnWhite@axiombiolabs.org</strong> within 1-2 business days to discuss your application and next steps.
              </p>
              <p className="text-xs text-slate-500">
                You'll receive weekly updates via email every Sunday evening with progress on your applications and detailed invoices.
              </p>
            </div>
            <p className="text-xs text-slate-500">
              Questions? Email Dr. John White at Dr.JohnWhite@axiombiolabs.org
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Main Application Screen
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
      {/* Header */}
      <div className="bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center">
              <FileText className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900">GrantFlow Application Portal</h1>
              <p className="text-slate-600">Professional Grant Writing Services</p>
            </div>
          </div>
        </div>
      </div>

      {/* Preview Section */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <Card className="mb-8 border-2 border-blue-200">
          <CardContent className="p-8">
            <h2 className="text-3xl font-bold text-slate-900 mb-6 text-center">What is GrantFlow?</h2>
            <p className="text-lg text-slate-700 mb-6 leading-relaxed text-center max-w-3xl mx-auto">
              GrantFlow is an AI-powered grant management platform that helps organizations, students, families, and individuals 
              discover and apply for funding opportunities. We automate research, match you with relevant grants, and provide 
              professional application assistance.
            </p>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              <div className="text-center p-4">
                <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mx-auto mb-3">
                  <CheckCircle2 className="w-6 h-6 text-blue-600" />
                </div>
                <h3 className="font-bold text-slate-900 mb-2">AI Discovery</h3>
                <p className="text-sm text-slate-600">Automated search across 50,000+ opportunities daily</p>
              </div>

              <div className="text-center p-4">
                <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mx-auto mb-3">
                  <CheckCircle2 className="w-6 h-6 text-green-600" />
                </div>
                <h3 className="font-bold text-slate-900 mb-2">Smart Matching</h3>
                <p className="text-sm text-slate-600">AI matches your profile to the best-fit opportunities</p>
              </div>

              <div className="text-center p-4">
                <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mx-auto mb-3">
                  <CheckCircle2 className="w-6 h-6 text-purple-600" />
                </div>
                <h3 className="font-bold text-slate-900 mb-2">Application Support</h3>
                <p className="text-sm text-slate-600">Professional writing, review, and submission assistance</p>
              </div>

              <div className="text-center p-4">
                <div className="w-12 h-12 bg-amber-100 rounded-lg flex items-center justify-center mx-auto mb-3">
                  <CheckCircle2 className="w-6 h-6 text-amber-600" />
                </div>
                <h3 className="font-bold text-slate-900 mb-2">Progress Tracking</h3>
                <p className="text-sm text-slate-600">Track applications, deadlines, and weekly updates</p>
              </div>
            </div>

            <div className="bg-blue-50 rounded-lg p-6 border border-blue-200">
              <h3 className="font-bold text-slate-900 mb-3 text-center">How It Works</h3>
              <div className="grid md:grid-cols-3 gap-6 text-center">
                <div>
                  <div className="w-10 h-10 bg-blue-600 text-white rounded-full flex items-center justify-center mx-auto mb-2 font-bold">1</div>
                  <p className="font-semibold text-slate-900 mb-1">Create Your Profile</p>
                  <p className="text-sm text-slate-600">Fill out the application below with your information</p>
                </div>
                <div>
                  <div className="w-10 h-10 bg-blue-600 text-white rounded-full flex items-center justify-center mx-auto mb-2 font-bold">2</div>
                  <p className="font-semibold text-slate-900 mb-1">AI Finds Opportunities</p>
                  <p className="text-sm text-slate-600">Our system searches and matches you with relevant grants</p>
                </div>
                <div>
                  <div className="w-10 h-10 bg-blue-600 text-white rounded-full flex items-center justify-center mx-auto mb-2 font-bold">3</div>
                  <p className="font-semibold text-slate-900 mb-1">Apply Together</p>
                  <p className="text-sm text-slate-600">We help prepare and submit your applications</p>
                </div>
              </div>
            </div>

            <div className="mt-6 text-center text-sm text-slate-600">
              <p className="font-semibold text-slate-900 mb-2">⚠️ Important Notice</p>
              <p>Services are billed monthly. Invoices sent weekly. <strong>Funding is NOT guaranteed</strong> regardless of application quality or effort.</p>
            </div>
          </CardContent>
        </Card>

        {/* Main Application Area */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Application Form - Left Side */}
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Application Form</CardTitle>
                <CardDescription>Fill out your information to get started</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="name">Full Name *</Label>
                    <Input id="name" value={formData.name} onChange={(e) => handleChange('name', e.target.value)} required />
                  </div>
                  <div>
                    <Label htmlFor="email">Email Address *</Label>
                    <Input id="email" type="email" value={formData.email} onChange={(e) => handleChange('email', e.target.value)} required />
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="phone">Phone Number</Label>
                    <Input id="phone" type="tel" value={formData.phone} onChange={(e) => handleChange('phone', e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="applicant_type">Applicant Type *</Label>
                    <Select value={formData.applicant_type} onValueChange={(value) => handleChange('applicant_type', value)}>
                      <SelectTrigger><SelectValue placeholder="Select type..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="organization">Organization / Nonprofit</SelectItem>
                        <SelectItem value="high_school_student">High School Student</SelectItem>
                        <SelectItem value="college_student">College Student</SelectItem>
                        <SelectItem value="graduate_student">Graduate Student</SelectItem>
                        <SelectItem value="individual_need">Individual in Need</SelectItem>
                        <SelectItem value="medical_assistance">Medical Assistance</SelectItem>
                        <SelectItem value="family">Family</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {formData.applicant_type === 'organization' && (
                  <div>
                    <Label htmlFor="organization_name">Organization Name</Label>
                    <Input id="organization_name" value={formData.organization_name} onChange={(e) => handleChange('organization_name', e.target.value)} />
                  </div>
                )}

                <div><Label htmlFor="address">Street Address</Label><Input id="address" value={formData.address} onChange={(e) => handleChange('address', e.target.value)} /></div>

                <div className="grid md:grid-cols-3 gap-4">
                  <div><Label htmlFor="city">City</Label><Input id="city" value={formData.city} onChange={(e) => handleChange('city', e.target.value)} /></div>
                  <div><Label htmlFor="state">State</Label><Input id="state" value={formData.state} onChange={(e) => handleChange('state', e.target.value)} maxLength={2} /></div>
                  <div><Label htmlFor="zip">ZIP Code</Label><Input id="zip" value={formData.zip} onChange={(e) => handleChange('zip', e.target.value)} maxLength={10} /></div>
                </div>

                <div><Label htmlFor="mission">Mission / Purpose</Label><Textarea id="mission" value={formData.mission} onChange={(e) => handleChange('mission', e.target.value)} rows={3} /></div>
                <div><Label htmlFor="project_summary">Project Summary</Label><Textarea id="project_summary" value={formData.project_summary} onChange={(e) => handleChange('project_summary', e.target.value)} rows={4} /></div>
                <div><Label htmlFor="special_circumstances">Special Circumstances</Label><Textarea id="special_circumstances" value={formData.special_circumstances} onChange={(e) => handleChange('special_circumstances', e.target.value)} rows={3} /></div>
              </CardContent>
            </Card>

            {/* Agreement */}
            <Card className="border-2 border-amber-300 bg-amber-50">
              <CardContent className="p-6">
                <label className="flex items-start gap-3 cursor-pointer">
                  <Checkbox checked={agreed} onCheckedChange={setAgreed} className="mt-1" />
                  <div className="flex-1">
                    <p className="font-semibold text-slate-900 mb-2">Required Agreement</p>
                    <p className="text-sm text-slate-700">
                      I understand that services are billed monthly, invoices are sent weekly, and <strong>funding is NOT guaranteed</strong> regardless of application quality.
                    </p>
                  </div>
                </label>
              </CardContent>
            </Card>

            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

            <Button onClick={handleSubmit} disabled={!agreed || !formData.name || !formData.email || !formData.applicant_type || selectedTypes.length === 0 || isSubmitting} size="lg" className="w-full bg-blue-600 hover:bg-blue-700 h-14 text-lg">
              {isSubmitting ? 'Submitting...' : <><Send className="w-5 h-5 mr-2" />Submit Application</>}
            </Button>
          </div>

          {/* Billing Calculator - Right Side */}
          <div className="lg:col-span-1">
            <div className="sticky top-6">
              <Card>
                <CardHeader className="bg-blue-50">
                  <CardTitle className="flex items-center gap-2"><DollarSign className="w-5 h-5" />Service Selection</CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {APPLICATION_TYPES.map((type) => (
                    <div key={type.id} className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${selectedTypes.includes(type.id) ? 'border-blue-600 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`} onClick={() => handleToggleType(type.id)}>
                      <div className="flex items-start gap-2">
                        <Checkbox checked={selectedTypes.includes(type.id)} className="mt-0.5 pointer-events-none" />
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-slate-900 text-sm mb-1">{type.name}</h3>
                          <p className="text-xs text-slate-600 mb-1">{type.description}</p>
                          {type.custom ? (
                            <span className="text-xs font-medium text-slate-700">Custom pricing</span>
                          ) : (
                            <span className="text-xs font-medium text-green-700">${type.monthlyFee.toLocaleString()}{type.oneTime ? ' one-time' : '/mo'}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {selectedTypes.length > 0 && (
                <Card className="mt-4 border-2 border-green-600 bg-green-50">
                  <CardContent className="p-4">
                    <div className="text-center">
                      <p className="text-sm text-slate-700 mb-1">Estimated Monthly Cost</p>
                      <p className="text-3xl font-bold text-green-700">${calculateTotal().toLocaleString()}</p>
                      <p className="text-xs text-slate-600 mt-1">{selectedTypes.length} service(s) selected</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-sm text-slate-600 mt-8">
          <p>Created by <strong className="text-slate-900">Dr. John White</strong></p>
          <p className="mt-1">Questions? Email <strong>Dr.JohnWhite@axiombiolabs.org</strong></p>
        </div>
      </div>
    </div>
  );
}