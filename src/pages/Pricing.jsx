import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, DollarSign, Users, GraduationCap, Heart, Building, Church } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import TierMatrix from '@/components/billing/TierMatrix.jsx';
import { isNativeApp } from '@/lib/platform';

const pricingTiers = [
  {
    id: 'individual',
    name: 'Individual / Family',
    icon: Heart,
    description: 'For individuals and families seeking assistance',
    price: '$0 - $50',
    priceDetail: 'Based on need',
    color: 'blue',
    features: [
      'Personalized profile matching',
      'Access to all individual opportunities',
      'Application assistance',
      'Email support',
      'Pro bono options available',
    ],
    applicantTypes: ['individual_need', 'medical_assistance', 'family'],
  },
  {
    id: 'student',
    name: 'Student',
    icon: GraduationCap,
    description: 'For high school, college, and graduate students',
    price: '$25 - $75',
    priceDetail: 'Per semester',
    color: 'green',
    features: [
      'Scholarship matching',
      'Academic opportunity discovery',
      'Application tracking',
      'Essay assistance',
      'Student discounts available',
    ],
    applicantTypes: ['high_school_student', 'college_student', 'graduate_student'],
  },
  {
    id: 'minister',
    name: 'Minister / Clergy',
    icon: Church,
    description: 'For religious leaders and missionaries',
    price: '$50 - $100',
    priceDetail: 'Per year',
    color: 'purple',
    features: [
      'Faith-based opportunity matching',
      'Ministry grant discovery',
      'Application support',
      'Community connection',
      'Minister discounts available',
    ],
    applicantTypes: ['minister'],
  },
  {
    id: 'small-nonprofit',
    name: 'Small Nonprofit',
    icon: Users,
    description: 'Organizations with budget under $500K',
    price: '$100 - $250',
    priceDetail: 'Per month',
    color: 'orange',
    features: [
      'Full grant discovery',
      'Unlimited opportunity matching',
      'Application management',
      'Compliance tracking',
      'Priority support',
    ],
    budgetRange: '< $500K',
  },
  {
    id: 'medium-nonprofit',
    name: 'Medium Nonprofit',
    icon: Building,
    description: 'Organizations with budget $500K - $5M',
    price: '$250 - $500',
    priceDetail: 'Per month',
    color: 'cyan',
    features: [
      'Advanced grant discovery',
      'Multiple user accounts',
      'Pipeline automation',
      'Custom reporting',
      'Dedicated account manager',
    ],
    budgetRange: '$500K - $5M',
  },
  {
    id: 'large-org',
    name: 'Large Organization',
    icon: Building,
    description: 'Organizations with budget over $5M',
    price: 'Custom',
    priceDetail: 'Contact for pricing',
    color: 'slate',
    features: [
      'Enterprise features',
      'Unlimited users',
      'API access',
      'Custom integrations',
      'White-glove service',
    ],
    budgetRange: '> $5M',
  },
];

const colorClasses = {
  blue: {
    badge: 'bg-blue-100 text-blue-700 border-blue-200',
    icon: 'text-blue-600',
    card: 'border-blue-200 hover:border-blue-300',
  },
  green: {
    badge: 'bg-green-100 text-green-700 border-green-200',
    icon: 'text-green-600',
    card: 'border-green-200 hover:border-green-300',
  },
  purple: {
    badge: 'bg-purple-100 text-purple-700 border-purple-200',
    icon: 'text-purple-600',
    card: 'border-purple-200 hover:border-purple-300',
  },
  orange: {
    badge: 'bg-orange-100 text-orange-700 border-orange-200',
    icon: 'text-orange-600',
    card: 'border-orange-200 hover:border-orange-300',
  },
  cyan: {
    badge: 'bg-cyan-100 text-cyan-700 border-cyan-200',
    icon: 'text-cyan-600',
    card: 'border-cyan-200 hover:border-cyan-300',
  },
  slate: {
    badge: 'bg-slate-100 text-slate-700 border-slate-200',
    icon: 'text-slate-600',
    card: 'border-slate-200 hover:border-slate-300',
  },
};

