import React from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Receipt
} from "lucide-react";
import { createPageUrl } from "@/utils";

export default function ProfileCard({ profile, onViewInvoices }) {
  const navigate = useNavigate();
  const billing = profile.billing || {};
  const tier = billing.tier || {};
  
  // Calculate effective rates
  const monthlyRate = billing.custom_monthly_cents ?? tier.base_monthly_cents ?? 0;
  const hourlyRate = billing.custom_hourly_cents ?? tier.hourly_rate_cents ?? 0;
  
  // Apply discount
  const discountPercent = billing.discount_percent ?? 0;
  const effectiveMonthly = monthlyRate * (1 - discountPercent / 100);
  const effectiveHourly = hourlyRate * (1 - discountPercent / 100);
  
  const formatCurrency = (cents) => {
    if (!cents) return "$0";
    return `$${(cents / 100).toFixed(0)}`;
  };
  
  const getTierColor = (tierId) => {
    switch(tierId) {
      case 'foundation': return 'bg-slate-100 text-slate-700';
      case 'growth': return 'bg-blue-100 text-blue-700';
      case 'enterprise': return 'bg-purple-100 text-purple-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };
  
  const handleCardClick = () => {
    navigate(createPageUrl("OrganizationProfile", { id: profile.id }));
  };
  
  return (
    <Card 
      className="hover:shadow-lg transition-shadow cursor-pointer border-0 shadow-md"
      onClick={handleCardClick}
    >
      <CardHeader className="border-b border-slate-100">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1">
            {profile.avatar_url ? (
              <img 
                src={profile.avatar_url} 
                alt={profile.display_name}
                className="w-12 h-12 rounded-lg object-cover"
              />
            ) : (
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Building2 className="w-6 h-6 text-white" />
              </div>
            )}
            <div className="flex-1">
              <CardTitle className="text-lg">{profile.display_name}</CardTitle>
              <p className="text-sm text-slate-600 mt-1">{profile.primary_type || 'No type specified'}</p>
            </div>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="p-6 space-y-4">
        {/* Billing Tier */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600">Billing Tier</span>
            <Badge className={getTierColor(tier.id)}>
              {tier.name || 'Foundation'}
            </Badge>
          </div>
          
          {billing.is_pro_bono ? (
            <div className="flex items-center gap-2 p-3 bg-green-50 rounded-lg border border-green-200">
              <Heart className="w-4 h-4 text-green-600" />
              <span className="text-sm font-medium text-green-700">Pro Bono</span>
            </div>
          ) : (
            <>
              {/* Monthly Retainer */}
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-slate-600" />
                  <span className="text-sm text-slate-600">Monthly</span>
                </div>
                <span className="text-sm font-semibold text-slate-900">
                  {formatCurrency(effectiveMonthly)}/mo
                </span>
              </div>
              
              {/* Hourly Rate */}
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-slate-600" />
                  <span className="text-sm text-slate-600">Hourly</span>
                </div>
                <span className="text-sm font-semibold text-slate-900">
                  {formatCurrency(effectiveHourly)}/hr
                </span>
              </div>
            </>
          )}
          
          {/* Discounts */}
          {billing.discount_type && billing.discount_type !== 'none' && (
            <div className="flex items-center gap-2 p-3 bg-amber-50 rounded-lg border border-amber-200">
              {billing.discount_type === 'student' && <GraduationCap className="w-4 h-4 text-amber-600" />}
              {billing.discount_type === 'minister' && <Church className="w-4 h-4 text-amber-600" />}
              <span className="text-sm font-medium text-amber-700">
                {billing.discount_type === 'student' ? 'Student' : 'Minister'} Discount ({discountPercent}%)
              </span>
            </div>
          )}
        </div>
        
        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-100">
          <div className="text-center">
            <div className="text-xs text-slate-600 mb-1">Sections</div>
            <div className="text-lg font-bold text-slate-900">{profile.sections_complete || 0}</div>
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-600 mb-1">Pipeline</div>
            <div className="text-lg font-bold text-emerald-600">
              ${Math.round((profile.pipeline_funds_total || 0) / 1000)}k
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-600 mb-1">Docs</div>
            <div className="text-lg font-bold text-slate-900">{profile.document_count || 0}</div>
          </div>
        </div>
        
        {/* Actions */}
        <div className="flex gap-2 pt-3 border-t border-slate-100">
          <Button 
            variant="outline" 
            size="sm" 
            className="flex-1"
            onClick={(e) => {
              e.stopPropagation();
              onViewInvoices?.(profile);
            }}
          >
            <Receipt className="w-4 h-4 mr-2" />
            Invoices
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            className="flex-1"
            onClick={(e) => {
              e.stopPropagation();
              navigate(createPageUrl("Billing", { profile_id: profile.id }));
            }}
          >
            <FileText className="w-4 h-4 mr-2" />
            Billing
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
