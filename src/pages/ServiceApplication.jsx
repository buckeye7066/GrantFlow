import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Service pricing matrix
const SERVICE_PRICING = {
  'Quick Eligibility Scan': { individual: 149, small: 349, midSize: 349, large: 750 },
  'Comprehensive Funding Dossier': { individual: 399, small: 1250, midSize: 2400, large: 3800 },
  'Application Strategy Session': { individual: 300, small: 450, midSize: 600, large: 600 },
  'Micro-Grant Application (<$5K)': { individual: 600, small: 900, midSize: 1200, large: 1200 },
  'Standard Foundation Application': { individual: 2000, small: 3500, midSize: 5000, large: 5000 },
  'Complex/Federal Application': { individual: 5000, small: 8000, midSize: 12000, large: 12000 },
  'Transfer Scholarship Pack': { individual: 450, small: 450, midSize: 450, large: 450 },
  'Editing & Redraft Service': { individual: 300, small: 500, midSize: 900, large: 900 },
  'Budget & Logic Model Development': { individual: 350, small: 600, midSize: 900, large: 900 },
  'Compliance Reporting & Management': { individual: 500, small: 1000, midSize: 1500, large: 1500 },
  'Grant Calendar Setup & Management': { individual: 800, small: 1200, midSize: 1800, large: 1800 },
  'Hourly Consultation & Advisory': { individual: 85, small: 85, midSize: 115, large: 150 },
}

const SERVICE_CATEGORIES = {
  'Discovery & Assessment Services': [
    'Quick Eligibility Scan',
    'Comprehensive Funding Dossier',
    'Application Strategy Session',
  ],
  'Grant Writing & Application Services': [
    'Micro-Grant Application (<$5K)',
    'Standard Foundation Application',
    'Complex/Federal Application',
    'Transfer Scholarship Pack',
  ],
  'Support & Compliance Services': [
    'Editing & Redraft Service',
    'Budget & Logic Model Development',
    'Compliance Reporting & Management',
    'Grant Calendar Setup & Management',
  ],
  'Hourly Services': [
    'Hourly Consultation & Advisory',
  ],
}

