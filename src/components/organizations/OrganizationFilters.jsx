import React from "react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Filter, Search } from "lucide-react"
import { useProfileTypes } from "@/services/profileTypes"

/**
 * Organization filter and search component. Profile-type filter is
 * driven by the canonical curated list so adding a new profile type
 * automatically gives users a way to filter for it.
 */
export default function OrganizationFilters({ searchTerm, onSearchChange, typeFilter, onTypeChange }) {
  const { grouped } = useProfileTypes()

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
          <Select
            value={typeFilter || "all"}
            onValueChange={(value) => onTypeChange(value || "all")}
          >
            <SelectTrigger className="w-56" aria-label="Filter by type">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder="Filter by type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {grouped.map(({ group, options }) => (
                <React.Fragment key={group}>
                  <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {group}
                  </div>
                  {options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </React.Fragment>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </Card>
  )
}
