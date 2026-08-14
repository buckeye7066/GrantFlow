import * as React from "react"
import { Check, ChevronsUpDown, X, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

export default function MultiSelectCombobox({ 
  options = [], 
  selected = [], 
  onSelectedChange, 
  placeholder,
  className,
  allowCustom = false,
  singleSelect = false
}) {
  const [open, setOpen] = React.useState(false)
  const [inputValue, setInputValue] = React.useState('')

  const selectedOptions = React.useMemo(() => {
    return options.filter(option => selected.includes(option.value));
  }, [options, selected]);

  const handleToggleOption = (optionValue) => {
    if (!onSelectedChange) {
      console.error('MultiSelectCombobox: onSelectedChange prop is missing');
      return;
    }
    
    if (singleSelect) {
      onSelectedChange(optionValue);
      setOpen(false);
    } else {
      const newValue = selected.includes(optionValue)
        ? selected.filter(v => v !== optionValue)
        : [...selected, optionValue];
      onSelectedChange(newValue);
    }
  };

  const handleAddCustom = () => {
    if (!allowCustom || !inputValue.trim()) return;
    
    const trimmedValue = inputValue.trim();
    if (!selected.includes(trimmedValue)) {
      onSelectedChange([...selected, trimmedValue]);
    }
    setInputValue('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && allowCustom && inputValue.trim()) {
      e.preventDefault();
      handleAddCustom();
    }
  };

  const handleRemove = (valueToRemove) => {
    onSelectedChange(selected.filter(v => v !== valueToRemove));
  };

  // For custom/tag input mode (emails, phones)
  if (allowCustom && options.length === 0) {
    return (
      <div className={cn("space-y-2", className)}>
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1"
          />
          <Button
            type="button"
            onClick={handleAddCustom}
            disabled={!inputValue.trim()}
            variant="outline"
            size="sm"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
        
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {selected.map((value) => (
              <Badge
                key={value}
                variant="secondary"
                className="rounded-sm pr-1"
              >
                {value}
                <button
                  type="button"
                  onClick={() => handleRemove(value)}
                  className="ml-1 rounded-sm hover:bg-slate-300 p-0.5"
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        
        {selected.length === 0 && (
          <p className="text-xs text-slate-500">
            Type and press Enter or click + to add
          </p>
        )}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between h-auto min-h-[40px]", className)}
        >
          <div className="flex flex-wrap gap-1">
            {selectedOptions.length > 0 ? (
              selectedOptions.map(option => (
                <Badge
                  key={option.value}
                  variant="secondary"
                  className="rounded-sm"
                >
                  {option.label}
                </Badge>
              ))
            ) : (
              <span>{placeholder}</span>
            )}
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput 
            placeholder="Search options..." 
            value={inputValue}
            onValueChange={setInputValue}
            onKeyDown={handleKeyDown}
          />
          <CommandList>
            <CommandEmpty>
              {allowCustom && inputValue.trim() ? (
                <div className="p-2">
                  <Button
                    type="button"
                    onClick={() => {
                      handleAddCustom();
                      setOpen(false);
                    }}
                    variant="ghost"
                    className="w-full justify-start"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add "{inputValue.trim()}"
                  </Button>
                </div>
              ) : (
                'No option found.'
              )}
            </CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => handleToggleOption(option.value)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selected.includes(option.value) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}