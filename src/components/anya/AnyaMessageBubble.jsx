/**
 * AnyaMessageBubble — one chat message in Anya's panel.
 *
 * Extracted from AnyaChat.jsx so the contrast guard test can import it
 * without AnyaChat's heavy store/api chain. The class + inline-style rules
 * here are the subject of the 2026-07-27 "text same color as background"
 * fix: every surface class carries a dark: variant, and a user-directed
 * appearance (chat.setAppearance) paints surface AND ink inline together.
 */
import React from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"

export const MessageBubble = React.memo(function MessageBubble({ message, appearance }) {
  const isAssistant = message.role === "assistant"
  const isAppearanceUpdate = message.tool_name === "chat.setAppearance"
  // Inline styles win over the static Tailwind palette only when the user has
  // asked Anya for different chat colors; otherwise the stock look is untouched.
  const bubbleStyle = appearance
    ? {
        background: isAssistant ? appearance.assistantBubbleBg : appearance.userBubbleBg,
        borderColor: appearance.border,
        color: isAssistant ? appearance.assistantText : appearance.userText,
      }
    : undefined
  const metaStyle = appearance ? { color: appearance.mutedText } : undefined
  return (
    <div
      className={cn(
        // min-w-0 + overflow-hidden keep a bubble from being widened by a long
        // unbreakable token; the panel hugs the viewport's right edge, so any
        // overflow here would be clipped off-screen ("half-readable menu").
        "min-w-0 max-w-full overflow-hidden rounded-lg border px-3 py-2 text-sm shadow-sm transition",
        isAssistant
          ? "border-blue-200 dark:border-blue-900 bg-blue-50/80 dark:bg-blue-950/60 text-slate-800 dark:text-slate-100"
          : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200",
      )}
      style={bubbleStyle}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400 pb-1" style={metaStyle}>
        <Badge variant={isAssistant ? "secondary" : "outline"} className="text-[11px] uppercase tracking-wide">
          {isAssistant ? "Anya" : "You"}
        </Badge>
        <span>
          {message.created_at
            ? formatDistanceToNow(new Date(message.created_at), { addSuffix: true })
            : "now"}
        </span>
      </div>
      {/* break-words wraps long URLs / unbroken tokens so Anya's reply never
          runs past the right edge of the panel. */}
      <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
      {isAppearanceUpdate ? (
        <div className="mt-2 text-xs text-slate-600 dark:text-slate-400" style={metaStyle}>
          🎨 {message.tool_payload?.description || "Chat colors updated."}
        </div>
      ) : message.tool_name ? (
        <div className="mt-2 space-y-2 text-xs text-slate-600 dark:text-slate-400" style={metaStyle}>
          <div>
            Tool: <span className="font-mono text-xs text-slate-700 dark:text-slate-300" style={metaStyle}>{message.tool_name}</span>
          </div>
          {message.tool_payload ? (
            <div className="max-h-48 overflow-auto rounded-md border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/70 p-2 text-xs text-slate-800 dark:text-slate-100">
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(message.tool_payload, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
