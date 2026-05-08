import React from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useProfileTypes, canonicalizeProfileTypeId } from "@/services/profileTypes"

/**
 * Canonical profile-type selector. Backed by the curated UI list in
 * shared/profileTypeOptions.js (rendered immediately) and enriched
 * over /api/profile-types via useProfileTypes(). Every selector in
 * the app should use this component so we never fall back to a
 * hardcoded list.
 *
 * Props:
 *   value         current canonical id (or legacy alias). Empty string
 *                 / null / undefined renders the placeholder.
 *   onChange      called with the newly selected canonical id (after
 *                 alias canonicalisation). Always a string.
 *   placeholder   placeholder text (defaults to "Select profile type").
 *   id            optional id forwarded to the trigger (for label[for]).
 *   disabled      pass-through.
 */
export default function ProfileTypeSelect({
  value,
  onChange,
  placeholder = "Select profile type",
  id,
  disabled,
  className,
  required,
}) {
  const { grouped } = useProfileTypes()
  const safeValue = value ? canonicalizeProfileTypeId(value) : undefined

  return (
    <Select
      value={safeValue || undefined}
      onValueChange={(next) => onChange?.(canonicalizeProfileTypeId(next ?? "") || "")}
      disabled={disabled}
      required={required}
    >
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
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
  )
}
