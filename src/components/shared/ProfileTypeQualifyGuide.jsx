import React, { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useProfileTypes } from '@/services/profileTypes'
import ProfileTypeQualifyButton from '@/components/shared/ProfileTypeQualifyButton'

/**
 * Browse all profile types with a qualification explainer button on each row.
 */
export default function ProfileTypeQualifyGuide({ onSelect, triggerLabel = 'Who qualifies for each type?' }) {
  const { grouped } = useProfileTypes()
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-blue-600">
          <Sparkles className="h-3.5 w-3.5 mr-1" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      {open ? (
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Profile type qualifications</DialogTitle>
          <DialogDescription>
            Tap the sparkle button next to any type to see who should pick it and who should pick something else.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          {grouped.map(({ group, options }) => (
            <div key={group} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</h3>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {options.map((option) => (
                  <li key={option.id} className="flex items-start justify-between gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-900">{option.label}</p>
                      {option.description ? (
                        <p className="text-sm text-slate-600 mt-0.5">{option.description}</p>
                      ) : null}
                      {onSelect ? (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0 mt-1 text-blue-600"
                          onClick={() => {
                            onSelect(option.id)
                            setOpen(false)
                          }}
                        >
                          Select this type
                        </Button>
                      ) : null}
                    </div>
                    <ProfileTypeQualifyButton
                      typeId={option.id}
                      label={option.label}
                      className="shrink-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
