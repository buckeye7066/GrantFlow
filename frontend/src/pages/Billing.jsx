import React, { useState, useEffect, useCallback } from "react";

import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { useAuthContext } from "@/components/hooks/useAuthRLS";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  Sparkles,
  Users,
  Zap,
  Target,
  DollarSign,
  CheckCircle2,
  Package,
} from "lucide-react";
import BillingHeaderActions from "../components/billing/BillingHeaderActions";
import BillingStats from "../components/billing/BillingStats";
import EthicalBillingBanner from "../components/billing/EthicalBillingBanner";
import BillingTabs from "../components/billing/BillingTabs";
import { BillingSkeleton } from "../components/billing/BillingSkeleton";
import { useBillingData } from "../components/hooks/useBillingData";
import { useInvoiceScheduler } from "../components/hooks/useInvoiceScheduler";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TIER_ICONS = {
  Hope: Sparkles,
  Growth: Users,
  Impact: Zap,
  "Impact Enterprise": Target,
};

const TIER_COLORS = {
  Hope: "from-blue-500 to-cyan-500",
  Growth: "from-purple-500 to-pink-500",
  Impact: "from-orange-500 to-red-500",
  "Impact Enterprise": "from-emerald-500 to-teal-500",
};

export default function Billing() {
  const [activeTab, setActiveTab] = useState("subscriptions");
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [expandedPlans, setExpandedPlans] = useState({});
  const [expandedAddOns, setExpandedAddOns] = useState({});

  const { user, isAdmin, isLoadingUser } = useAuthContext();

  const {
    organizations,
    filteredProjects,
    filteredInvoices,
    filteredTimeLogs,
    selectedOrg,
    unbilledAmount,
    totalAR,
    overdueInvoices,
    activeProjectsCount,
    isLoading,
  } = useBillingData(selectedOrgId);

  const { data: subscriptionPlans = [], isLoading: isLoadingPlans } = useQuery({
    queryKey: ["subscriptionPlans", user?.email, isAdmin],
    queryFn: () => base44.entities.SubscriptionPlan.filter({ is_active: true }),
    enabled: Boolean(user?.email),
  });

  const { data: addOns = [], isLoading: isLoadingAddOns } = useQuery({
    queryKey: ["addOns", user?.email, isAdmin],
    queryFn: () => base44.entities.AddOn.filter({ is_active: true }),
    enabled: Boolean(user?.email),
  });

  const { data: userSubscriptions = [], isLoading: isLoadingUserSubscriptions } = useQuery({
    queryKey: ["userSubscriptions", user?.id, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.UserSubscription.list()
        : base44.entities.UserSubscription.filter({ user_id: user?.id }),
    enabled: Boolean(user?.id),
  });

  const handleOrgSelection = useCallback((nextOrgId) => {
    if (nextOrgId === null || nextOrgId === undefined) {
      setSelectedOrgId("");
      return;
    }

    const value = String(nextOrgId);
    setSelectedOrgId(value);
  }, []);

  useEffect(() => {
    if (organizations.length > 0 && !selectedOrgId) {
      handleOrgSelection(organizations[0].id);
    }
  }, [organizations, selectedOrgId, handleOrgSelection]);

  useInvoiceScheduler();

  if (
    isLoadingUser ||
    isLoading ||
    isLoadingPlans ||
    isLoadingAddOns ||
    isLoadingUserSubscriptions
  ) {
    return <BillingSkeleton />;
  }

  const hasSelectedOrg = Boolean(selectedOrgId);

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Billing & Invoicing</h1>
            <p className="text-slate-600 mt-2">
              Subscription tiers, add-ons, and transparent compensation tracking
            </p>
          </div>

          <BillingHeaderActions
            selectedOrgId={selectedOrgId}
            setSelectedOrgId={handleOrgSelection}
            organizations={organizations}
          />
        </div>

        <div className="mb-6">
          <EthicalBillingBanner />
        </div>

        {!hasSelectedOrg ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Profile Selected</h3>
              <p className="text-slate-600">
                Please select a profile from the dropdown above to view billing and invoicing information.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="mb-8">
              <BillingStats
                activeProjectsCount={activeProjectsCount}
                unbilledAmount={unbilledAmount}
                totalAR={totalAR}
                overdueCount={overdueInvoices.length}
              />
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="subscriptions">Subscription Tiers</TabsTrigger>
                <TabsTrigger value="addons">Add-Ons</TabsTrigger>
                <TabsTrigger value="invoicing">Time & Invoicing</TabsTrigger>
              </TabsList>

              <TabsContent value="subscriptions" className="space-y-6 mt-6">
                <div className="grid md:grid-cols-2 gap-6">
                  {subscriptionPlans.map((plan) => {
                    const planKey = String(plan.id);
                    const Icon = TIER_ICONS[plan.tier_name] || Sparkles;
                    const gradient = TIER_COLORS[plan.tier_name] || "from-blue-500 to-purple-500";
                    const isExpanded = Boolean(expandedPlans[planKey]);
                    const features = Array.isArray(plan.features) ? plan.features : [];
                    const visibleFeatures = isExpanded ? features : features.slice(0, 5);
                    const userSub = userSubscriptions.find(
                      (sub) => String(sub.plan_id) === planKey,
                    );

                    return (
                      <Card key={planKey} className="relative overflow-hidden">
                        <div className={`absolute top-0 left-0 right-0 h-2 bg-gradient-to-r ${gradient}`} />
                        <CardHeader>
                          <div className="flex items-start justify-between">
                            <div>
                              <CardTitle className="flex items-center gap-2 text-xl">
                                <Icon className="w-5 h-5" />
                                {plan.tier_name}
                              </CardTitle>
                              <CardDescription className="mt-2">
                                ${plan.monthly_price}/month
                                {plan.pay_what_you_can && " • Pay-what-you-can available"}
                              </CardDescription>
                            </div>
                            {userSub && <Badge className="bg-green-100 text-green-800">Active</Badge>}
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-4">
                            <div>
                              <p className="text-sm font-semibold text-slate-700 mb-2">Key Features:</p>
                              <ul className="space-y-2">
                                {visibleFeatures.map((feature, idx) => (
                                  <li key={idx} className="flex items-start gap-2 text-sm">
                                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                                    <span className="text-slate-600">{feature}</span>
                                  </li>
                                ))}
                                {features.length === 0 && (
                                  <li className="text-sm text-slate-500">No features listed.</li>
                                )}
                              </ul>
                              {features.length > 5 && (
                                <button
                                  onClick={() =>
                                    setExpandedPlans((prev) => ({
                                      ...prev,
                                      [planKey]: !isExpanded,
                                    }))
                                  }
                                  className="text-xs text-blue-600 hover:text-blue-700 font-medium mt-2"
                                >
                                  {isExpanded
                                    ? "Show less"
                                    : `+ ${features.length - 5} more features`}
                                </button>
                              )}
                            </div>
                            {Array.isArray(plan.ideal_for) && plan.ideal_for.length > 0 && (
                              <div>
                                <p className="text-sm font-semibold text-slate-700 mb-2">Ideal For:</p>
                                <div className="flex flex-wrap gap-2">
                                  {plan.ideal_for.slice(0, 3).map((type, idx) => (
                                    <Badge key={idx} variant="outline" className="text-xs">
                                      {type}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </TabsContent>

              <TabsContent value="addons" className="space-y-6 mt-6">
                <div className="grid md:grid-cols-2 gap-6">
                  {addOns.map((addon) => {
                    const addOnKey = String(addon.id);
                    const features = Array.isArray(addon.features) ? addon.features : [];
                    const isExpanded = Boolean(expandedAddOns[addOnKey]);
                    const visibleFeatures = isExpanded ? features : features.slice(0, 4);

                    return (
                      <Card key={addOnKey}>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <Package className="w-5 h-5 text-blue-600" />
                            {addon.addon_name}
                          </CardTitle>
                          <CardDescription className="flex items-center gap-2 mt-2">
                            <DollarSign className="w-4 h-4" />
                            {addon.pricing_model === "percentage" && `${addon.price}% of award`}
                            {addon.pricing_model === "flat_fee" && `$${addon.price} flat fee`}
                            {addon.pricing_model === "per_attendee" && `$${addon.price} per attendee`}
                            {addon.pricing_model === "per_organization" &&
                              `$${addon.price} per organization`}
                            {addon.pricing_model === "monthly_per_grant" &&
                              `$${addon.price}/month per grant`}
                            {addon.pricing_model === "custom" && "Custom pricing"}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm text-slate-600 mb-4">{addon.description}</p>
                          {features.length > 0 ? (
                            <div>
                              <p className="text-sm font-semibold text-slate-700 mb-2">Includes:</p>
                              <ul className="space-y-1">
                                {visibleFeatures.map((feature, idx) => (
                                  <li key={idx} className="flex items-start gap-2 text-sm">
                                    <CheckCircle2 className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                                    <span className="text-slate-600">{feature}</span>
                                  </li>
                                ))}
                              </ul>
                              {features.length > 4 && (
                                <button
                                  onClick={() =>
                                    setExpandedAddOns((prev) => ({
                                      ...prev,
                                      [addOnKey]: !isExpanded,
                                    }))
                                  }
                                  className="text-xs text-blue-600 hover:text-blue-700 font-medium mt-2"
                                >
                                  {isExpanded
                                    ? "Show less"
                                    : `+ ${features.length - 4} more features`}
                                </button>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-slate-500">No additional features listed.</p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </TabsContent>

              <TabsContent value="invoicing" className="mt-6">
                <BillingTabs
                  activeTab="overview"
                  setActiveTab={() => {}}
                  filteredProjects={filteredProjects}
                  filteredInvoices={filteredInvoices}
                  filteredTimeLogs={filteredTimeLogs}
                  selectedOrg={selectedOrg}
                />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}