import * as React from "react";
import { Check, ChevronsUpDown, X, Plus } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

/**
 * Normalize a string for duplicate checks: trim whitespace & lower-case.
 * Preserve user casing for display.
 */
const normalizeKey = (value) => {
  if (!value || typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().toLowerCase();
};

/**
 * MultiSelectCombobox - Multi/single select with custom entry support
 * @param {Object} props
 * @param {Array} props.options - Array of {value, label} options
 * @param {string[]|string} props.selected - Selected value(s)
 * @param {Function} props.onSelectedChange - Change handler
 * @param {string} props.placeholder - Placeholder text
 * @param {string} props.className - Additional class names
 * @param {boolean} props.allowCustom - Allow custom entries
 * @param {boolean} props.singleSelect - Single select mode
 */
export default function MultiSelectCombobox({
  options,
  selected,
  onSelectedChange,
  placeholder = "Select items...",
  className,
  allowCustom = false,
  singleSelect = false,
}) {
  // Null-safe defaults
  const safeOptions = Array.isArray(options) ? options : [];
  const safeSelected = singleSelect
    ? (typeof selected === "string" ? selected : "")
    : (Array.isArray(selected) ? selected : []);

  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState("");
  const triggerRef = React.useRef(null);
  const [triggerWidth, setTriggerWidth] = React.useState("auto");
  const listboxId = React.useId();
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Sync popover width with trigger width; remeasure on open and resize
  React.useEffect(() => {
    const measure = () => {
      if (triggerRef.current) {
        const w = triggerRef.current.offsetWidth;
        if (mountedRef.current) setTriggerWidth(`${w}px`);
      }
    };
    measure();

    let ro = null;
    if (triggerRef.current && "ResizeObserver" in window) {
      ro = new ResizeObserver(measure);
      ro.observe(triggerRef.current);
    } else {
      window.addEventListener("resize", measure);
    }
    return () => {
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", measure);
    };
  }, [open]);

  // Selected options (display)
  const selectedOptions = React.useMemo(() => {
    if (singleSelect) {
      const sel = typeof safeSelected === "string" ? safeSelected : "";
      const found = safeOptions.find((o) => o?.value === sel);
      return found ? [found] : [];
    }
    const selArr = Array.isArray(safeSelected) ? safeSelected : [];
    return safeOptions.filter((opt) => opt && selArr.includes(opt.value));
  }, [safeOptions, safeSelected, singleSelect]);

  // Case-insensitive existence check across options + selection
  const existsCI = React.useCallback(
    (value) => {
      const nk = normalizeKey(value);
      if (!nk) return false;

      // In selected
      if (singleSelect) {
        if (typeof safeSelected === "string" && normalizeKey(safeSelected) === nk) return true;
      } else if (Array.isArray(safeSelected)) {
        if (safeSelected.some((s) => normalizeKey(s) === nk)) return true;
      }

      // In options
      return safeOptions.some(
        (o) => o && (normalizeKey(o.label) === nk || normalizeKey(o.value) === nk)
      );
    },
    [safeOptions, safeSelected, singleSelect]
  );

  // Safe change emit
  const emitChange = React.useCallback(
    (next) => {
      if (typeof onSelectedChange === "function") {
        return onSelectedChange(next);
      }
      console.warn("MultiSelectCombobox: onSelectedChange prop is missing");
      return undefined;
    },
    [onSelectedChange]
  );

  // Toggle option
  const handleToggleOption = React.useCallback(
    (optionValue) => {
      if (typeof onSelectedChange !== "function") {
        console.error("MultiSelectCombobox: onSelectedChange prop is missing");
        return;
      }
      if (singleSelect) {
        // No-op if same value
        if (typeof safeSelected === "string" && safeSelected === optionValue) {
          setOpen(false);
          return;
        }
        emitChange(optionValue);
        setOpen(false);
      } else {
        const selArr = Array.isArray(safeSelected) ? safeSelected : [];
        const exists = selArr.includes(optionValue);
        const next = exists ? selArr.filter((v) => v !== optionValue) : [...selArr, optionValue];
        emitChange(next);
      }
    },
    [emitChange, onSelectedChange, safeSelected, singleSelect]
  );

  // Add custom
  const handleAddCustom = React.useCallback(() => {
    if (!allowCustom) return;
    const raw = inputValue;
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    if (existsCI(trimmed)) {
      setInputValue("");
      return;
    }
    if (singleSelect) {
      emitChange(trimmed);
      setOpen(false);
    } else {
      const selArr = Array.isArray(safeSelected) ? safeSelected : [];
      emitChange([...selArr, trimmed]);
    }
    setInputValue("");
  }, [allowCustom, inputValue, existsCI, emitChange, safeSelected, singleSelect]);

  // Keyboard
  const handleKeyDown = React.useCallback(
    (e) => {
      if (e.key === "Enter" && allowCustom && inputValue.trim()) {
        e.preventDefault();
        handleAddCustom();
      }
      if (e.key === "Escape") {
        setInputValue("");
        if (open) setOpen(false);
      }
    },
    [allowCustom, inputValue, handleAddCustom, open]
  );

  // Remove item
  const handleRemove = React.useCallback(
    (valueToRemove) => {
      if (typeof onSelectedChange !== "function") return;
      if (singleSelect) {
        emitChange("");
      } else {
        const selArr = Array.isArray(safeSelected) ? safeSelected : [];
        emitChange(selArr.filter((v) => v !== valueToRemove));
      }
    },
    [emitChange, onSelectedChange, safeSelected, singleSelect]
  );

  // Memo display text
  const displayText = React.useMemo(() => {
    if (selectedOptions.length > 0) return null;
    return placeholder;
  }, [selectedOptions.length, placeholder]);

  // Custom/tag-only mode
  if (allowCustom && safeOptions.length === 0) {
    const displaySelected =
      singleSelect && typeof safeSelected === "string" && safeSelected
        ? [safeSelected]
        : Array.isArray(safeSelected)
        ? safeSelected
        : [];

    return (
      <div className={cn("space-y-2", className)} role="group" aria-label={placeholder}>
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1"
            aria-label={placeholder}
            aria-describedby={displaySelected.length > 0 ? "selected-items-list" : "input-hint"}
          />
          <Button
            type="button"
            onClick={handleAddCustom}
            disabled={!inputValue.trim()}
            variant="outline"
            size="sm"
            aria-label="Add custom item"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>

        {displaySelected.length > 0 && (
          <div
            id="selected-items-list"
            className="flex flex-wrap gap-2"
            role="list"
            aria-label="Selected items"
            aria-live="polite"
          >
            {displaySelected.map((v) => (
              <Badge
                key={v}
                variant="secondary"
                className="rounded-sm pr-1"
                role="listitem"
              >
                {v}
                <button
                  type="button"
                  onClick={() => handleRemove(v)}
                  className="ml-1 rounded-sm hover:bg-slate-300 p-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                  aria-label={`Remove ${v}`}
                  tabIndex={0}
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        {displaySelected.length === 0 && (
          <p className="text-xs text-slate-500" id="input-hint">
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
          ref={triggerRef}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={placeholder}
          aria-controls={open ? listboxId : undefined}
          className={cn("w-full justify-between h-auto min-h-[40px]", className)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        >
          <div className="flex flex-wrap gap-1 flex-1 items-center">
            {selectedOptions.length > 0 ? (
              selectedOptions.map((option) => (
                <Badge
                  key={option.value}
                  variant="secondary"
                  className="rounded-sm"
                  role="status"
                  aria-label={`Selected: ${option.label}`}
                >
                  {option.label}
                </Badge>
              ))
            ) : (
              <span className="text-muted-foreground text-sm">{displayText}</span>
            )}
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        align="start"
        style={{ width: triggerWidth, minWidth: "200px" }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
      >
        <Command>
          <CommandInput
            placeholder={`Search ${placeholder.toLowerCase()}...`}
            value={inputValue}
            onValueChange={setInputValue}
            onKeyDown={handleKeyDown}
            aria-label="Search options"
          />
          <CommandList id={listboxId} role="listbox" aria-label="Available options">
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
                    aria-label={`Add custom item: ${inputValue.trim()}`}
                  >
                    <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
                    Add "{inputValue.trim()}"
                  </Button>
                </div>
              ) : (
                <div className="p-2 text-sm text-muted-foreground" role="status">
                  No option found.
                </div>
              )}
            </CommandEmpty>
            <CommandGroup>
              {safeOptions.map((option) => {
                if (!option || typeof option.value === 'undefined') return null;
                const isSelected = singleSelect
                  ? typeof safeSelected === "string" && safeSelected === option.value
                  : Array.isArray(safeSelected) && safeSelected.includes(option.value);

                return (
                  <CommandItem
                    key={option.value}
                    value={option.label || option.value}
                    onSelect={() => handleToggleOption(option.value)}
                    role="option"
                    aria-selected={!!isSelected}
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