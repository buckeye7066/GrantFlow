import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/authStore'
import { apiFetch } from '@/api/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * ProfileSelect - A reusable profile selector component
 * 
 * Features:
 * - Admin users see all profiles
 * - Non-admin users only see their own profiles
 * - Automatically handles profile loading and filtering
 * - Supports optional "All profiles" option for admins
 * 
 * @param {Object} props
 * @param {string} props.value - Selected profile ID
 * @param {Function} props.onValueChange - Callback when selection changes
 * @param {boolean} props.showAllOption - Whether to show "All profiles" option (admin only)
 * @param {string} props.placeholder - Placeholder text
 * @param {string} props.className - Additional CSS classes
 * @param {boolean} props.disabled - Whether the select is disabled
 * @param {string} props.triggerId - Optional id used by an external label
 * @param {string} props.ariaLabel - Accessible name when there is no external label
 */
export default function ProfileSelect({
  value,
  onValueChange,
  showAllOption = false,
  placeholder = 'Select a profile...',
  className = '',
  disabled = false,
  triggerId,
  ariaLabel,
}) {
  const user = useAuthStore((state) => state.user)
  // Canonical admin truth is server-backed (/api/auth/me).
  const isAdmin = Boolean(user?.is_admin)

  // Fetch profiles from API
  const { data: rawProfiles, isLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
    staleTime: 5_000, // 5 seconds — profiles change often
  })

  // Normalise envelope: API may return [] directly or { data: [] } or { profiles: [] }
  const profiles = Array.isArray(rawProfiles)
    ? rawProfiles
    : Array.isArray(rawProfiles?.data)
      ? rawProfiles.data
      : Array.isArray(rawProfiles?.profiles)
        ? rawProfiles.profiles
        : []

  // Defence-in-depth: strip deleted profiles client-side so stale
  // React-Query cache entries never leak deleted accounts into the selector.
  const availableProfiles = profiles.filter((p) => p?.status !== 'deleted')

  if (isLoading) {
    return (
      <Select disabled>
        <SelectTrigger id={triggerId} aria-label={ariaLabel} className={className}>
          <SelectValue placeholder="Loading profiles..." />
        </SelectTrigger>
      </Select>
    )
  }

  if (!Array.isArray(availableProfiles) || availableProfiles.length === 0) {
    // Log only structure, never profile records or personal data.
    console.warn('[ProfileSelect] No profiles available', {
      responseType: Array.isArray(rawProfiles) ? 'array' : typeof rawProfiles,
      responseKeys: rawProfiles && typeof rawProfiles === 'object' && !Array.isArray(rawProfiles)
        ? Object.keys(rawProfiles)
        : [],
    })
    return (
      <Select disabled>
        <SelectTrigger id={triggerId} aria-label={ariaLabel} className={className}>
          <SelectValue placeholder="No profiles available — ask Anya what is needed next" />
        </SelectTrigger>
      </Select>
    )
  }

  return (
    <Select
      // Pass undefined when empty to satisfy Radix's controlled-vs-
      // uncontrolled invariant — `value=""` is its forbidden sentinel.
      value={value || undefined}
      onValueChange={(v) => onValueChange?.(v ?? '')}
      disabled={disabled}
    >
      <SelectTrigger id={triggerId} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {/* Show "All profiles" option only for admin users */}
        {showAllOption && isAdmin && (
          <SelectItem value="all">
            All profiles
          </SelectItem>
        )}
        
        {availableProfiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.display_name || profile.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
