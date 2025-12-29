import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
  type MouseEventHandler,
} from "react"
import { createPortal } from "react-dom"
import { cn } from "./utils"

interface DialogContextValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const DialogContext = createContext<DialogContextValue | undefined>(undefined)

function useDialogContext(component: string): DialogContextValue {
  const context = useContext(DialogContext)
  if (!context) {
    throw new Error(`${component} must be used within <Dialog>`)
  }
  return context
}

export interface DialogProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

export function Dialog({ open, defaultOpen = false, onOpenChange, children }: DialogProps) {
  const isControlled = open !== undefined
  const [internalOpen, setInternalOpen] = useState<boolean>(defaultOpen)

  const currentOpen = isControlled ? Boolean(open) : internalOpen

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next)
      }
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  const value = useMemo<DialogContextValue>(
    () => ({
      open: currentOpen,
      setOpen,
    }),
    [currentOpen, setOpen],
  )

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>
}

export interface DialogTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
  children: ReactNode
}

export function DialogTrigger({ asChild = false, children, onClick, ...props }: DialogTriggerProps) {
  const { setOpen } = useDialogContext("DialogTrigger")

  const handleOpen = (event: SyntheticEvent) => {
    if (!event.defaultPrevented) {
      setOpen(true)
    }
  }

  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<Record<string, unknown>>
    return cloneElement(child, {
      ...props,
      onClick: (event: SyntheticEvent) => {
        if (typeof child.props?.onClick === "function") {
          child.props.onClick(event)
        }
        if (typeof onClick === "function") {
          onClick(event as unknown as never)
        } else {
          handleOpen(event)
        }
      },
    })
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        onClick?.(event)
        handleOpen(event)
      }}
      {...props}
    >
      {children}
    </button>
  )
}

interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export function DialogContent({ className, children, ...props }: DialogContentProps) {
  const { open, setOpen } = useDialogContext("DialogContent")
  const isBrowser = typeof document !== "undefined"

  useEffect(() => {
    if (!open || !isBrowser) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, setOpen, isBrowser])

  if (!open || !isBrowser) {
    return null
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
      <div
        role="presentation"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full bg-black/50"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-10 w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-2xl",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-2 pb-4", className)} {...props} />
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-xl font-semibold leading-tight", className)} {...props} />
}

export function DialogDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 pt-4", className)} {...props} />
}

export interface DialogCloseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
  children: ReactNode
}

export function DialogClose({ asChild = false, children, onClick, ...props }: DialogCloseProps) {
  const { setOpen } = useDialogContext("DialogClose")

  const handleClose = (event: SyntheticEvent) => {
    if (!event.defaultPrevented) {
      setOpen(false)
    }
  }

  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<Record<string, unknown>>
    return cloneElement(child, {
      ...props,
      onClick: (event: SyntheticEvent) => {
        if (typeof child.props?.onClick === "function") {
          child.props.onClick(event)
        }
        if (typeof onClick === "function") {
          onClick(event as unknown as never)
        } else {
          handleClose(event)
        }
      },
    })
  }

  const handleButtonClose: MouseEventHandler<HTMLButtonElement> = (event) => {
    onClick?.(event)
    handleClose(event)
  }

  return (
    <button type="button" onClick={handleButtonClose} {...props}>
      {children}
    </button>
  )
}


