import React, { useState } from 'react'
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
import { Loader2 } from 'lucide-react'

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

export default function QuickAddDialog({ open, onOpenChange, onSubmit }) {
  const [formData, setFormData] = useState({
    display_name: '',
    primary_type: '',
  })
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    
    if (!formData.display_name || !formData.primary_type) {
      return
    }

    setIsSubmitting(true)
    try {
      await onSubmit(formData)
      setFormData({ display_name: '', primary_type: '' })
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to create profile:', error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Quick Add Profile</DialogTitle>
          <DialogDescription>
            Quickly create a new profile with basic information. You can add more details later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="display_name">Name *</Label>
              <Input
                id="display_name"
                placeholder="Enter profile name"
                value={formData.display_name}
                onChange={(e) => handleChange('display_name', e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="primary_type">Profile Type *</Label>
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
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button 
              type="submit" 
              disabled={isSubmitting || !formData.display_name || !formData.primary_type}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Profile'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
