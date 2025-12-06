import { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Reusable hook for AI-powered data extraction from text
 * Can be used across different forms that need AI field population
 */
export function useAIHarvest() {
  const [isHarvesting, setIsHarvesting] = useState(false);
  const [inputText, setInputText] = useState("");
  const { toast } = useToast();

  /**
   * Extract profile data from text using AI
   * @param {string} text - Input text to extract from
   * @param {object} schema - JSON schema defining expected fields
   * @param {function} onSuccess - Callback with extracted data
   */
  const extractData = useCallback(async (text, schema, onSuccess) => {
    if (!text?.trim()) {
      toast({
        title: "No Text Provided",
        description: "Please enter information first.",
        variant: "destructive",
      });
      return null;
    }

    setIsHarvesting(true);
    try {
      const prompt = `Extract structured profile information from the following text. Return a JSON object with any fields you can identify.

TEXT:
${text}

Extract fields based on the provided schema. Only include fields that are explicitly mentioned or can be clearly inferred from the text.`;

      const response = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: schema,
      });

      if (response && typeof response === 'object') {
        onSuccess?.(response);
        
        toast({
          title: "✨ Data Extracted!",
          description: "AI has populated the form with extracted information. Review and adjust as needed.",
        });

        setInputText(""); // Clear input after success
        return response;
      } else {
        throw new Error("Invalid response from AI");
      }
    } catch (error) {
      console.error("AI extraction failed:", error);
      toast({
        title: "Extraction Failed",
        description: "Could not extract information. Please try again or fill manually.",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsHarvesting(false);
    }
  }, [toast]);

  /**
   * Generate suggestions for a specific field using AI
   */
  const generateFieldSuggestions = useCallback(async (fieldName, context, returnSchema) => {
    setIsHarvesting(true);
    try {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: context,
        response_json_schema: returnSchema,
      });

      if (response) {
        toast({
          title: `✨ ${fieldName} Generated!`,
          description: `AI has generated suggestions for ${fieldName}.`,
        });
        return response;
      }
    } catch (error) {
      console.error(`Failed to generate ${fieldName}:`, error);
      toast({
        title: "Generation Failed",
        description: `Could not generate ${fieldName}. Please try again.`,
        variant: "destructive",
      });
      return null;
    } finally {
      setIsHarvesting(false);
    }
  }, [toast]);

  return {
    isHarvesting,
    inputText,
    setInputText,
    extractData,
    generateFieldSuggestions,
  };
}