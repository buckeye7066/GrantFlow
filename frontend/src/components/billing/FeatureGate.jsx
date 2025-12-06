import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Lock, Sparkles, Users, Zap, Target } from "lucide-react";
import { useTierAccess } from "./TierSimulator";

const TIER_ICONS = {
  hope: Sparkles,
  growth: Users,
  impact: Zap,
  enterprise: Target
};

export function FeatureGate({ feature, minTier, requiredTier, children, fallback }) {
  const { canAccess, tier, tierName } = useTierAccess();
  
  // Support both minTier (new) and requiredTier (legacy) props
  if (minTier && requiredTier && minTier !== requiredTier) {
    console.warn('[FeatureGate] Both minTier and requiredTier provided. Use minTier only. requiredTier is deprecated.');
  }
  const effectiveTier = minTier || requiredTier || "impact";

  if (canAccess(feature)) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  const RequiredIcon = TIER_ICONS[effectiveTier] || Zap;

  return (
    <Card className="border-2 border-dashed border-slate-300 bg-slate-50/80 backdrop-blur-sm">
      <CardContent className="p-8 text-center">
        <div className="relative inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-slate-200 to-slate-300 rounded-full mb-4 shadow-lg">
          <Lock className="w-8 h-8 text-slate-500 animate-pulse" />
        </div>
        <h3 className="text-lg font-semibold text-slate-900 mb-2">
          Feature Locked
        </h3>
        <p className="text-slate-600 mb-4">
          This feature requires{" "}
          <Badge variant="outline" className="inline-flex items-center gap-1">
            <RequiredIcon className="w-3 h-3" />
            {effectiveTier.charAt(0).toUpperCase() + effectiveTier.slice(1)}
          </Badge>{" "}
          tier or higher
        </p>
        <div className="text-sm text-slate-500 mb-4">
          Current tier: <strong>{tierName || 'Unknown'}</strong>
        </div>
        <Button variant="outline" disabled>
          Upgrade to Unlock
        </Button>
      </CardContent>
    </Card>
  );
}

export function FeatureBadge({ requiredTier = "impact" }) {
  const RequiredIcon = TIER_ICONS[requiredTier] || Zap;
  
  return (
    <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
      <RequiredIcon className="w-3 h-3 mr-1" />
      {requiredTier.charAt(0).toUpperCase() + requiredTier.slice(1)}+ Only
    </Badge>
  );
}

export function LockedOverlay({ minTier, requiredTier, children }) {
  const { canAccess } = useTierAccess();
  
  // Support both minTier (new) and requiredTier (legacy) props
  if (minTier && requiredTier && minTier !== requiredTier) {
    console.warn('[LockedOverlay] Both minTier and requiredTier provided. Use minTier only. requiredTier is deprecated.');
  }
  const effectiveTier = minTier || requiredTier || "impact";

  if (canAccess('all') || canAccess(effectiveTier)) {
    return <>{children}</>;
  }

  const RequiredIcon = TIER_ICONS[effectiveTier] || Zap;

  return (
    <div className="relative rounded-xl overflow-hidden">
      <div className="opacity-30 pointer-events-none">
        {children}
      </div>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-md flex flex-col gap-2 items-center justify-center text-white animate-fadeIn">
        <div className="p-4 bg-white/10 rounded-full backdrop-blur-sm border border-white/20">
          <Lock className="w-10 h-10 text-purple-200 animate-pulse" />
        </div>
        <p className="text-sm font-semibold opacity-90">Upgrade to unlock</p>
        <Badge variant="outline" className="inline-flex items-center gap-1 bg-white/10 border-white/30 text-white">
          <RequiredIcon className="w-3 h-3" />
          Requires {effectiveTier.charAt(0).toUpperCase() + effectiveTier.slice(1)}
        </Badge>
      </div>
    </div>
  );
}