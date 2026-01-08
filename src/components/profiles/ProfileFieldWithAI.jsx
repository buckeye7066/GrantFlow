import React, { useState } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Sparkles, Loader2 } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { requestProfileFieldAI } from "@/api/profiles"
import { useToast } from "@/components/ui/use-toast"

/**
 * Profile field with AI assistance button
 * Wraps any input component with an AI assist button
 */
export default function ProfileFieldWithAI({
  field,
  value,
  onChange,
  disabled,
  profileId,
  sectionKey,
  formContext,
  ...props
}) {
  const [isLoadingAI, setIsLoadingAI] = useState(false)
  const { toast } = useToast()
  
  const FieldComponent = field.component || Input
  
  const handleAIAssist = async () => {
    setIsLoadingAI(true)
    
    try {
      // Prepare context for AI
      const context = {
        fieldName: field.name,
        fieldLabel: field.label,
        currentValue: value || '',
        fieldDescription: field.description || '',
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
          description: `Updated ${field.label} with AI-generated content`,
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
        <Label htmlFor={field.name}>{field.label}</Label>
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
        id={field.name}
        value={value}
        onChange={(e) => onChange(e.target ? e.target.value : e)}
        disabled={disabled || isLoadingAI}
        {...field.props}
        {...props}
      />
      
      {field.description && (
        <p className="text-xs text-slate-500">{field.description}</p>
      )}
    </div>
  )
}