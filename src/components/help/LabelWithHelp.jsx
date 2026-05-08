import React from "react"

import { Label } from "@/components/ui/label"
import FieldHelpTip from "@/components/help/FieldHelpTip"

/**
 * Convenience wrapper: <Label htmlFor=...>{children} <FieldHelpTip id=... /></Label>
 *
 * Wires the canonical "why we ask" explanation from
 * profileFieldUsageRegistry next to a form field's label so users
 * always have a one-click answer to "why do you need this?". PII
 * fields automatically display the lock icon and disclosure text.
 */
export default function LabelWithHelp({ htmlFor, fieldId, required, children, className }) {
  return (
    <Label htmlFor={htmlFor} className={className}>
      {children}
      {required ? <span className="text-red-500" aria-hidden="true">{' *'}</span> : null}
      {fieldId ? <FieldHelpTip id={fieldId} className="ml-1 align-middle" /> : null}
    </Label>
  )
}
