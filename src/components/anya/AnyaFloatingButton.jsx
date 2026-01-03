import React, { useState } from "react"
import { Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import AnyaChat from "./AnyaChat"
import { cn } from "@/lib/utils"

export default function AnyaFloatingButton({ profileId, className }) {
  const [isOpen, setIsOpen] = useState(false)

  if (!profileId) {
    return null
  }

  return (
    <>
      {/* Floating Action Button with tooltip container */}
      <div className={cn("fixed bottom-6 right-6 z-50 group", className)}>
        <Button
          onClick={() => setIsOpen(true)}
          className={cn(
            "h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-all duration-200",
            "bg-gradient-to-br from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
          )}
          size="icon"
          title="Chat with Anya"
        >
          <Sparkles className="h-6 w-6 text-white animate-pulse group-hover:scale-110 transition-transform" />
          <span className="sr-only">Open Anya AI Assistant</span>
        </Button>

        {/* Anya Badge on hover */}
        <div
          className={cn(
            "absolute bottom-3 right-16 px-3 py-2 rounded-full shadow-md",
            "bg-gradient-to-r from-purple-600 to-blue-600 text-white text-sm font-semibold",
            "opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none",
            "whitespace-nowrap"
          )}
        >
          Chat with Anya
        </div>
      </div>

      {/* Slide-out Sheet Panel */}
      <Sheet open={isOpen} onOpenChange={setIsOpen}>
        <SheetContent side="right" className="w-full sm:w-[540px] md:w-[600px] p-0 flex flex-col">
          <SheetHeader className="px-6 py-4 border-b border-slate-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-purple-600 to-blue-600">
                  <Sparkles className="h-5 w-5 text-white" />
                </div>
                <div>
                  <SheetTitle className="text-lg font-bold">Anya AI Assistant</SheetTitle>
                  <SheetDescription className="text-xs">
                    Your intelligent grant management copilot
                  </SheetDescription>
                </div>
              </div>
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-hidden">
            <AnyaChat profileId={profileId} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
