import * as React from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Combobox - Searchable dropdown with a11y and null-safety
 * @param {Object} props
 * @param {Array} props.options - Array of {value, label} options
 * @param {string|null} props.value - Selected value
 * @param {Function} props.onChange - Change handler
 * @param {string} props.placeholder - Placeholder text
 * @param {boolean} props.isLoading - Loading state
 * @param {string} props.className - Additional class names
 * @param {boolean} props.disabled - Disabled state
 */
export default function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select...",
  isLoading = false,
  className,
  disabled = false,
}) {
  // Null-safe defaults
  const safeOptions = Array.isArray(options) ? options : [];
  const safeValue = value ?? null;
  const safeOnChange = typeof onChange === "function" ? onChange : () => {};

  const [open, setOpen] = React.useState(false);
  const triggerId = React.useId();

  // Stable handler
  const handleChange = React.useCallback(
    (next) => {
      safeOnChange(next);
    },
    [safeOnChange]
  );

  // Memoized lookup to avoid re-scans
  const selectedOption = React.useMemo(() => {
    if (safeOptions.length === 0 || !safeValue) return null;
    return safeOptions.find((o) => o?.value === safeValue) || null;
  }, [safeOptions, safeValue]);

  // If current value disappears from the options (e.g., after remote update), clear it
  React.useEffect(() => {
    if (!safeValue) return;
    const exists = safeOptions.some((o) => o?.value === safeValue);
    if (!exists) {
      handleChange(null);
    }
  }, [safeOptions, safeValue, handleChange]);

  const handleOpenChange = React.useCallback(
    (next) => {
      if (disabled) return;
      setOpen(next);
    },
    [disabled]
  );

  const handleKeyDown = React.useCallback((e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  }, []);

  const handleSelect = React.useCallback(
    (optionValue) => {
      if (isLoading || disabled) return;
      handleChange(optionValue);
      setOpen(false);
    },
    [isLoading, disabled, handleChange]
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={triggerId}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? `${triggerId}-listbox` : undefined}
          aria-busy={isLoading}
          aria-disabled={disabled}
          disabled={disabled}
          className={cn("w-full justify-between h-auto", className)}
          onKeyDown={handleKeyDown}
        >
          {isLoading ? (
            <span className="inline-flex items-center">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="truncate">{placeholder}</span>
            </span>
          ) : (
            <span className="truncate">
              {selectedOption ? selectedOption.label : placeholder}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        onKeyDown={handleKeyDown}
      >
        <Command>
          <CommandInput placeholder="Search options..." aria-label="Search options" />
          <CommandList id={`${triggerId}-listbox`} role="listbox" aria-labelledby={triggerId}>
            <CommandEmpty>No option found.</CommandEmpty>
            <CommandGroup>
              {safeOptions.map((option) => {
                if (!option || typeof option.value === 'undefined') return null;
                const isSelected = safeValue === option.value;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.label || option.value}
                    onSelect={() => handleSelect(option.value)}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        isSelected ? "opacity-100" : "opacity-0"
                      )}
                      aria-hidden="true"
                    />
                    {option.label || option.value}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}