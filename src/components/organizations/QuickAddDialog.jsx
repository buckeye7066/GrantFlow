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
import { Loader2, Upload, X } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useToast } from '@/components/ui/use-toast'

export default function QuickAddDialog({ open, onOpenChange, onSubmit }) {
  const { toast } = useToast()
  const [formData, setFormData] = useState({
    display_name: '',
  })
  const [avatarFile, setAvatarFile] = useState(null)
  const [avatarPreview, setAvatarPreview] = useState(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErrorMsg(null)

    // Visible validation instead of a silently disabled button doing nothing.
    // Profile TYPE is no longer collected here — it is determined from the
    // profile's own information (Anya's opening interview + the data-derived
    // facets), never a manual pick that a user could get wrong.
    if (!formData.display_name.trim()) {
      setErrorMsg('Please enter a name.')
      return
    }

    setIsSubmitting(true)
    try {
      await onSubmit({
        ...formData,
        avatarFile,
      })
      setFormData({ display_name: '' })
      setAvatarFile(null)
      setAvatarPreview(null)
      onOpenChange(false)
    } catch (error) {
      // Surface the failure to the user — don't swallow it to the console.
      const message = error instanceof Error ? error.message : 'Failed to create profile. Please try again.'
      setErrorMsg(message)
      toast({ variant: 'destructive', title: 'Could not create profile', description: message })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    if (errorMsg) setErrorMsg(null)
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
            <p className="text-sm text-slate-500">
              No need to pick a profile type. Anya figures out the right fit — and
              funding that may fit — with the evidence and open questions shown as you go.
            </p>
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
          </div>
          {errorMsg && <p className="text-sm text-red-600 mb-2">{errorMsg}</p>}
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
              disabled={isSubmitting}
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