export default function ServiceApplication() {
  const navigate = useNavigate()
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    organization: '',
    title: '',
    clientCategory: '',
    selectedServices: [],
    agreeToTerms: false,
    agreeToCost: false,
  })
  const [showTerms, setShowTerms] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [errors, setErrors] = useState({})

  const handleInputChange = (field, value) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value }
      // If clientCategory changes after cost was acknowledged, revoke acknowledgement
      if (field === 'clientCategory' && prev.clientCategory !== value) {
        next.agreeToCost = false
      }
      return next
    })
    // Clear error for this field
    setErrors((prev) => ({ ...prev, [field]: '' }))
  }

  const handleServiceToggle = (service) => {
    setFormData((prev) => ({
      ...prev,
      selectedServices: prev.selectedServices.includes(service)
        ? prev.selectedServices.filter((s) => s !== service)
        : [...prev.selectedServices, service],
    }))
  }

  const calculateTotal = () => {
    if (!formData.clientCategory) return 0
    const validCategories = ['individual', 'small', 'midSize', 'large']
    const categoryKey = validCategories.includes(formData.clientCategory)
      ? formData.clientCategory
      : null

    return formData.selectedServices.reduce((total, service) => {
      return total + (SERVICE_PRICING[service]?.[categoryKey] || 0)
    }, 0)
  }

  const validateForm = () => {
    const newErrors = {}
    if (!formData.fullName.trim()) newErrors.fullName = 'Full name is required'
    if (!formData.email.trim()) newErrors.email = 'Email is required'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Invalid email address'
    }
    if (!formData.clientCategory) newErrors.clientCategory = 'Please select a client category'
    if (formData.selectedServices.length === 0) {
      newErrors.selectedServices = 'Please select at least one service'
    }
    if (formData.selectedServices.length > 0 && formData.clientCategory && !formData.agreeToCost) {
  newErrors.agreeToCost = 'Please acknowledge the estimated cost'
}
    if (!formData.agreeToTerms) newErrors.agreeToTerms = 'Please agree to the terms and conditions'

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    setIsSubmitting(true)
    setSubmitError('')

    try {
      const response = await fetch('/api/service-application/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...formData,
          totalCost: calculateTotal(),
          totalCostNote: formData.selectedServices.includes('Hourly Consultation & Advisory')
            ? 'Hourly rate shown; actual total depends on hours worked'
            : 'Flat-fee estimate',
          submittedAt: new Date().toISOString(),
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || 'Failed to submit application')
      }

      setSubmitSuccess(true)
    } catch (error) {
      console.error('Submission error:', error)
      setSubmitError(error.message || 'Failed to submit application. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (submitSuccess) {
    return (
      <AuthShell title="Application Submitted!" subtitle="Thank you for your interest in our services.">
        <div className="text-center space-y-4">
          <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto" />
          <div className="space-y-2">
            <p className="text-slate-700">
              Your service application has been successfully submitted to Dr. John White.
            </p>
            <p className="text-sm text-slate-600">
              You will receive a response within 1-2 business days.
            </p>
          </div>
          <Separator className="my-6" />
          <div className="text-sm text-slate-600 space-y-1">
            <p className="font-medium">John White, PhD, MBA</p>
            <p>Grant Writing Consultant</p>
            <p>Cell: 423.504.7778</p>
            <p>Fax: 423.414.5290</p>
          </div>
          <Button
            onClick={() => navigate('/dashboard')}
            className="mt-6"
          >
            Go to Dashboard
          </Button>
        </div>
      </AuthShell>
    )
  }

  const total = calculateTotal()
  const clientCategoryLabel = {
    individual: 'Individual',
    small: 'Small Org',
    midSize: 'Mid-Size',
    large: 'Large Org',
  }[formData.clientCategory] || ''

  return (
    <AuthShell
      title="Service Application"
      subtitle="Apply for grant writing services with Dr. John White"
      className="pb-12"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Client Information Section */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-slate-900">Client Information</h3>

          <div className="space-y-2">
            <Label htmlFor="fullName">
              Full Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="fullName"
              value={formData.fullName}
              onChange={(e) => handleInputChange('fullName', e.target.value)}
              className={cn(errors.fullName && 'border-red-500')}
            />
            {errors.fullName && (
              <p className="text-sm text-red-500">{errors.fullName}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">
              Email Address <span className="text-red-500">*</span>
            </Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => handleInputChange('email', e.target.value)}
              className={cn(errors.email && 'border-red-500')}
            />
            {errors.email && (
              <p className="text-sm text-red-500">{errors.email}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">Phone Number</Label>
            <Input
              id="phone"
              type="tel"
              value={formData.phone}
              onChange={(e) => handleInputChange('phone', e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="organization">Organization Name (if applicable)</Label>
            <Input
              id="organization"
              value={formData.organization}
              onChange={(e) => handleInputChange('organization', e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="title">Title/Position (if applicable)</Label>
            <Input
              id="title"
              value={formData.title}
              onChange={(e) => handleInputChange('title', e.target.value)}
            />
          </div>
        </div>

        <Separator />

        {/* Client Category Selection */}
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 mb-1">
              Client Category <span className="text-red-500">*</span>
            </h3>
            <p className="text-sm text-slate-600">Select the category that best describes you</p>
          </div>

          <RadioGroup
            value={formData.clientCategory}
            onValueChange={(value) => handleInputChange('clientCategory', value)}
            className={cn('space-y-3', errors.clientCategory && 'border border-red-500 rounded-md p-3')}
          >
            <div className="flex items-start space-x-3">
              <RadioGroupItem value="individual" id="individual" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="individual" className="font-medium cursor-pointer">
                  Individual
                </Label>
                <p className="text-sm text-slate-600">
                  Students, individuals/families seeking assistance
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <RadioGroupItem value="small" id="small" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="small" className="font-medium cursor-pointer">
                  Small Org
                </Label>
                <p className="text-sm text-slate-600">
                  Nonprofits, ministries, or businesses with annual budget under $250,000
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <RadioGroupItem value="midSize" id="midSize" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="midSize" className="font-medium cursor-pointer">
                  Mid-Size
                </Label>
                <p className="text-sm text-slate-600">
                  Organizations with annual budget between $250,000 and $2,000,000
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <RadioGroupItem value="large" id="large" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="large" className="font-medium cursor-pointer">
                  Large Org
                </Label>
                <p className="text-sm text-slate-600">
                  Organizations with annual budget over $2,000,000
                </p>
              </div>
            </div>
          </RadioGroup>

          {errors.clientCategory && (
            <p className="text-sm text-red-500">{errors.clientCategory}</p>
          )}
        </div>

        <Separator />

        {/* Service Selection */}
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 mb-1">
              Service Selection {formData.clientCategory && `(${clientCategoryLabel} Pricing)`}
              <span className="text-red-500"> *</span>
            </h3>
            {!formData.clientCategory && (
              <p className="text-sm text-amber-600">
                Please select a client category above to see pricing
              </p>
            )}
          </div>

          {Object.entries(SERVICE_CATEGORIES).map(([category, services]) => (
            <div key={category} className="space-y-3">
              <h4 className="font-medium text-slate-800">{category}</h4>
              <div className="space-y-2 ml-2">
                {services.map((service) => {
                  const price = formData.clientCategory
                    ? SERVICE_PRICING[service]?.[
                        { individual: 'individual', small: 'small', midSize: 'midSize', large: 'large' }[
                          formData.clientCategory
                        ]
                      ]
                    : null
                  const isHourly = service.includes('Hourly')

                  return (
                    <div key={service} className="flex items-center space-x-3">
                      <Checkbox
                        id={service}
                        checked={formData.selectedServices.includes(service)}
                        onCheckedChange={() => handleServiceToggle(service)}
                        disabled={!formData.clientCategory}
                      />
                      <Label
                        htmlFor={service}
                        className={cn(
                          'flex-1 cursor-pointer text-sm',
                          !formData.clientCategory && 'text-slate-400'
                        )}
                      >
                        <span>{service}</span>
                        {price !== null && (
                          <span className="ml-2 font-medium text-slate-700">
                            ${price.toLocaleString()}{isHourly ? '/hr' : ''}
                          </span>
                        )}
                      </Label>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {errors.selectedServices && (
            <p className="text-sm text-red-500">{errors.selectedServices}</p>
          )}
        </div>

        {/* Running Total */}
        {formData.selectedServices.length > 0 && (
          <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4">
            <div className="flex justify-between items-center">
              <span className="text-lg font-semibold text-slate-900">Estimated Total:</span>
              <span className="text-2xl font-bold text-blue-600">
                ${total.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        <Separator />

        {/* Important Notes */}
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="space-y-2 text-sm">
              <p className="font-semibold">Important Notes:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Choose ONE: Quick Eligibility Scan OR Comprehensive Funding Dossier (not both)</li>
                <li>Application Writing is separate from eligibility assessment</li>
                <li>Choose hourly OR flat fee services, not both for the same work</li>
              </ul>
            </div>
          </AlertDescription>
        </Alert>

        {/* Payment Terms */}
        <div className="bg-slate-50 rounded-lg p-4 space-y-2">
          <h4 className="font-semibold text-slate-900">Payment Terms</h4>
          <ul className="text-sm text-slate-700 space-y-1">
            <li>• 40% due at project kickoff (scope locked; calendar set)</li>
            <li>• 40% due at complete draft delivery</li>
            <li>• 20% due at submission and handoff package delivery</li>
            <li>• Net 15 days from invoice date</li>
            <li>• Late fees: 1.5% monthly interest on overdue balances</li>
          </ul>
        </div>

        {/* Ethical Billing Standards */}
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-sm text-slate-700 font-medium">
            All fees are for professional services rendered and are NOT contingent on award outcomes.
            No percentage-based or commission fees.
          </p>
        </div>

        {/* Terms Agreement */}
        <div className="space-y-3">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="agreeToCost"
              checked={formData.agreeToCost}
              onCheckedChange={(checked) => handleInputChange('agreeToCost', checked)}
            />
            <Label
              htmlFor="agreeToCost"
              className={cn('text-sm cursor-pointer', errors.agreeToCost && 'text-red-500')}
            >
              I acknowledge and agree to the estimated cost shown above
            </Label>
          </div>

          <div className="flex items-start space-x-3">
            <Checkbox
              id="agreeToTerms"
              checked={formData.agreeToTerms}
              onCheckedChange={(checked) => handleInputChange('agreeToTerms', checked)}
            />
            <Label
              htmlFor="agreeToTerms"
              className={cn('text-sm cursor-pointer', errors.agreeToTerms && 'text-red-500')}
            >
              I have read and agree to the{' '}
              <button
                type="button"
                onClick={() => setShowTerms(!showTerms)}
                className="text-blue-600 hover:underline font-medium"
              >
                Contract Terms & Conditions
              </button>
            </Label>
          </div>
        </div>

        {/* Terms Modal/Collapsible */}
        {showTerms && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-2 text-sm max-h-64 overflow-y-auto">
            <h4 className="font-semibold text-slate-900">Terms & Conditions</h4>
            <div className="text-slate-700 space-y-2">
              <p>
                <strong>1. Services:</strong> Services will be provided as described in the service selection
                and agreed-upon scope of work.
              </p>
              <p>
                <strong>2. Payment:</strong> Payment is required according to the payment schedule outlined
                above. Late payments may incur additional fees.
              </p>
              <p>
                <strong>3. No Guarantee of Funding:</strong> All fees are for professional services rendered.
                There is no guarantee of grant award or funding success.
              </p>
              <p>
                <strong>4. Cancellation:</strong> Cancellation must be made in writing. Fees for work
                completed up to the cancellation date are non-refundable.
              </p>
              <p>
                <strong>5. Confidentiality:</strong> All client information and documents will be kept
                confidential in accordance with professional standards.
              </p>
            </div>
          </div>
        )}

        {/* Contact Information */}
        <div className="bg-blue-50 dark:bg-blue-950/40 rounded-lg p-4 text-sm text-slate-700 dark:text-slate-200 space-y-1">
          <p className="font-semibold text-slate-900">Contact Information</p>
          <p>John White, PhD, MBA, Grant Writing Consultant</p>
          <p>Cell: 423.504.7778</p>
          <p>Fax: 423.414.5290</p>
          <p className="text-blue-600 italic mt-2">
            We reserve 10% of revenue for pro bono services to those in crisis
          </p>
        </div>

        {/* Submit Error */}
        {submitError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        {/* Submit Button */}
        <Button
          type="submit"
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Submitting Application...
            </>
          ) : (
            'Submit Application'
          )}
        </Button>

        <p className="text-center text-sm text-slate-600">
          Already have an account?{' '}
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="text-blue-600 hover:underline font-medium"
          >
            Sign in here
          </button>
        </p>
      </form>
    </AuthShell>
  )
}
