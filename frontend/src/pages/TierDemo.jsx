/**
 * TierDemo.jsx
 * 
 * Demonstrates tier-based feature access with cinematic UI.
 * 
 * KEY CONCEPTS:
 * - All access logic flows through canAccess(featureId)
 * - Limits are accessed via limits.maxProfiles and limits.aiSearches
 * - FeatureGate uses minTier prop (not requiredTier)
 * - Use displayLimit() helper for "Unlimited" display
 * 
 * TIER HIERARCHY:
 * hope < growth < impact < enterprise
 * 
 * FEATURES BY TIER:
 * - hope: basic_matching, basic_drafting
 * - growth: + advanced_drafting, basic_automation, export
 * - impact: all features
 * - enterprise: all + dedicated_support, custom_training
 */

import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTierAccess } from "@/components/billing/TierSimulator";
import { FeatureGate, FeatureBadge, LockedOverlay } from "@/components/billing/FeatureGate";
import {
  Sparkles,
  Users,
  Zap,
  Target,
  Search,
  FileText,
  BarChart3,
  Database,
  Crown,
  Star
} from "lucide-react";

/**
 * Normalize limit values for display.
 * Converts unlimited indicators to "Unlimited" string.
 * @param {number|null} value - The limit value
 * @returns {string|number} - "Unlimited" or the numeric value
 */
const displayLimit = (value) => {
  if (value === null || value === undefined) return "Unlimited";
  if (value >= 99999 || value === Infinity || value === -1) return "Unlimited";
  return value;
};

