import React from "react"
import { Link } from "react-router-dom"
import {
  Bot,
  CheckCircle2,
  Compass,
  FileSearch,
  FilterX,
  Search,
  SlidersHorizontal,
  UserRound,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const ICONS = {
  profile: UserRound,
  filters: SlidersHorizontal,
  discovery: Compass,
  crawler: Search,
  anya: Bot,
  review: FileSearch,
  reset: FilterX,
}

export default function ZeroResultGuidance({
  title = "No matching funding found yet",
  description,
  facts = [],
  actions = [],
  className,
}) {
  return (
    <div className={cn("space-y-5 text-left", className)}>
      <div className="mx-auto max-w-2xl text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500">
          <FileSearch className="h-6 w-6" />
        </div>
        <h3 className="mt-4 text-xl font-semibold text-slate-900">{title}</h3>
        {description ? (
          <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
        ) : null}
      </div>

      {facts.length > 0 ? (
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-2 sm:grid-cols-3">
          {facts.map((fact) => (
            <div key={fact.label} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{fact.label}</p>
              <p className="mt-1 text-sm font-medium text-slate-800">{fact.value}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mx-auto max-w-3xl rounded-lg border border-blue-200 bg-blue-50/70 p-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-blue-700" />
          <p className="text-sm font-semibold text-blue-950">Next useful moves</p>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {actions.map((action) => {
            const Icon = action.icon || ICONS[action.kind] || CheckCircle2
            const body = (
              <>
                <Icon className="h-4 w-4 shrink-0" />
                <span className="text-left">
                  <span className="block font-semibold">{action.label}</span>
                  {action.description ? (
                    <span className="block text-xs font-normal opacity-80">{action.description}</span>
                  ) : null}
                </span>
              </>
            )
            const sharedClass = "h-auto min-h-12 justify-start gap-2 whitespace-normal px-3 py-2"
            const surfaceClass = action.variant === "default" ? "" : "bg-white"

            if (action.href) {
              return (
                <Button
                  key={action.label}
                  asChild
                  variant={action.variant || "outline"}
                  className={cn(sharedClass, surfaceClass)}
                  title={action.tooltip || action.description || action.label}
                >
                  <Link to={action.href}>{body}</Link>
                </Button>
              )
            }

            return (
              <Button
                key={action.label}
                type="button"
                variant={action.variant || "outline"}
                disabled={action.disabled}
                className={cn(sharedClass, surfaceClass)}
                onClick={action.onClick}
                title={action.tooltip || action.description || action.label}
              >
                {body}
              </Button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
