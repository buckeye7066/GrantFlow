import React, { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, Users, Zap, Target, Eye, X, CheckCircle2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const TIER_CONFIG = {
  hope: {
    name: "Hope",
    icon: Sparkles,
    color: "bg-blue-100 text-blue-800",
    max_profiles: 1,
    ai_searches_per_month: 10,
    features: ["basic_matching", "basic_drafting"],
    detailedFeatures: [
      "1 organization profile",
      "10 AI-powered searches per month",
      "Basic grant matching algorithm",
      "Basic AI proposal drafting",
      "Standard support",
      "Pay-what-you-can pricing available"
    ]
  },
  essential: {
    name: "Essential",
    icon: Users,
    color: "bg-teal-100 text-teal-800",
    max_profiles: 3,
    ai_searches_per_month: 50,
    features: ["basic_matching", "advanced_drafting", "export"],
    detailedFeatures: [
      "3 organization profiles",
      "50 AI searches per month",
      "Advanced AI proposal writing",
      "Export tools",
      "Email support",
      "Profile matching"
    ]
  },
  growth: {
    name: "Growth",
    icon: Users,
    color: "bg-purple-100 text-purple-800",
    max_profiles: 5,
    ai_searches_per_month: 100,
    features: ["basic_matching", "advanced_drafting", "basic_automation", "export"],
    detailedFeatures: [
      "5 organization profiles",
      "100 AI searches per month",
      "Advanced AI proposal writing",
      "Basic workflow automation",
      "Export and reporting tools",
      "Email support",
      "Profile matching history"
    ]
  },
  impact: {
    name: "Impact",
    icon: Zap,
    color: "bg-orange-100 text-orange-800",
    max_profiles: 999999,
    ai_searches_per_month: 999999,
    features: ["all"],
    detailedFeatures: [
      "Unlimited organization profiles",
      "Unlimited AI searches",
      "Full automation suite",
      "Advanced compliance tracking",
      "Comprehensive stewardship tools",
      "Priority AI processing",
      "Advanced reporting & analytics",
      "Workflow automation",
      "Calendar integration",
      "Priority support"
    ]
  },
  enterprise: {
    name: "Impact Enterprise",
    icon: Target,
    color: "bg-emerald-100 text-emerald-800",
    max_profiles: 999999,
    ai_searches_per_month: 999999,
    features: ["all", "dedicated_support", "custom_training"],
    detailedFeatures: [
      "Everything in Impact tier",
      "Dedicated success manager",
      "Custom training workshops",
      "White-label options",
      "API access",
      "Custom workflow design",
      "SLA guarantees",
      "Priority feature requests",
      "Multi-campus bundles available",
      "Custom integrations"
    ]
  },
  custom: {
    name: "Custom",
    icon: Target,
    color: "bg-violet-100 text-violet-800",
    max_profiles: 999999,
    ai_searches_per_month: 999999,
    features: ["all", "custom_everything"],
    detailedFeatures: [
      "Fully customized solution",
      "Custom pricing model",
      "Tailored feature set",
      "Dedicated infrastructure",
      "Custom SLAs",
      "White-label branding",
      "Priority development"
    ]
  }
};

export default function TierSimulator() {
  const [simulatedTier, setSimulatedTier] = useState(() => {
    return localStorage.getItem('simulated_tier') || 'impact';
  });
  const [viewingTier, setViewingTier] = useState(null);

  useEffect(() => {
    localStorage.setItem('simulated_tier', simulatedTier);
    window.dispatchEvent(new CustomEvent('tier-changed', { detail: simulatedTier }));
  }, [simulatedTier]);

  const currentTier = TIER_CONFIG[simulatedTier];
  const Icon = currentTier.icon;

  const handleTierClick = (key) => {
    setViewingTier(key);
  };

  const handleCloseView = () => {
    setViewingTier(null);
    setSimulatedTier('impact'); // Return to admin tier
  };

  return (
    <>
      <Card className="border-2 border-amber-300 bg-amber-50">
        <CardContent className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <Eye className="w-4 h-4 text-amber-700" />
            <p className="text-xs font-semibold text-amber-900">Tier View Mode</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(TIER_CONFIG).map(([key, tier]) => {
              const TierIcon = tier.icon;
              const isActive = simulatedTier === key;
              return (
                <button
                  key={key}
                  onClick={() => handleTierClick(key)}
                  className={`p-2 rounded-lg text-left transition-all border-2 ${
                    isActive 
                      ? 'bg-amber-600 text-white shadow-lg border-amber-700 scale-105' 
                      : 'bg-white text-slate-700 hover:bg-amber-100 border-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <TierIcon className="w-4 h-4" />
                    <span className="text-xs font-medium">{tier.name}</span>
                  </div>
                  {isActive && (
                    <div className="text-[10px] mt-1 opacity-90">Active</div>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-2 p-2 bg-white rounded border border-amber-200">
            <p className="text-xs text-amber-900 font-medium">
              <span className="font-bold">{currentTier.name}:</span>{' '}
              {currentTier.max_profiles === 999999 ? 'Unlimited' : currentTier.max_profiles} profiles • 
              {currentTier.ai_searches_per_month === 999999 ? ' Unlimited' : ` ${currentTier.ai_searches_per_month}`} searches
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Tier Details Dialog */}
      <Dialog open={viewingTier !== null} onOpenChange={() => setViewingTier(null)}>
        <DialogContent className="max-w-2xl">
          {viewingTier && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between">
                  <DialogTitle className="flex items-center gap-3">
                    {React.createElement(TIER_CONFIG[viewingTier].icon, { 
                      className: "w-8 h-8 text-blue-600" 
                    })}
                    <span className="text-2xl">{TIER_CONFIG[viewingTier].name} Tier</span>
                  </DialogTitle>
                </div>
                <DialogDescription>
                  Viewing features and capabilities of this tier
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* Quick Stats */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="text-sm text-slate-600 mb-1">Profiles</p>
                    <p className="text-2xl font-bold text-blue-900">
                      {TIER_CONFIG[viewingTier].max_profiles === 999999 
                        ? 'Unlimited' 
                        : TIER_CONFIG[viewingTier].max_profiles}
                    </p>
                  </div>
                  <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                    <p className="text-sm text-slate-600 mb-1">AI Searches/Month</p>
                    <p className="text-2xl font-bold text-purple-900">
                      {TIER_CONFIG[viewingTier].ai_searches_per_month === 999999 
                        ? 'Unlimited' 
                        : TIER_CONFIG[viewingTier].ai_searches_per_month}
                    </p>
                  </div>
                </div>

                {/* Features List */}
                <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                  <h3 className="font-semibold text-slate-900 mb-3">Features Included:</h3>
                  <div className="space-y-2">
                    {TIER_CONFIG[viewingTier].detailedFeatures.map((feature, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                        <span className="text-sm text-slate-700">{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-3 pt-4 border-t">
                  <Button
                    onClick={() => {
                      setSimulatedTier(viewingTier);
                      setViewingTier(null);
                    }}
                    className="flex-1"
                  >
                    <Eye className="w-4 h-4 mr-2" />
                    View as {TIER_CONFIG[viewingTier].name}
                  </Button>
                  <Button
                    onClick={handleCloseView}
                    variant="outline"
                    className="flex-1"
                  >
                    <X className="w-4 h-4 mr-2" />
                    Back to Admin View
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function useTierAccess(user = null) {
  const [simulatedTier, setSimulatedTier] = useState(() => {
    return localStorage.getItem('simulated_tier') || null;
  });

  useEffect(() => {
    const handleTierChange = (e) => {
      setSimulatedTier(e.detail);
    };
    window.addEventListener('tier-changed', handleTierChange);
    return () => window.removeEventListener('tier-changed', handleTierChange);
  }, []);

  // Hardcoded tier overrides for specific users
  const TIER_OVERRIDES = {
    'oliviabeltran@gmail.com': 'enterprise',
    'rdashermiller@gmail.com': 'enterprise'
  };
  
  // Priority: 1) localStorage simulation (for admins), 2) hardcoded override, 3) user's stored tier, 4) default 'hope'
  const effectiveTier = simulatedTier || TIER_OVERRIDES[user?.email] || user?.tier || 'hope';
  const tierConfig = TIER_CONFIG[effectiveTier] || TIER_CONFIG['hope'];

  return {
    tier: effectiveTier,
    tierName: tierConfig.name,
    canAccess: (feature) => {
      if (tierConfig.features.includes('all')) return true;
      return tierConfig.features.includes(feature);
    },
    limits: {
      maxProfiles: tierConfig.max_profiles,
      aiSearches: tierConfig.ai_searches_per_month
    },
    isHope: effectiveTier === 'hope',
    isGrowth: effectiveTier === 'growth',
    isImpact: effectiveTier === 'impact',
    isEnterprise: effectiveTier === 'enterprise'
  };
}