export default function TierDemo() {
  // Extract tier access data with safe defaults
  const tierAccess = useTierAccess() || {};
  const { 
    tier = 'impact', 
    tierName = 'Impact', 
    limits = {}, 
    canAccess = () => true,
    isHope = false,
    isGrowth = false,
    isImpact = false,
    isEnterprise = false
  } = tierAccess;

  // Safe limit extraction with displayLimit helper
  const maxProfiles = displayLimit(limits?.maxProfiles);
  const maxSearches = displayLimit(limits?.aiSearches);

  return (
    <div className="p-6 md:p-8 min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-purple-50 bg-fixed animate-fadeIn">
      <div className="max-w-7xl mx-auto">
        
        {/* Cinematic Header with Sparkles */}
        <div className="relative mb-8">
          {/* Animated glow backdrop */}
          <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-purple-400/20 via-blue-400/20 to-transparent blur-3xl -z-10" />
          
          <div className="flex items-center gap-3 mb-2">
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-r from-purple-500 to-blue-500 blur-lg opacity-50 animate-pulse" />
              <div className="relative p-3 bg-gradient-to-br from-purple-600 to-blue-600 rounded-xl shadow-lg">
                <Crown className="w-8 h-8 text-white" />
              </div>
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900">Feature Access by Tier</h1>
              <p className="text-slate-600">
                Explore how features unlock at each subscription level
              </p>
            </div>
          </div>
        </div>

        {/* Feature Matrix Explainer Banner */}
        <div className="relative mb-8 p-6 rounded-2xl overflow-hidden bg-gradient-to-r from-slate-900 via-purple-900 to-slate-900 border border-purple-500/30 shadow-2xl">
          {/* Holographic grid overlay */}
          <div 
            className="absolute inset-0 opacity-10"
            style={{
              backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)',
              backgroundSize: '20px 20px'
            }}
          />
          {/* Animated sparkle particles */}
          <div className="absolute top-4 right-4 animate-pulse">
            <Star className="w-6 h-6 text-yellow-400 fill-yellow-400" />
          </div>
          <div className="absolute bottom-4 left-8 animate-pulse delay-300">
            <Sparkles className="w-5 h-5 text-purple-400" />
          </div>
          <div className="absolute top-6 left-1/3 animate-pulse delay-500">
            <Star className="w-4 h-4 text-blue-400 fill-blue-400" />
          </div>
          
          <div className="relative z-10 flex items-center gap-6 flex-wrap">
            {/* Rotating tier emblems */}
            <div className="flex gap-2">
              {[
                { icon: Sparkles, color: 'text-blue-400', tier: 'Hope' },
                { icon: Users, color: 'text-purple-400', tier: 'Growth' },
                { icon: Zap, color: 'text-orange-400', tier: 'Impact' },
                { icon: Target, color: 'text-emerald-400', tier: 'Enterprise' }
              ].map(({ icon: Icon, color, tier: t }) => (
                <div 
                  key={t} 
                  className={`p-2 rounded-lg bg-white/10 backdrop-blur-sm border border-white/20 transition-transform hover:scale-110 ${tierName === t ? 'ring-2 ring-white shadow-lg' : ''}`}
                  title={t}
                >
                  <Icon className={`w-5 h-5 ${color}`} />
                </div>
              ))}
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-bold text-white mb-1">Tier Feature Matrix</h2>
              <p className="text-purple-200 text-sm">
                Each tier unlocks progressively more powerful capabilities. 
                Use the simulator in the sidebar to preview different access levels.
              </p>
            </div>
          </div>
        </div>

        {/* Current Tier Info Card */}
        <Alert className="mb-8 transition-all hover:scale-[1.01] hover:shadow-lg rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
          <Crown className="h-4 w-4 text-amber-600" />
          <AlertDescription>
            <strong className="text-slate-900">Viewing as: {tierName || 'Unknown'}</strong>
            <div className="text-sm mt-1 text-slate-600">
              Limits: {maxProfiles} profiles • {maxSearches} AI searches/month
            </div>
          </AlertDescription>
        </Alert>

        {/* Features Grid */}
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          
          {/* Basic Grant Matching - Available to All */}
          <Card className="transition-all hover:scale-[1.02] hover:shadow-2xl hover:-translate-y-1 rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-blue-100">
                      <Search className="w-5 h-5 text-blue-600" />
                    </div>
                    Basic Grant Matching
                  </CardTitle>
                  <CardDescription className="mt-2">Search and discover funding opportunities</CardDescription>
                </div>
                <Badge className="bg-green-100 text-green-800">All Tiers</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600 mb-4">
                Search through thousands of funding opportunities with basic keyword matching.
              </p>
              <Button className="w-full">Search Opportunities</Button>
            </CardContent>
          </Card>

          {/* Advanced AI Writing - Growth+ */}
          <FeatureGate feature="advanced_drafting" minTier="growth">
            <Card className="transition-all hover:scale-[1.02] hover:shadow-2xl hover:-translate-y-1 rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-purple-100">
                        <FileText className="w-5 h-5 text-purple-600" />
                      </div>
                      Advanced AI Writing
                    </CardTitle>
                    <CardDescription className="mt-2">AI-powered proposal drafting</CardDescription>
                  </div>
                  <FeatureBadge minTier="growth" />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600 mb-4">
                  Generate complete grant proposals with advanced AI assistance.
                </p>
                <Button className="w-full bg-purple-600 hover:bg-purple-700">
                  Generate Proposal
                </Button>
              </CardContent>
            </Card>
          </FeatureGate>

          {/* Full Automation Suite - Impact+ */}
          <FeatureGate feature="automation_suite" minTier="impact">
            <Card className="transition-all hover:scale-[1.02] hover:shadow-2xl hover:-translate-y-1 rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-orange-100">
                        <Zap className="w-5 h-5 text-orange-600" />
                      </div>
                      Full Automation Suite
                    </CardTitle>
                    <CardDescription className="mt-2">Complete workflow automation</CardDescription>
                  </div>
                  <FeatureBadge minTier="impact" />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600 mb-4">
                  Auto-advance, auto-tagging, scheduled crawls, and bulk processing.
                </p>
                <Button className="w-full bg-orange-600 hover:bg-orange-700">
                  Configure Automation
                </Button>
              </CardContent>
            </Card>
          </FeatureGate>

          {/* API Access - Impact+ */}
          <FeatureGate feature="api_access" minTier="impact">
            <Card className="transition-all hover:scale-[1.02] hover:shadow-2xl hover:-translate-y-1 rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-blue-100">
                        <Database className="w-5 h-5 text-blue-600" />
                      </div>
                      API Access
                    </CardTitle>
                    <CardDescription className="mt-2">Integrate with external systems</CardDescription>
                  </div>
                  <FeatureBadge minTier="impact" />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600 mb-4">
                  Connect GrantFlow to your existing tools and workflows.
                </p>
                <Button className="w-full">View API Docs</Button>
              </CardContent>
            </Card>
          </FeatureGate>

          {/* White-Label Reports - Impact+ */}
          <FeatureGate feature="white_label_reports" minTier="impact">
            <Card className="transition-all hover:scale-[1.02] hover:shadow-2xl hover:-translate-y-1 rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-green-100">
                        <BarChart3 className="w-5 h-5 text-green-600" />
                      </div>
                      White-Label Reports
                    </CardTitle>
                    <CardDescription className="mt-2">Professional branded reports</CardDescription>
                  </div>
                  <FeatureBadge minTier="impact" />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600 mb-4">
                  Generate custom-branded reports for clients with your logo.
                </p>
                <Button className="w-full bg-green-600 hover:bg-green-700">
                  Generate Report
                </Button>
              </CardContent>
            </Card>
          </FeatureGate>

          {/* Dedicated Account Manager - Enterprise Only */}
          <FeatureGate feature="dedicated_support" minTier="enterprise">
            <Card className="transition-all hover:scale-[1.02] hover:shadow-2xl hover:-translate-y-1 rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-emerald-100">
                        <Target className="w-5 h-5 text-emerald-600" />
                      </div>
                      Dedicated Account Manager
                    </CardTitle>
                    <CardDescription className="mt-2">Personal support and training</CardDescription>
                  </div>
                  <FeatureBadge minTier="enterprise" />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600 mb-4">
                  Get a dedicated account manager for personalized support and training.
                </p>
                <Button className="w-full bg-emerald-600 hover:bg-emerald-700">
                  Contact Manager
                </Button>
              </CardContent>
            </Card>
          </FeatureGate>
        </div>

        {/* Usage Limits Demo */}
        <Card className="mb-8 transition-all hover:scale-[1.01] hover:shadow-2xl rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-blue-600" />
              Usage Limits
            </CardTitle>
            <CardDescription>Current tier restrictions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Organization Profiles</span>
                  <span className="text-sm text-slate-600">
                    {maxProfiles === "Unlimited" ? 'Unlimited' : `0 / ${maxProfiles}`}
                  </span>
                </div>
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all"
                    style={{ width: maxProfiles === "Unlimited" ? '100%' : '0%' }}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">AI Searches This Month</span>
                  <span className="text-sm text-slate-600">
                    {maxSearches === "Unlimited" ? 'Unlimited' : `0 / ${maxSearches}`}
                  </span>
                </div>
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-purple-500 to-purple-600 transition-all"
                    style={{ width: maxSearches === "Unlimited" ? '100%' : '0%' }}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Locked Overlay Demo */}
        <Card className="transition-all hover:scale-[1.01] hover:shadow-2xl rounded-2xl backdrop-blur-xl bg-white/70 shadow-xl border border-white/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-orange-600" />
              Premium Dashboard (Impact+)
            </CardTitle>
            <CardDescription>Example of locked content with overlay</CardDescription>
          </CardHeader>
          <CardContent>
            <LockedOverlay minTier="impact">
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl border border-blue-200 shadow-sm">
                  <div className="text-2xl font-bold text-blue-900">1,247</div>
                  <div className="text-sm text-blue-700">Total Grants</div>
                </div>
                <div className="p-4 bg-gradient-to-br from-green-50 to-green-100 rounded-xl border border-green-200 shadow-sm">
                  <div className="text-2xl font-bold text-green-900">$4.2M</div>
                  <div className="text-sm text-green-700">Total Funding</div>
                </div>
                <div className="p-4 bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl border border-purple-200 shadow-sm">
                  <div className="text-2xl font-bold text-purple-900">87%</div>
                  <div className="text-sm text-purple-700">Success Rate</div>
                </div>
              </div>
            </LockedOverlay>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}