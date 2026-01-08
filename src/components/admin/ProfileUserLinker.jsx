import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch } from '@/api/client'
import { Loader2, Link2, AlertCircle, CheckCircle2, Mail, User } from 'lucide-react'

export default function ProfileUserLinker() {
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [email, setEmail] = useState('')
  const { toast } = useToast()
  const queryClient = useQueryClient()

  // Fetch all profiles
  const { data: profiles = [], isLoading: isLoadingProfiles } = useQuery({
    queryKey: ['profiles', 'all'],
    queryFn: async () => {
      const result = await apiFetch('/api/profiles')
      return result || []
    },
  })

  // Fetch selected profile details
  const { data: selectedProfile, isLoading: isLoadingProfile } = useQuery({
    queryKey: ['profile', selectedProfileId],
    queryFn: async () => {
      if (!selectedProfileId) return null
      const result = await apiFetch(`/api/profiles/${selectedProfileId}`)
      return result
    },
    enabled: !!selectedProfileId,
  })

  // Mutation to link user email to profile
  const linkUserMutation = useMutation({
    mutationFn: async ({ profileId, email }) => {
      return apiFetch(`/api/profiles/${profileId}/link-user`, {
        method: 'PATCH',
        body: JSON.stringify({ email }),
      })
    },
    onSuccess: (data) => {
      toast({
        title: 'Success',
        description: data.message || 'Profile linked successfully',
      })
      // Invalidate queries to refresh data
      queryClient.invalidateQueries({ queryKey: ['profile', selectedProfileId] })
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      setEmail('')
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to link user to profile',
        variant: 'destructive',
      })
    },
  })

  // Get current linked email from user_id
  // Note: Backend needs to be enhanced to return user email in profile response
  // For now, we just check if there's a user_id linked

  const handleSubmit = (e) => {
    e.preventDefault()
    
    if (!selectedProfileId) {
      toast({
        title: 'Error',
        description: 'Please select a profile',
        variant: 'destructive',
      })
      return
    }

    if (!email) {
      toast({
        title: 'Error',
        description: 'Please enter an email address',
        variant: 'destructive',
      })
      return
    }

    linkUserMutation.mutate({ profileId: selectedProfileId, email })
  }

  const handleUnlink = () => {
    if (!selectedProfileId) return
    
    linkUserMutation.mutate({ profileId: selectedProfileId, email: null })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="w-5 h-5 text-blue-600" />
          Link User Email to Profile
        </CardTitle>
        <CardDescription>
          Assign a user email to a profile so they can access it when they log in.
          Users mapped in the system will automatically be linked to their designated profiles.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Profile Selector */}
        <div className="space-y-2">
          <Label htmlFor="profile-select">Select Profile</Label>
          <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
            <SelectTrigger id="profile-select">
              <SelectValue placeholder="Choose a profile..." />
            </SelectTrigger>
            <SelectContent>
              {isLoadingProfiles ? (
                <div className="p-2 text-center text-sm text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                </div>
              ) : profiles.length === 0 ? (
                <div className="p-2 text-center text-sm text-slate-500">No profiles found</div>
              ) : (
                profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.display_name} ({profile.id})
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>

        {/* Current Status */}
        {selectedProfileId && (
          <>
            {isLoadingProfile ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
              </div>
            ) : selectedProfile ? (
              <Alert>
                <User className="w-4 h-4" />
                <AlertDescription>
                  <div className="space-y-1">
                    <div className="font-medium">Current Status:</div>
                    {selectedProfile.user_id ? (
                      <div className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="w-4 h-4 text-green-600" />
                        <span>
                          Linked to user ID: <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">{selectedProfile.user_id}</code>
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        <AlertCircle className="w-4 h-4" />
                        <span>No user linked to this profile</span>
                      </div>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}

            {/* Link Email Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">User Email</Label>
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="user@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10"
                      disabled={linkUserMutation.isPending}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={!email || linkUserMutation.isPending}
                  >
                    {linkUserMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        Linking...
                      </>
                    ) : (
                      <>
                        <Link2 className="w-4 h-4 mr-2" />
                        Link Email
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  Enter the email address of the user who should have access to this profile.
                </p>
              </div>
            </form>

            {/* Unlink Button */}
            {selectedProfile?.user_id && (
              <div className="pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={handleUnlink}
                  disabled={linkUserMutation.isPending}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  Unlink User from Profile
                </Button>
              </div>
            )}
          </>
        )}

        {/* Existing Mappings Info */}
        <Alert className="bg-blue-50 border-blue-200">
          <AlertCircle className="w-4 h-4 text-blue-600" />
          <AlertDescription className="text-blue-900 text-sm">
            <div className="font-medium mb-1">Pre-configured User Mappings:</div>
            <div className="text-xs space-y-0.5 font-mono">
              <div>holliet52@gmail.com → profile-hollie-knox</div>
              <div>isawstars08@yahoo.com → profile-brian-client</div>
              <div>allmonkey915@gmail.com → profile-avanell-leamon</div>
              <div>oliviabeltran@gmail.com → profile-olivia-beltran</div>
              <div>joshua.dasher@gmail.com → profile-josh-dasher</div>
              <div>rdashermiller@gmail.com → profile-rachel-miller</div>
            </div>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  )
}
