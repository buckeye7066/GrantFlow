import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTierCatalog } from '@/api/billing';
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
    catalogTierId: 'individual',
    name: 'Individual / Family',
    icon: Heart,
    description: 'For individuals and families seeking assistance',
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
    catalogTierId: 'individual',
    discountId: 'student',
    name: 'Student',
    icon: GraduationCap,
    description: 'For high school, college, and graduate students',
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
    catalogTierId: 'individual',
    discountId: 'minister',
    name: 'Minister / Clergy',
    icon: Church,
    description: 'For religious leaders and missionaries',
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
    catalogTierId: 'small_org',
    name: 'Small Nonprofit',
    icon: Users,
    description: 'Organizations with budget under $500K',
    color: 'orange',
    features: [
      'Full grant discovery',
      'Unlimited opportunity matching',
      'Application management',
      'Compliance tracking',
      'Priority support',
    ],
  },
  {
    id: 'medium-nonprofit',
    catalogTierId: 'mid_size',
    name: 'Medium Nonprofit',
    icon: Building,
    description: 'Organizations with budget $500K - $5M',
    color: 'cyan',
    features: [
      'Advanced grant discovery',
      'Multiple user accounts',
      'Pipeline automation',
      'Custom reporting',
      'Dedicated account manager',
    ],
  },
  {
    id: 'large-org',
    catalogTierId: 'large_org',
    name: 'Large Organization',
    icon: Building,
    description: 'Organizations with budget over $5M',
    color: 'slate',
    features: [
      'Enterprise features',
      'Unlimited users',
      'API access',
      'Custom integrations',
      'White-glove service',
    ],
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
  const nativeApp = isNativeApp();
  // Prices, discounts and plan names come ONLY from the canonical catalog (the
  // same cached query TierMatrix uses). Production 2026-09-11: hardcoded card
  // prices ("$100 - $250 per month") and a 30-percent student discount
  // contradicted the catalog rendered directly above them.
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ['tier-catalog'],
    queryFn: getTierCatalog,
    staleTime: 5 * 60_000,
    enabled: !nativeApp,
  });
  const catalogTier = (card) => (catalog?.tiers || []).find((t) => t.id === card.catalogTierId) || null;
  const catalogDiscount = (id) => (catalog?.discounts || []).find((d) => d.id === id) || null;
  const formatMonthly = (usd) => (Number(usd) === 0 ? 'Free' : `$${Number(usd).toLocaleString()}/mo`);
  const cardPrice = (card) => {
    if (catalogLoading) return '…';
    const t = catalogTier(card);
    return t && t.monthly_usd !== null && t.monthly_usd !== undefined ? formatMonthly(t.monthly_usd) : 'See plan table';
  };
  const cardBadge = (card) => {
    const d = card.discountId ? catalogDiscount(card.discountId) : null;
    if (d) return `${d.label}: ${d.percent}% off`;
    return catalogTier(card)?.name || 'Plan';
  };
  const cardDescription = (card) => (card.discountId ? card.description : catalogTier(card)?.audience || card.description);
  const cardNote = (card) => {
    const t = catalogTier(card);
    const d = card.discountId ? catalogDiscount(card.discountId) : null;
    if (d && t) return `${t.name} plan, ${d.percent}% ${d.percent === 100 ? 'waived' : 'off'} once an administrator applies the ${d.label.toLowerCase()} discount.`;
    if (t && t.hourly_usd) return `Hourly support: $${Number(t.hourly_usd).toLocaleString()}`;
    return '';
  };

  // Store policy: no plans, prices, or purchase steering in native builds.
  if (nativeApp) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-6 md:p-8">
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-6 md:p-8">
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
                      {cardBadge(tier)}
                    </Badge>
                  </div>
                  <CardTitle className="text-2xl">{tier.name}</CardTitle>
                  <CardDescription className="text-sm">
                    {cardDescription(tier)}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <div className="text-3xl font-bold text-slate-900">
                      {cardPrice(tier)}
                    </div>
                    {cardNote(tier) && (
                      <p className="text-sm text-slate-600 mt-1">
                        {cardNote(tier)}
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
                    to={createPageUrl('Organizations', { quickAdd: 1 })}
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
              {catalogLoading ? (
                <p className="text-sm text-slate-600">Loading discounts…</p>
              ) : (catalog?.discounts || []).length === 0 ? (
                <p className="text-sm text-slate-600">Discount details are unavailable right now.</p>
              ) : (
                (catalog?.discounts || []).map((d) => (
                  <div key={d.id}>
                    <h4 className="font-semibold text-sm mb-1">{d.label}</h4>
                    <p className="text-sm text-slate-600">
                      {d.percent === 100 ? 'Fully waived.' : `${d.percent}% off any plan.`} {d.plain}
                    </p>
                  </div>
                ))
              )}
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
                {import.meta.env.VITE_SUPPORT_FAX ? (
                  <div>
                    <p className="text-sm font-semibold">Fax</p>
                    <p className="text-sm text-slate-600">{import.meta.env.VITE_SUPPORT_FAX}</p>
                  </div>
                ) : null}
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
