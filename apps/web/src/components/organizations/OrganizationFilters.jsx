import React from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Filter, GraduationCap, Heart, Search } from "lucide-react";

/**
 * Organization filter and search component
 * @param {Object} props
 * @param {string} props.searchTerm - Current search term
 * @param {Function} props.onSearchChange - Callback when search changes
 * @param {string} props.typeFilter - Current type filter
 * @param {Function} props.onTypeChange - Callback when type filter changes
 */
export default function OrganizationFilters({ searchTerm, onSearchChange, typeFilter, onTypeChange }) {
  return (
    <Card className="p-6 mb-6 shadow-lg border-0">
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5" />
          <Input
            placeholder="Search by name, city, or state..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10"
            aria-label="Search organizations"
          />
        </div>
        <div className="flex gap-3">
          <Select value={typeFilter} onValueChange={onTypeChange}>
            <SelectTrigger className="w-48" aria-label="Filter by type">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder="Filter by type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="organization">
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4" />
                  Organizations
                </div>
              </SelectItem>
              <SelectItem value="high_school_student">
                <div className="flex items-center gap-2">
                  <GraduationCap className="w-4 h-4" />
                  High School Students
                </div>
              </SelectItem>
              <SelectItem value="college_student">
                <div className="flex items-center gap-2">
                  <GraduationCap className="w-4 h-4" />
                  College Students
                </div>
              </SelectItem>
              <SelectItem value="graduate_student">
                <div className="flex items-center gap-2">
                  <GraduationCap className="w-4 h-4" />
                  Graduate Students
                </div>
              </SelectItem>
              <SelectItem value="individual_need">
                <div className="flex items-center gap-2">
                  <Heart className="w-4 h-4" />
                  Individual Assistance
                </div>
              </SelectItem>
              <SelectItem value="medical_assistance">
                <div className="flex items-center gap-2">
                  <Heart className="w-4 h-4" />
                  Medical Assistance
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </Card>
  );
}