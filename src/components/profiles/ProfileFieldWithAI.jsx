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
      const context = {
        fieldName: safeField.name,
        fieldLabel: safeField.label,
        currentValue: displayValue || '',
        fieldDescription: safeField.description || '',
        sectionKey,
        profileId,
        ...formContext // Additional form data for context
      }
      
      // Request AI suggestion
      const response = await requestProfileFieldAI(context)
      
      if (response?.suggestion) {
        onChange(response.suggestion)
        toast({
          title: "AI suggestion applied",
          description: `Updated ${safeField.label} with AI-generated content`,
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
        onChange={(e) => onChange(e?.target ? e.target.value : e)}
      />
      
      {safeField.description && (
        <p className="text-xs text-slate-500">{safeField.description}</p>
      )}
    </div>
  )
}