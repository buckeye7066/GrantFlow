import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, User, AlertCircle } from 'lucide-react'
import { apiFetch } from '@/api/client'
import { useToast } from '@/components/ui/use-toast'

const PROFILE_TYPES = [
  { value: 'individual', label: 'Individual' },
  { value: 'family', label: 'Family' },
  { value: 'student', label: 'Student' },
  { value: 'college_student', label: 'College Student' },
  { value: 'high_school_student', label: 'High School Student' },
  { value: 'nonprofit', label: 'Nonprofit Organization' },
  { value: 'small_business', label: 'Small Business' },
  { value: 'organization', label: 'Organization' },
  { value: 'medical_assistance', label: 'Medical Assistance' },
  { value: 'other', label: 'Other' },
]

export default function ProfileCreationWizard({ open, onComplete, onSkip }) {
  const [formData, setFormData] = useState({
    display_name: '',
    primary_type: '',
  })
  const [error, setError] = useState(null)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const createProfileMutation = useMutation({
    mutationFn: async (profileData) => {
      return apiFetch('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(profileData),
      })
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
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

    createProfileMutation.mutate(formData)
  }

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
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
              <Select
                value={formData.primary_type}
                onValueChange={(value) => handleChange('primary_type', value)}
                required
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select profile type" />
                </SelectTrigger>
                <SelectContent>
                  {PROFILE_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
