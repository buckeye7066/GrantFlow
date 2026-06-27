import React, { useEffect, useState } from "react"
import { Sparkles, X, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Alert, AlertDescription } from "@/components/ui/alert"
import AnyaChat from "./AnyaChat"
import { cn } from "@/lib/utils"
import { useAuthStore, normalizeUserAdmin } from "@/stores/authStore"

export default function AnyaFloatingButton({ profileId, className }) {
  const [isOpen, setIsOpen] = useState(false)
  const [prefillMessage, setPrefillMessage] = useState(null)
  const [sessionOptions, setSessionOptions] = useState({})
  const [chatKey, setChatKey] = useState(0)
  // Use the canonical admin normalizer so we accept every shape the auth
  // store may carry (`is_admin` snake_case from the canonical /api/auth/me
  // bootstrap, `isAdmin` camelCase from JWT payloads, `role === 'admin'`,
  // or a `roles` array). Hard-coding `state.user?.is_admin` previously
  // greyed out admin-only chat surfaces during the brief window between
  // /api/auth/me returning a camelCase isAdmin claim and setAuthenticatedUser
  // re-projecting it as is_admin — violating Anya goals 4, 6, 8.
  const user = useAuthStore((state) => state.user)
  const isAdmin = normalizeUserAdmin(user)
  // Treat the synthetic admin sentinel as "no real profile" — the AnyaChat
  // child filters it out anyway, but recognising it here prevents a
  // misleading targetProfileId from leaking into bug reports.
  const eventProfileId = sessionOptions?.profileId && sessionOptions.profileId !== '__admin__' ? sessionOptions.profileId : null
  const realProfileId = eventProfileId ?? (profileId && profileId !== '__admin__' ? profileId : null)
  const canOpen = isAdmin || Boolean(realProfileId)
  const targetProfileId = realProfileId ?? (isAdmin ? null : undefined)

  useEffect(() => {
    function handleOpen(event) {
      const detail = event?.detail ?? {}
      const msg = detail?.prefillMessage ?? null
      setPrefillMessage(msg)
      setSessionOptions({
        profileId: detail?.profileId ?? null,
        title: detail?.title ?? null,
        metadata: detail?.metadata ?? null,
      })
      setChatKey((key) => key + 1)
      setIsOpen(true)
    }
    window.addEventListener("anya:open", handleOpen)
    return () => window.removeEventListener("anya:open", handleOpen)
  }, [])

  const handleClick = () => {
    setPrefillMessage(null)
    setSessionOptions({})
    setChatKey((key) => key + 1)
    setIsOpen(true)
  }

  return (
    <>
      {/* Floating Action Button with tooltip container */}
      <div className={cn("safe-floating-action fixed z-50 group", className)}>
        <Button
          onClick={handleClick}
          className={cn(
            "h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 p-0 overflow-hidden",
            canOpen
              ? "bg-gradient-to-br from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
              : "bg-gradient-to-br from-slate-400 to-slate-500 hover:from-slate-500 hover:to-slate-600"
          )}
          size="icon"
          title={
            canOpen
              ? "Chat with Anya"
              : "Create a profile to chat with Anya"
          }
        >
          <img 
            src="/images/anya-avatar.svg" 
            alt="Anya, Administrative Assistant" 
            className={cn(
              "h-full w-full object-cover transition-transform",
              canOpen ? "group-hover:scale-110" : ""
            )}
          />
          <span className="sr-only">Open Anya, Administrative Assistant</span>
        </Button>

        {/* Anya Badge on hover */}
        <div
          className={cn(
            "absolute bottom-3 right-16 px-3 py-2 rounded-full shadow-md",
            "text-white text-sm font-semibold",
            "opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none",
            "whitespace-nowrap",
            canOpen
              ? "bg-gradient-to-r from-purple-600 to-blue-600"
              : "bg-gradient-to-r from-slate-400 to-slate-500"
          )}
        >
          {canOpen ? "Chat with Anya" : "Create a profile first"}
        </div>
      </div>

      {/* Slide-out Sheet Panel */}
      <Sheet open={isOpen} onOpenChange={setIsOpen}>
        <SheetContent
          side="right"
          className="h-[100dvh] max-h-[100dvh] w-full sm:w-[540px] md:w-[600px] p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] flex flex-col"
        >
          <SheetHeader className="px-6 py-4 border-b border-slate-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full overflow-hidden",
                canOpen
                    ? "bg-gradient-to-br from-purple-600 to-blue-600"
                    : "bg-gradient-to-br from-slate-400 to-slate-500"
                )}>
                  <img 
                    src="/images/anya-avatar.svg" 
                    alt="Anya" 
                    className="h-full w-full object-cover"
                  />
                </div>
                <div>
                  <SheetTitle className="text-lg font-bold">Anya, Administrative Assistant</SheetTitle>
                  <SheetDescription className="text-xs">
                  {canOpen
                    ? "Your administrative assistant for grants & funding"
                    : "Create a profile to get started"}
                  </SheetDescription>
                </div>
              </div>
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-hidden">
          {canOpen ? (
            <AnyaChat
              key={`${targetProfileId ?? 'admin'}:${chatKey}`}
              profileId={targetProfileId ?? undefined}
              initialSessionOptions={sessionOptions}
              prefillMessage={prefillMessage}
              onPrefillConsumed={() => setPrefillMessage(null)}
            />
            ) : (
              <div className="p-6 flex items-center justify-center h-full">
                <Alert className="max-w-md">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="mt-2">
                    <p className="font-semibold mb-2">No profile selected</p>
                    <p className="text-sm text-slate-600 mb-3">
                      GrantFlow helps you find, track, and apply for grants, scholarships, and funding programs.
                      To chat with Anya, create a profile first — Anya uses your profile (location, goals, demographics)
                      to find opportunities that genuinely match your situation.
                    </p>
                    <p className="text-xs text-slate-500">
                      Go to <strong>My Profiles</strong> to create or select a profile, then return here to get started.
                    </p>
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
