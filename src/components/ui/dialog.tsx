import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

type DialogContextValue = {
  open: boolean
  setOpen: (open: boolean) => void
}

const DialogContext = React.createContext<DialogContextValue | null>(null)

function useDialogContext(component: string): DialogContextValue {
  const context = React.useContext(DialogContext)
  if (!context) {
    throw new Error(`${component} must be used within a Dialog`)
  }
  return context
}

export interface DialogProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

export function Dialog({ open, defaultOpen = false, onOpenChange, children }: DialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)

  const isControlled = open !== undefined
  const currentOpen = isControlled ? open : internalOpen

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next)
      }
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  const value = React.useMemo<DialogContextValue>(
    () => ({
      open: currentOpen,
      setOpen,
    }),
    [currentOpen, setOpen],
  )

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>
}

export interface DialogTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
}

export const DialogTrigger = React.forwardRef<HTMLButtonElement, DialogTriggerProps>(function DialogTrigger(
  { className, onClick, asChild = false, children, ...props },
  ref,
) {
  const { setOpen } = useDialogContext('DialogTrigger')
  if (asChild) {
    if (!React.isValidElement(children)) {
      throw new Error('DialogTrigger with asChild requires a valid React element child.')
    }
    const child = children as React.ReactElement<Record<string, unknown>>
    return React.cloneElement(child, {
      ...props,
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        onClick?.(event as never)
        if (typeof child.props?.onClick === 'function') {
          child.props.onClick(event)
        }
        setOpen(true)
      },
    })
  }
  return (
    <button
      ref={ref}
      type="button"
      className={className}
      onClick={(event) => {
        onClick?.(event)
        setOpen(true)
      }}
      {...props}
    >
      {children}
    </button>
  )
})

function DialogPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null
  return createPortal(children, document.body)
}

export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  { className, children, ...props },
  ref,
) {
  const { open, setOpen } = useDialogContext('DialogContent')

  React.useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, setOpen])

  if (!open) return null

  return (
    <DialogPortal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in"
        role="dialog"
        aria-modal="true"
        onClick={() => setOpen(false)}
      >
        <div
          ref={ref}
          className={cn(
            'relative max-h-[90vh] w-full max-w-lg origin-center rounded-lg border border-border bg-card p-6 text-card-foreground shadow-lg outline-none animate-dialog-in',
            className,
          )}
          onClick={(event) => event.stopPropagation()}
          {...props}
        >
          {children}
        </div>
      </div>
    </DialogPortal>
  )
})

export const DialogHeader = function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
}

export const DialogFooter = function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
}

export const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  function DialogTitle({ className, ...props }, ref) {
    return <h2 ref={ref} className={cn('text-lg font-semibold', className)} {...props} />
  },
)

export const DialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function DialogDescription({ className, ...props }, ref) {
    return <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  },
)

export interface DialogCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
}

export const DialogClose = React.forwardRef<HTMLButtonElement, DialogCloseProps>(function DialogClose(
  { className, onClick, asChild = false, children, ...props },
  ref,
) {
  const { setOpen } = useDialogContext('DialogClose')
  if (asChild) {
    if (!React.isValidElement(children)) {
      throw new Error('DialogClose with asChild requires a valid React element child.')
    }
    const child = children as React.ReactElement<Record<string, unknown>>
    return React.cloneElement(child, {
      ...props,
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        onClick?.(event as never)
        if (typeof child.props?.onClick === 'function') {
          child.props.onClick(event)
        }
        setOpen(false)
      },
    })
  }
  return (
    <button
      ref={ref}
      type="button"
      className={className}
      onClick={(event) => {
        onClick?.(event)
        setOpen(false)
      }}
      {...props}
    >
      {children}
    </button>
  )
})


