import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import client from '@/api/client';
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, AlertCircle, DollarSign, Building2, FileText, CheckCircle2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

// Helper: round a monetary value to 2 decimals avoiding floating point error
const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Payment terms -> human readable label
const PAYMENT_TERMS_LABELS = {
  due_on_receipt: 'Due on Receipt',
  net_15: 'Net 15',
  net_30: 'Net 30',
  net_45: 'Net 45',
};

// Payment terms -> number of days. null indicates unknown/invalid term.
const PAYMENT_TERMS_DAYS = {
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
};

// Milestone descriptions for contract terms
const MILESTONE_DESCRIPTIONS = {
  kickoff: '40% due at project kickoff (scope locked; calendar set)',
  draft_delivery: '40% due at complete draft delivery',
  final_submission: '20% due at submission and handoff package delivery',
  full_payment: 'Full payment due',
};

// Contract terms template
const CONTRACT_TERMS = `SERVICE AGREEMENT

This invoice serves as a binding contract between John White (Consultant) and the Client listed above.

COMPENSATION TERMS:
• Compensation is for professional services rendered and is not contingent on award outcomes
• No percentage-based or commission compensation will ever be accepted
• Fees are based on time, expertise, and deliverables as outlined in the scope of work

PAYMENT TERMS:
• {{milestone_description}}
• Payment is due {{payment_terms}}
• Late payments subject to 1.5% monthly offense

FUNDER COMPLIANCE:
• Client understands some funders prohibit consultant payment from grant funds
• In such cases, invoices are paid by Client from non-grant funds
• Consultant will identify allowable costs where applicable

CONFIDENTIALITY:
• Health, immigration, and financial data will be safeguarded
• Records released only with written consent or as required by law

BENEVOLENCE POLICY:
• At Consultant's discretion, fees may be reduced or waived for hardship cases
• Any such reduction will not alter scope quality
• This reflects "The worker is worthy of his wages" (Luke 10:7) and mercy for those in need

CANCELLATION & REFUNDS:
• Client cancels before first draft → refund unworked portion (pro-rata)
• Consultant misses mutually agreed deadline due to error → full refund of that milestone

By accepting this invoice, Client agrees to these terms.`;
