import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/authStore'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, User, AlertCircle, Upload, X } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { apiFetch } from '@/api/client'
import { uploadProfileAvatar } from '@/api/profiles'
import { useToast } from '@/components/ui/use-toast'
import { canonicalizeProfileTypeId } from '@/services/profileTypes'
import ProfileTypeSelect from '@/components/shared/ProfileTypeSelect'

export default function ProfileCreationWizard({ open, onComplete, onSkip }) {
  const [formData, setFormData] = useState({
    display_name: '',
    primary_type: '',
  })
  const [avatarFile, setAvatarFile] = useState(null)
  const [avatarPreview, setAvatarPreview] = useState(null)
  const [error, setError] = useState(null)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const createProfileMutation = useMutation({
    mutationFn: async ({ profileData, avatarFile }) => {
      // Create profile first
      const profile = await apiFetch('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(profileData),
      })

      // If avatar file is provided, upload it through the canonical helper.
      // The helper applies assertRealProfileId, so a sentinel id (or any
      // other non-routable value) throws here instead of issuing a 404.
      if (avatarFile && profile.id) {
        await uploadProfileAvatar(profile.id, avatarFile)
      }

      return profile
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' })
      useAuthStore.getState().refreshProfiles({ reason: 'profile-created-wizard', force: true })
      toast({
        title: 'Profile Created',
        description: 'Your profile has been created successfully!',
      })
      onComplete?.(data)
    },
    onError: (error) => {
      setError(error.message || 'Failed to create profile')
    },
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    if (!formData.display_name || !formData.primary_type) {
      setError('Please fill in all required fields')
      return
    }

    createProfileMutation.mutate({
      profileData: {
        ...formData,
        primary_type: canonicalizeProfileTypeId(formData.primary_type),
      },
      avatarFile,
    })
  }

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const handleAvatarChange = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      setAvatarFile(file)
      const reader = new FileReader()
      reader.onloadend = () => {
        setAvatarPreview(reader.result)
      }
      reader.readAsDataURL(file)
    }
  }

  const handleRemoveAvatar = () => {
    setAvatarFile(null)
    setAvatarPreview(null)
  }

  return (
    <Dialog open={open} onOpenChange={() => {}} modal>
      <DialogContent 
        className="sm:max-w-[500px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5 text-blue-600" />
            Create Your First Profile
          </DialogTitle>
          <DialogDescription>
            Before you can access the dashboard, you need to create at least one profile. 
            This helps us personalize your experience and find relevant funding opportunities.
          </DialogDescription>
        </DialogHeader>

        <Alert className="bg-blue-50 border-blue-200">
          <AlertCircle className="h-4 w-4 text-blue-600" />
          <AlertDescription className="text-blue-900">
            Don't worry, you can add more details and create additional profiles later.
          </AlertDescription>
        </Alert>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="display_name">
                Profile Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="display_name"
                placeholder="e.g., John Doe, ABC Nonprofit, or My Family"
                value={formData.display_name}
                onChange={(e) => handleChange('display_name', e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="primary_type">
                Profile Type <span className="text-red-500">*</span>
              </Label>
              <ProfileTypeSelect
                id="primary_type"
                value={formData.primary_type}
                onChange={(value) => handleChange('primary_type', value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="avatar">Profile Picture (optional)</Label>
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarImage src={avatarPreview} />
                  <AvatarFallback>
                    <Upload className="h-6 w-6 text-slate-400" />
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <Input
                    id="avatar"
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    className="cursor-pointer"
                  />
                  {avatarFile && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRemoveAvatar}
                      className="mt-2"
                    >
                      <X className="h-4 w-4 mr-1" />
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Supported formats: JPG, PNG, GIF (max 5MB)
              </p>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={createProfileMutation.isPending || !formData.display_name || !formData.primary_type}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {createProfileMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating Profile...
                </>
              ) : (
                'Create Profile & Continue'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
