import React, { useState } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Sparkles, Loader2 } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { requestProfileFieldAI } from "@/api/profiles"
import { useToast } from "@/components/ui/use-toast"

function safeStringifyValue(value) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * Profile field with AI assistance button
 * Wraps any input component with an AI assist button
 */
export default function ProfileFieldWithAI({
  field,
  value,
  onChange,
  inputRef,
  disabled,
  profileId,
  sectionKey,
  formContext,
  ...props
}) {
  const [isLoadingAI, setIsLoadingAI] = useState(false)
  const { toast } = useToast()
  
  const safeField = field ?? {
    name: props?.name ?? "field",
    label: props?.name ?? "Field",
    description: "",
    component: Input,
    props: {},
  }

  const FieldComponent = safeField.component || Input
  const displayValue = safeStringifyValue(value)
  
  const handleAIAssist = async () => {
    if (!safeField?.name) {
      toast({
        title: "AI assist unavailable",
        description: "This field is missing metadata (name).",
        variant: "destructive",
      })
      return
    }

    setIsLoadingAI(true)
    
    try {
      // Prepare context for AI
      const safeFormContext = formContext && typeof formContext === 'object' && !Array.isArray(formContext)
        ? formContext
        : {}
      // formContext is merged FIRST so that explicit keys always win
      // System-supplied keys are the baseline; caller-supplied formContext keys
      // take precedence so richer context from the parent is never discarded.
      const context = {
        fieldName: safeField.name,
        fieldLabel: safeField.label,
        currentValue: displayValue || '',
        fieldDescription: safeField.description || '',
        sectionKey,
        profileId,
        ...safeFormContext,
      }
      
      // Request AI suggestion, but don't let the shimmer hang toward the 60s
      // network ceiling — surface a recoverable error at 30s so the user gets
      // feedback (the recurring backend AI-timeout pattern otherwise looks frozen).
      const AI_ASSIST_TIMEOUT_MS = 30000
      const response = await Promise.race([
        requestProfileFieldAI(context),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('AI is taking longer than expected. Please try again in a moment.')),
            AI_ASSIST_TIMEOUT_MS,
          ),
        ),
      ])
      
      if (response?.suggestion !== undefined && response.suggestion !== null) {
        const suggestionValue = typeof response.suggestion === 'string'
          ? response.suggestion
          : safeStringifyValue(response.suggestion)
        onChange(suggestionValue)
        toast({
          title: "AI suggestion applied",
          description: `Updated ${safeField.label} with AI-generated content`,
        })
      } else {
        // No suggestion returned â inform the user so they can improve their profile
        const hint = response?.hint || "Try filling in more profile fields to get better suggestions."
        toast({
          title: "No suggestion available",
          description: hint,
          variant: "default",
        })
      }
    } catch (error) {
      console.error('AI assist error:', error)
      toast({
        title: "AI assist failed",
        description: error.message || "Could not generate suggestion",
        variant: "destructive",
      })
    } finally {
      setIsLoadingAI(false)
    }
  }
  
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={safeField.name}>{safeField.label}</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleAIAssist}
                disabled={disabled || isLoadingAI}
                className="h-7 px-2 text-xs bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 text-blue-700"
              >
                {isLoadingAI ? (
                  <>
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3 h-3 mr-1" />
                    Assist with AI
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Click to get AI suggestions for this field</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      
      <FieldComponent
        id={safeField.name}
        ref={inputRef}
        disabled={disabled || isLoadingAI}
        {...safeField.props}
        {...props}
        value={displayValue}
        onChange={(e) => {
          const rawVal = e?.target ? e.target.value : e
          onChange(rawVal)
        }}
      />
      
      {safeField.description && (
        <p className="text-xs text-slate-500">{safeField.description}</p>
      )}
    </div>
  )
}