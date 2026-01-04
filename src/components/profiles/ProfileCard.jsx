import React from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Building2, 
  DollarSign, 
  FileText, 
  TrendingUp,
  Heart,
  GraduationCap,
  Church,
  Receipt,
  Trash2,
  AlertTriangle
} from "lucide-react";
import { createPageUrl } from "@/utils";

export default function ProfileCard({ profile, onViewInvoices, onDelete }) {
  const navigate = useNavigate();
  const billing = profile.billing || {};
  const tier = billing.tier || {};
  const detailUrl = createPageUrl("ProfileDetail", { id: profile.id });

  const monthlyRate = billing.custom_monthly_cents ?? tier.base_monthly_cents ?? 0;
  const hourlyRate = billing.custom_hourly_cents ?? tier.hourly_rate_cents ?? 0;

  const discountPercent = billing.discount_percent ?? 0;
  const effectiveMonthly = monthlyRate * (1 - discountPercent / 100);
  const effectiveHourly = hourlyRate * (1 - discountPercent / 100);

  const formatCurrency = (cents) => {
    if (!cents) return "$0";
    return `$${(cents / 100).toFixed(0)}`;
  };

  const getTierColor = (tierId) => {
    switch (tierId) {
      case "foundation":
        return "bg-slate-100 text-slate-700";
      case "growth":
        return "bg-blue-100 text-blue-700";
      case "enterprise":
        return "bg-purple-100 text-purple-700";
      default:
        return "bg-gray-100 text-gray-700";
    }
  };

  const handleNavigate = () => {
    if (!profile?.id) return;
    navigate(detailUrl);
  };

  const handleCardKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleNavigate();
    }
  };

  const isOrphanedProfile = !profile.organization_id && !profile.user_id;

  const cardClassName = [
    "group relative border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-lg",
    isOrphanedProfile && "border-orange-300"
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card className={cardClassName}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open profile ${profile.display_name}`}
        onClick={handleNavigate}
        onKeyDown={handleCardKeyDown}
        className="flex flex-col rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 cursor-pointer"
      >
        <CardHeader className="border-b border-slate-100">
          {isOrphanedProfile && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-600" />
              <div className="flex-1">
                <p className="text-sm font-medium text-orange-900">Orphaned Profile</p>
                <p className="mt-1 text-xs text-orange-700">
                  This profile is not linked to an organization. You can delete it to remove it from your list.
                </p>
              </div>
            </div>
          )}
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-1 items-start gap-3">
              {profile.avatar_url ? (
                <img
                  src={profile.avatar_url}
                  alt={profile.display_name}
                  className="h-12 w-12 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
                  <Building2 className="h-6 w-6 text-white" />
                </div>
              )}
              <div className="flex-1">
                <CardTitle className="text-lg">{profile.display_name}</CardTitle>
                <p className="mt-1 text-sm text-slate-600">{profile.primary_type || "No type specified"}</p>
              </div>
            </div>
          </div>
        </CardHeader>

        <div className="px-6 pb-6 pt-6 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600">Billing Tier</span>
              <Badge className={getTierColor(tier.id)}>{tier.name || "Foundation"}</Badge>
            </div>

            {billing.is_pro_bono ? (
              <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3">
                <Heart className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium text-green-700">Pro Bono</span>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3">
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-slate-600" />
                    <span className="text-sm text-slate-600">Monthly</span>
                  </div>
                  <span className="text-sm font-semibold text-slate-900">{formatCurrency(effectiveMonthly)}/mo</span>
                </div>

                <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-slate-600" />
                    <span className="text-sm text-slate-600">Hourly</span>
                  </div>
                  <span className="text-sm font-semibold text-slate-900">{formatCurrency(effectiveHourly)}/hr</span>
                </div>
              </>
            )}

            {billing.discount_type && billing.discount_type !== "none" && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                {billing.discount_type === "student" && <GraduationCap className="h-4 w-4 text-amber-600" />}
                {billing.discount_type === "minister" && <Church className="h-4 w-4 text-amber-600" />}
                <span className="text-sm font-medium text-amber-700">
                  {billing.discount_type === "student" ? "Student" : "Minister"} Discount ({discountPercent}%)
                </span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3 border-t border-slate-100 pt-3">
            <div className="text-center">
              <div className="mb-1 text-xs text-slate-600">Sections</div>
              <div className="text-lg font-bold text-slate-900">{profile.sections_complete || 0}</div>
            </div>
            <div className="text-center">
              <div className="mb-1 text-xs text-slate-600">Pipeline</div>
              <div className="text-lg font-bold text-emerald-600">
                ${Math.round((profile.pipeline_funds_total || 0) / 1000)}k
              </div>
            </div>
            <div className="text-center">
              <div className="mb-1 text-xs text-slate-600">Docs</div>
              <div className="text-lg font-bold text-slate-900">{profile.document_count || 0}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 pb-6 pt-0">
        <div className="flex gap-2 border-t border-slate-100 pt-3">
          {isOrphanedProfile ? (
            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              onClick={(event) => {
                event.stopPropagation();
                onDelete?.(profile);
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Profile
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={(event) => {
                  event.stopPropagation();
                  onViewInvoices?.(profile);
                }}
              >
                <Receipt className="mr-2 h-4 w-4" />
                Invoices
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(createPageUrl("Billing", { profile_id: profile.id }));
                }}
              >
                <FileText className="mr-2 h-4 w-4" />
                Billing
              </Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