export default function Pricing() {
  // Store policy: no plans, prices, or purchase steering in native builds.
  if (isNativeApp()) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6 md:p-8">
        <div className="max-w-xl mx-auto pt-16">
          <Card>
            <CardHeader>
              <CardTitle>Plans &amp; Pricing</CardTitle>
              <CardDescription>
                Plan purchases aren&apos;t available in this app.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-slate-600">
              If your account already has active service, simply log in — your
              full workspace is available here.
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-slate-900 mb-4">
            Simple, Transparent Pricing
          </h1>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            Choose the plan that fits your needs. All plans include access to our comprehensive grant discovery platform.
          </p>
          <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg max-w-2xl mx-auto">
            <p className="text-sm text-amber-800">
              <strong>Special Discounts Available:</strong> Student, minister, hardship, and pro bono discounts apply on top of any plan for qualifying applicants. Contact us to learn more.
            </p>
          </div>
        </div>

        {/* Canonical plan comparison — driven by the backend tier catalog so it
            can never drift from what's actually billed/enforced. */}
        <div className="mb-12">
          <TierMatrix />
        </div>

        {/* Illustrative cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
          {pricingTiers.map((tier) => {
            const Icon = tier.icon;
            const colors = colorClasses[tier.color];
            
            return (
              <Card 
                key={tier.id}
                className={`relative transition-all hover:shadow-lg ${colors.card}`}
              >
                <CardHeader>
                  <div className="flex items-center justify-between mb-2">
                    <Icon className={`w-8 h-8 ${colors.icon}`} />
                    <Badge variant="outline" className={colors.badge}>
                      {tier.priceDetail}
                    </Badge>
                  </div>
                  <CardTitle className="text-2xl">{tier.name}</CardTitle>
                  <CardDescription className="text-sm">
                    {tier.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <div className="text-3xl font-bold text-slate-900">
                      {tier.price}
                    </div>
                    {tier.budgetRange && (
                      <p className="text-sm text-slate-600 mt-1">
                        Annual budget: {tier.budgetRange}
                      </p>
                    )}
                  </div>

                  <ul className="space-y-3">
                    {tier.features.map((feature, index) => (
                      <li key={index} className="flex items-start gap-2">
                        <Check className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                        <span className="text-sm text-slate-700">{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <Link
                    to={createPageUrl(
                      tier.applicantTypes
                        ? 'CreateProfile'
                        : 'Organizations'
                    )}
                    className="block"
                  >
                    <Button className="w-full" variant="outline">
                      Get Started
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Additional Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-green-600" />
                Discount Programs
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <h4 className="font-semibold text-sm mb-1">Student Discount</h4>
                <p className="text-sm text-slate-600">
                  Up to 30% off for currently enrolled students with valid student ID.
                </p>
              </div>
              <div>
                <h4 className="font-semibold text-sm mb-1">Minister Discount</h4>
                <p className="text-sm text-slate-600">
                  Special pricing for clergy, missionaries, and religious workers.
                </p>
              </div>
              <div>
                <h4 className="font-semibold text-sm mb-1">Hardship Discount</h4>
                <p className="text-sm text-slate-600">
                  Case-by-case discounts available for those facing financial hardship.
                </p>
              </div>
              <div>
                <h4 className="font-semibold text-sm mb-1">Pro Bono Services</h4>
                <p className="text-sm text-slate-600">
                  100% free services available for qualifying individuals and organizations.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5 text-blue-600" />
                Contact Us
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-slate-600">
                Have questions about pricing or need a custom solution? We're here to help!
              </p>
              <div className="space-y-2">
                <div>
                  <p className="text-sm font-semibold">Email</p>
                  <a 
                    href={`mailto:${import.meta.env.VITE_SUPPORT_EMAIL ?? 'support@grantflow.app'}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {import.meta.env.VITE_SUPPORT_EMAIL ?? 'support@grantflow.app'}
                  </a>
                </div>
                <div>
                  <p className="text-sm font-semibold">Fax</p>
                  <p className="text-sm text-slate-600">{import.meta.env.VITE_SUPPORT_FAX ?? ''}</p>
                </div>
              </div>
              <div className="pt-3">
                <Link to={createPageUrl('Organizations')}>
                  <Button className="w-full">
                    Create Your Profile
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Footer Note */}
        <div className="mt-12 text-center">
          <p className="text-sm text-slate-500">
            All prices are in USD. Pricing is determined based on your profile type and organizational budget. 
            Final pricing will be confirmed during account setup.
          </p>
        </div>
      </div>
    </div>
  );
}
