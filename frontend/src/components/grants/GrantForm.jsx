import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

// Import new subcomponents
import ContactInfoSection from './form/ContactInfoSection';
import GrantNarrativeSection from './form/GrantNarrativeSection';

/**
 * Validate email format
 */
const isValidEmail = (email) => {
  if (!email) return true; // Optional field
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

/**
 * Validate date is in the future
 */
const isFutureDate = (dateString) => {
  if (!dateString) return true; // Optional field
  const date = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
};

export default function GrantForm({ grant, organization, onSubmit, onCancel, isSubmitting }) {
  const [formData, setFormData] = useState({
    title: grant?.title || '',
    funder: grant?.funder || '',
    opportunity_type: grant?.opportunity_type || 'grant',
    application_method: grant?.application_method || 'standard',
    application_instructions: grant?.application_instructions || '',
    deadline: grant?.deadline || '',
    award_ceiling: grant?.award_ceiling || '',
    award_floor: grant?.award_floor || '',
    url: grant?.url || '',
    eligibility_summary: grant?.eligibility_summary || '',
    program_description: grant?.program_description || '',
    selection_criteria: grant?.selection_criteria || '',
    funder_email: grant?.funder_email || '',
    funder_phone: grant?.funder_phone || '',
    funder_fax: grant?.funder_fax || '',
    funder_address: grant?.funder_address || '',
    status: grant?.status || 'discovered',
  });

  const [errors, setErrors] = useState({});

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    
    // Clear error for this field when user starts typing
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: null }));
    }
  };

  const validateForm = () => {
    const newErrors = {};

    // Title validation
    if (!formData.title) {
      newErrors.title = 'Title is required';
    } else if (formData.title.length > 150) {
      newErrors.title = 'Title must be 150 characters or less';
    }

    // Funder validation
    if (!formData.funder) {
      newErrors.funder = 'Funder is required';
    }

    // Email validation
    if (formData.funder_email && !isValidEmail(formData.funder_email)) {
      newErrors.funder_email = 'Please enter a valid email address';
    }

    // Deadline validation
    if (formData.deadline && !isFutureDate(formData.deadline)) {
      newErrors.deadline = 'Deadline should be a future date';
    }

    // Award validation
    if (formData.award_floor && formData.award_ceiling) {
      const floor = parseFloat(formData.award_floor);
      const ceiling = parseFloat(formData.award_ceiling);
      if (floor > ceiling) {
        newErrors.award_floor = 'Minimum award cannot exceed maximum award';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (validateForm()) {
      onSubmit(formData);
    } else {
      // Scroll to first error
      const firstErrorField = Object.keys(errors)[0];
      const element = document.getElementById(firstErrorField);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.focus();
      }
    }
  };

  const remainingChars = 150 - (formData.title?.length || 0);

  return (
    <Card className="shadow-xl border-0">
      <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50 border-b">
        <CardTitle className="flex items-center gap-2 text-xl">
          <FileText className="w-6 h-6 text-blue-600" />
          {grant ? 'Edit Grant Opportunity' : 'New Grant Opportunity'}
        </CardTitle>
        <p className="text-sm text-slate-600 mt-1">
          {grant ? 'Update grant information and details' : 'Add a new funding opportunity to track'}
        </p>
      </CardHeader>
      
      <CardContent className="p-6">
        <form onSubmit={handleSubmit} className="space-y-8">
          
          {/* Basic Grant Information */}
          <div className="space-y-4">
            <div className="border-b pb-2">
              <h3 className="font-semibold text-slate-900">Basic Information</h3>
              <p className="text-xs text-slate-500">Essential details about the opportunity</p>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="title">
                  Opportunity Title <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="title"
                  name="title"
                  value={formData.title}
                  onChange={handleChange}
                  placeholder="Community Impact Grant Program"
                  className={errors.title ? 'border-red-500' : ''}
                  maxLength={150}
                />
                <div className="flex justify-between items-center">
                  {errors.title ? (
                    <p className="text-xs text-red-600">{errors.title}</p>
                  ) : (
                    <p className="text-xs text-slate-500">The full name of the grant or scholarship</p>
                  )}
                  <p className={`text-xs ${remainingChars < 20 ? 'text-amber-600 font-medium' : 'text-slate-400'}`}>
                    {remainingChars} chars left
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="funder">
                  Funder / Sponsor <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="funder"
                  name="funder"
                  value={formData.funder}
                  onChange={handleChange}
                  placeholder="National Science Foundation"
                  className={errors.funder ? 'border-red-500' : ''}
                />
                {errors.funder ? (
                  <p className="text-xs text-red-600">{errors.funder}</p>
                ) : (
                  <p className="text-xs text-slate-500">Organization providing the funding</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="url">Program URL</Label>
                <Input
                  id="url"
                  name="url"
                  type="url"
                  value={formData.url}
                  onChange={handleChange}
                  placeholder="https://example.org/grants/community-impact"
                />
                <p className="text-xs text-slate-500">Link to the opportunity webpage</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="opportunity_type">Opportunity Type</Label>
                <Select 
                  name="opportunity_type" 
                  value={formData.opportunity_type} 
                  onValueChange={(value) => setFormData({ ...formData, opportunity_type: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="grant">Grant</SelectItem>
                    <SelectItem value="scholarship">Scholarship</SelectItem>
                    <SelectItem value="fellowship">Fellowship</SelectItem>
                    <SelectItem value="financial_assistance">Financial Assistance</SelectItem>
                    <SelectItem value="prize">Prize</SelectItem>
                    <SelectItem value="award">Award</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="deadline">Application Deadline</Label>
                <Input
                  id="deadline"
                  name="deadline"
                  type="date"
                  value={formData.deadline}
                  onChange={handleChange}
                  className={errors.deadline ? 'border-red-500' : ''}
                />
                {errors.deadline && (
                  <p className="text-xs text-red-600">{errors.deadline}</p>
                )}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="award_floor">Minimum Award Amount</Label>
                <Input
                  id="award_floor"
                  name="award_floor"
                  type="number"
                  value={formData.award_floor}
                  onChange={handleChange}
                  placeholder="5000"
                  className={errors.award_floor ? 'border-red-500' : ''}
                />
                {errors.award_floor && (
                  <p className="text-xs text-red-600">{errors.award_floor}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="award_ceiling">Maximum Award Amount</Label>
                <Input
                  id="award_ceiling"
                  name="award_ceiling"
                  type="number"
                  value={formData.award_ceiling}
                  onChange={handleChange}
                  placeholder="50000"
                />
              </div>
            </div>
          </div>

          {/* Application Method */}
          <div className="space-y-4">
            <div className="border-b pb-2">
              <h3 className="font-semibold text-slate-900">Application Process</h3>
              <p className="text-xs text-slate-500">How to apply for this opportunity</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="application_method">Application Method</Label>
              <Select 
                name="application_method" 
                value={formData.application_method} 
                onValueChange={(value) => setFormData({ ...formData, application_method: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard Application</SelectItem>
                  <SelectItem value="auto_fafsa">Automatic via FAFSA</SelectItem>
                  <SelectItem value="auto_profile">Automatic Profile Match</SelectItem>
                  <SelectItem value="nomination">Nomination Required</SelectItem>
                  <SelectItem value="invitation">Invitation Only</SelectItem>
                  <SelectItem value="no_application">No Application Needed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="application_instructions">Application Instructions</Label>
              <Textarea
                id="application_instructions"
                name="application_instructions"
                value={formData.application_instructions}
                onChange={handleChange}
                placeholder="Example: Complete your FAFSA by March 1st to be automatically considered, or submit through the university's scholarship portal with a 500-word essay and two letters of recommendation."
                rows={3}
              />
              <p className="text-xs text-slate-500">
                Specific instructions for how to apply for this opportunity
              </p>
            </div>
          </div>

          {/* AI-Powered Contact Information */}
          <div className="space-y-4">
            <div className="border-b pb-2">
              <h3 className="font-semibold text-slate-900">Contact Information</h3>
              <p className="text-xs text-slate-500">How to reach the funder</p>
            </div>
            
            <ContactInfoSection 
              formData={formData}
              onChange={setFormData}
              errors={errors}
            />
          </div>

          {/* AI-Powered Program Details */}
          <div className="space-y-4">
            <div className="border-b pb-2">
              <h3 className="font-semibold text-slate-900">Program Information</h3>
              <p className="text-xs text-slate-500">Detailed information about the opportunity</p>
            </div>
            
            <GrantNarrativeSection 
              formData={formData}
              onChange={setFormData}
            />
          </div>

          <CardFooter className="flex justify-end gap-3 bg-slate-50 p-4 -mx-6 -mb-6 rounded-b-lg border-t">
            <Button 
              type="button" 
              variant="outline" 
              onClick={onCancel} 
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button 
              type="submit" 
              disabled={isSubmitting}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {grant ? 'Save Changes' : 'Create Grant'}
            </Button>
          </CardFooter>
        </form>
      </CardContent>
    </Card>
  );
}