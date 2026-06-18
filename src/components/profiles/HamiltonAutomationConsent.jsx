import React from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { ShieldCheck } from 'lucide-react'

/**
 * Consent prompt before handing an application to the Hamilton automation agent.
 *
 * "Yes" authorizes Hamilton to prepare and drive the NON-SECURED steps of an
 * application (open the portal, fill fields from the profile, assemble the
 * packet). It deliberately does NOT — and the disclaimer says so — type the
 * user's FSA ID, bypass multi-factor auth, or sign federal aid forms on their
 * behalf. Those steps are federal legal signatures the user must complete
 * themselves; Hamilton hard-stops and hands the keyboard back. The matching
 * server-side gate lives in services/college/collegeFundingMerge.js (federal /
 * FAFSA items are forced to user_confirm) and Hamilton's own auth/signature
 * hard-stops, so this dialog never authorizes more than the backend will do.
 *
 * @param {boolean}  open
 * @param {Function} onOpenChange
 * @param {Function} onConfirm     called when the user clicks "Yes, automate"
 * @param {boolean}  [busy]
 * @param {string}   [title]
 * @param {string}   [body]
 * @param {string}   [confirmLabel]
 */
export default function HamiltonAutomationConsent({
  open,
  onOpenChange,
  onConfirm,
  busy = false,
  title = 'Let Hamilton handle this application?',
  body = 'Hamilton will open the portal, fill every field from this profile, and assemble the packet for you.',
  confirmLabel = 'Yes, automate',
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-indigo-600" />
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          <span className="font-semibold">For your security and by federal rule, Hamilton pauses for you</span>{' '}
          to sign in, clear any 2-factor prompt, enter your FSA ID, and sign. GrantFlow never types your FSA ID,
          never bypasses multi-factor authentication, and never signs federal aid forms on your behalf — those are
          your legal signature and only you can make them. Continuing authorizes Hamilton to prepare and drive the
          non-secured steps of this application for you.
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={busy}>
            {busy ? 'Starting…' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
