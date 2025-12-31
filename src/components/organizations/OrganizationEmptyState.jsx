import React from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Building2, Plus } from "lucide-react";

/**
 * Empty state component for organizations list
 * @param {Object} props
 * @param {boolean} props.hasFilters - Whether any filters are applied
 * @param {Function} props.onCreateFirst - Callback to create first organization
 */
export default function OrganizationEmptyState({ hasFilters, onCreateFirst }) {
  return (
    <Card className="p-12 text-center shadow-lg border-0">
      <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
      <h3 className="text-xl font-semibold text-slate-900 mb-2">
        {hasFilters ? "No Matching Profiles" : "No Profiles Yet"}
      </h3>
      <p className="text-slate-600 mb-6">
        {hasFilters
          ? "Try adjusting your search or filter criteria"
          : "Get started by creating your first profile"}
      </p>
      {!hasFilters && (
        <Button
          onClick={onCreateFirst}
          className="bg-blue-600 hover:bg-blue-700"
          aria-label="Create first profile"
        >
          <Plus className="w-4 h-4 mr-2" />
          Create First Profile
        </Button>
      )}
    </Card>
  );
}