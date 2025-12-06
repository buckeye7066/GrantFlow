import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Check, 
  Sparkles, 
  Users, 
  Building2, 
  Loader2,
  Heart,
  TrendingUp,
  Rocket,
  AlertCircle,
  Plus
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function Pricing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [billingCycle, setBillingCycle] = useState('monthly');

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const { data: plans = [], isLoading: isLoadingPlans } = useQuery({
    queryKey: ['subscriptionPlans'],
    queryFn: () => base44.entities.SubscriptionPlan.filter({ is_active: true }, 'sort_order'),
  });

  const { data: addOns = [], isLoading: isLoadingAddOns } = useQuery({
    queryKey: ['addOns'],
    queryFn: () => base44.entities.AddOn.filter({ is_active: true }),
  });

  const { data: currentSubscription } = useQuery({
    queryKey: ['userSubscription', user?.email],
    queryFn: () => {
      if (!user?.email) return [];
      return base44.entities.UserSubscription.filter({
        user_email: user.email,
        status: 'active'
      });
    },
    enabled: !!user?.email,
  });

  const subscribeMutation = useMutation({
    mutationFn: async (planId) => {
      const plan = plans?.find(p => p.id === planId);
      if (!plan) {
        throw new Error('Selected plan not found. Please refresh and try again.');
      }

      return base44.entities.UserSubscription.create({
        user_email: user.email,
        plan_id: planId,
        status: 'trial',
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        monthly_amount: plan.monthly_price || 0,
        usage_this_month: {
          ai_searches: 0,
          profiles_created: 0,
          storage_used_gb: 0
        }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userSubscription'] });
      toast({
        title: '🎉 Subscription Started!',
        description: 'Your 14-day free trial has begun. Welcome aboard!',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Subscription Failed',
        description: error.message || 'Failed to start subscription',
      });
    }
  });

  const getPlanIcon = (tierName) => {
    switch (tierName) {
      case 'Hope':
        return Heart;
      case 'Growth':
        return TrendingUp;
      case 'Impact':
        return Rocket;
      case 'Impact Enterprise':
        return Building2;
      default:
        return Users;
    }
  };

  const getPlanColor = (tierName) => {
    switch (tierName) {
      case 'Hope':
        return 'from-pink-500 to-rose-500';
      case 'Growth':
        return 'from-blue-500 to-indigo-500';
      case 'Impact':
        return 'from-purple-500 to-violet-500';
      case 'Impact Enterprise':
        return 'from-slate-700 to-slate-900';
      default:
        return 'from-slate-500 to-slate-600';
    }
  };

  const isCurrentPlan = (planId) => {
    return currentSubscription?.[0]?.plan_id === planId;
  };

  if (isLoadingPlans || isLoadingAddOns) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-purple-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <Badge className="mb-4 bg-purple-600">
            <Sparkles className="w-3 h-3 mr-1" />
            AI-Powered Grant Writing Platform
          </Badge>
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
            Choose Your Plan
          </h1>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            From individuals to large organizations, we have a plan that fits your grant writing needs
          </p>
        </div>

        {/* Subscription Plans */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          {plans.map((plan) => {
            const Icon = getPlanIcon(plan.tier_name);
            const isPopular = plan.tier_name === 'Growth';
            const isCurrent = isCurrentPlan(plan.id);

            return (
              <Card 
                key={plan.id}
                className={`relative ${
                  isPopular ? 'ring-2 ring-blue-500 shadow-xl' : 'hover:shadow-lg'
                } transition-all`}
              >
                {isPopular && (
                  <div className="absolute -top-4 left-1/2 transform -translate-x-1/2">
                    <Badge className="bg-blue-600">Most Popular</Badge>
                  </div>
                )}

                {isCurrent && (
                  <div className="absolute -top-4 right-4">
                    <Badge className="bg-green-600">Current Plan</Badge>
                  </div>
                )}

                <CardHeader>
                  <div className={`w-12 h-12 rounded-lg bg-gradient-to-br ${getPlanColor(plan.tier_name)} flex items-center justify-center mb-4`}>
                    <Icon className="w-6 h-6 text-white" />
                  </div>
                  <CardTitle className="text-2xl">{plan.tier_name}</CardTitle>
                  <CardDescription className="text-sm min-h-[40px]">
                    {plan.ideal_for?.[0] || 'Perfect for your needs'}
                  </CardDescription>
                </CardHeader>

                <CardContent>
                  <div className="mb-6">
                    {plan.pay_what_you_can ? (
                      <div>
                        <p className="text-3xl font-bold text-slate-900">Pay What You Can</p>
                        <p className="text-sm text-slate-600 mt-1">Starting at ${plan.monthly_price}/mo</p>
                        {plan.grace_period_months > 0 && (
                          <p className="text-xs text-emerald-600 mt-2">
                            ✓ {plan.grace_period_months} months grace period available
                          </p>
                        )}
                      </div>
                    ) : (
                      <div>
                        <span className="text-4xl font-bold text-slate-900">
                          ${plan.monthly_price.toLocaleString()}
                        </span>
                        <span className="text-slate-600">/month</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 mb-6">
                    {plan.max_profiles && (
                      <div className="flex items-start gap-2">
                        <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                        <span className="text-sm text-slate-700">
                          {plan.max_profiles === 999 ? 'Unlimited' : plan.max_profiles} organization profiles
                        </span>
                      </div>
                    )}

                    {plan.ai_searches_per_month && (
                      <div className="flex items-start gap-2">
                        <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                        <span className="text-sm text-slate-700">
                          {plan.ai_searches_per_month === 99999 ? 'Unlimited' : plan.ai_searches_per_month.toLocaleString()} AI searches/month
                        </span>
                      </div>
                    )}

                    {plan.ai_drafting_level && (
                      <div className="flex items-start gap-2">
                        <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                        <span className="text-sm text-slate-700 capitalize">
                          {plan.ai_drafting_level} AI drafting
                        </span>
                      </div>
                    )}

                    {plan.document_storage_gb && (
                      <div className="flex items-start gap-2">
                        <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                        <span className="text-sm text-slate-700">
                          {plan.document_storage_gb === 9999 ? 'Unlimited' : `${plan.document_storage_gb}GB`} storage
                        </span>
                      </div>
                    )}

                    {Array.isArray(plan.features) &&
                      plan.features.slice(0, 3).map((feature, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                        <span className="text-sm text-slate-700">{feature}</span>
                      </div>
                    ))}
                  </div>

                  <Button
                    onClick={() => subscribeMutation.mutate(plan.id)}
                    disabled={isCurrent || subscribeMutation.isPending}
                    className={`w-full ${
                      isPopular ? 'bg-blue-600 hover:bg-blue-700' : ''
                    }`}
                    variant={isPopular ? 'default' : 'outline'}
                  >
                    {isCurrent ? 'Current Plan' : 'Start Free Trial'}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Add-Ons Section */}
        <div className="mb-12">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-slate-900 mb-2">
              Optional Add-Ons
            </h2>
            <p className="text-slate-600">
              Enhance your plan with premium services
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {addOns.map((addon) => (
              <Card key={addon.id} className="hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex items-start justify-between mb-2">
                    <CardTitle className="text-xl">{addon.addon_name}</CardTitle>
                    <Badge variant="outline" className="text-xs">
                      {addon.addon_type.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  <CardDescription>{addon.description}</CardDescription>
                </CardHeader>

                <CardContent>
                  <div className="mb-4">
                    <p className="text-2xl font-bold text-slate-900">
                      {addon.pricing_model === 'percentage' 
                        ? `${addon.price ?? 0}%`
                        : addon.pricing_model === 'per_attendee'
                        ? `$${addon.price ?? 0}/attendee`
                        : addon.pricing_model === 'monthly_per_grant'
                        ? `$${addon.price ?? 0}/grant/mo`
                        : `$${addon.price ?? 0}`
                      }
                    </p>
                    <p className="text-sm text-slate-600 capitalize">
                      {(addon.pricing_model || '').replace(/_/g, ' ')}
                    </p>
                  </div>

                  {addon.features && addon.features.length > 0 && (
                    <div className="space-y-2 mb-4">
                      {addon.features.map((feature, idx) => (
                        <div key={idx} className="flex items-start gap-2">
                          <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                          <span className="text-sm text-slate-700">{feature}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <Button variant="outline" className="w-full">
                    <Plus className="w-4 h-4 mr-2" />
                    Add to Plan
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* FAQ or Additional Info */}
        <Card className="bg-gradient-to-br from-blue-50 to-purple-50 border-blue-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-blue-600" />
              Need Help Choosing?
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-slate-700 mb-4">
              Not sure which plan is right for you? Our team can help you find the perfect fit for your organization's grant writing needs.
            </p>
            <Button className="bg-blue-600 hover:bg-blue-700">
              Schedule a Consultation
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}