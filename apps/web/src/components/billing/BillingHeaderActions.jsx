import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Building2, FileText, Printer, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Billing page header with organization selector and action buttons
 */
export default function BillingHeaderActions({ selectedOrgId, setSelectedOrgId, organizations }) {
  return (
    <div className="flex gap-3 w-full md:w-auto">
      <div className="flex-1 md:flex-none md:w-64">
        <Label htmlFor="org-select" className="sr-only">Select Organization</Label>
        <Select value={selectedOrgId || ""} onValueChange={setSelectedOrgId}>
          <SelectTrigger id="org-select" aria-label="Select organization">
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-slate-500" />
              <SelectValue placeholder="Select a profile..." />
            </div>
          </SelectTrigger>
          <SelectContent>
            {organizations.map(org => (
              <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      
      {selectedOrgId && (
        <>
          {/* Desktop buttons */}
          <div className="hidden md:flex gap-3">
            <Link to={createPageUrl(`BillingSheet?organization_id=${selectedOrgId}`)}>
              <Button variant="outline" className="whitespace-nowrap">
                <FileText className="w-4 h-4 mr-2" />
                Billing Sheet
              </Button>
            </Link>
            <Link to={createPageUrl("BillingSheet")}>
              <Button variant="outline" className="whitespace-nowrap">
                <Printer className="w-4 h-4 mr-2" />
                Master Sheet
              </Button>
            </Link>
            <Link to={createPageUrl(`CreateInvoice?organization_id=${selectedOrgId}`)}>
              <Button className="bg-emerald-600 hover:bg-emerald-700 whitespace-nowrap">
                <Plus className="w-4 h-4 mr-2" />
                Invoice
              </Button>
            </Link>
            <Link to={createPageUrl("NewProject")}>
              <Button className="bg-blue-600 hover:bg-blue-700 whitespace-nowrap">
                <Plus className="w-4 h-4 mr-2" />
                Project
              </Button>
            </Link>
          </div>

          {/* Mobile dropdown */}
          <div className="md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4 mr-2" />
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to={createPageUrl(`BillingSheet?organization_id=${selectedOrgId}`)} className="flex items-center">
                    <FileText className="w-4 h-4 mr-2" />
                    Billing Sheet
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={createPageUrl("BillingSheet")} className="flex items-center">
                    <Printer className="w-4 h-4 mr-2" />
                    Master Sheet
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={createPageUrl(`CreateInvoice?organization_id=${selectedOrgId}`)} className="flex items-center">
                    <Plus className="w-4 h-4 mr-2" />
                    Create Invoice
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={createPageUrl("NewProject")} className="flex items-center">
                    <Plus className="w-4 h-4 mr-2" />
                    New Project
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
    </div>
  );
}