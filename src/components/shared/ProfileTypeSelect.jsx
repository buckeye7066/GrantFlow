import React from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
      {/*
        position="popper" + a height bound to the space actually available next
        to the trigger keeps this long, grouped list inside the viewport: it
        opens downward when there's room and scrolls otherwise, instead of
        overflowing above the top of the screen with the first groups
        unreachable and the rendered rows desynced from their click targets
        (which silently selected the wrong type). Group headers use the Radix
        SelectGroup/SelectLabel primitives so they stay out of the interactive
        item collection.
      */}
      <SelectContent
        position="popper"
        className="max-h-[min(24rem,var(--radix-select-content-available-height))]"
      >
        {grouped.map(({ group, options }) => (
          <SelectGroup key={group}>
            <SelectLabel className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {group}
            </SelectLabel>
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
