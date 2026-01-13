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
 */
export default function ProfileSelect({
  value,
  onValueChange,
  showAllOption = false,
  placeholder = 'Select a profile...',
  className = '',
  disabled = false,
}) {
  const user = useAuthStore((state) => state.user)
  // Use Boolean coercion to align with backend truthy checks - not strict equality
  const isAdmin = Boolean(user?.is_admin) || user?.role === 'admin'

  // Fetch profiles from API
  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
    staleTime: 60_000, // 1 minute
  })

  // Filter profiles based on user role - memoized for performance
  const availableProfiles = React.useMemo(() => {
    return isAdmin ? profiles : profiles.filter(p => p.user_id === user?.id)
  }, [isAdmin, profiles, user?.id])

  if (isLoading) {
    return (
      <Select disabled>
        <SelectTrigger className={className}>
          <SelectValue placeholder="Loading profiles..." />
        </SelectTrigger>
      </Select>
    )
  }

  if (availableProfiles.length === 0) {
    return (
      <Select disabled>
        <SelectTrigger className={className}>
          <SelectValue placeholder="No profiles available" />
        </SelectTrigger>
      </Select>
    )
  }

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={className}>
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
