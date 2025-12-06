import * as React from "react";
import { cn } from "@/lib/utils";

const DropdownMenu = ({ children }) => {
  const [open, setOpen] = React.useState(false);
  
  return (
    <div className="relative inline-block">
      {React.Children.map(children, child =>
        React.cloneElement(child, { open, setOpen })
      )}
    </div>
  );
};

const DropdownMenuTrigger = React.forwardRef(({ className, children, asChild, open, setOpen, ...props }, ref) => {
  const handleClick = () => setOpen(!open);
  
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      onClick: handleClick,
      ref,
      ...props
    });
  }
  
  return (
    <button
      ref={ref}
      onClick={handleClick}
      className={cn("inline-flex items-center justify-center", className)}
      {...props}
    >
      {children}
    </button>
  );
});
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

const DropdownMenuContent = React.forwardRef(({ 
  className, 
  children, 
  align = "start",
  open, 
  setOpen,
  ...props 
}, ref) => {
  const contentRef = React.useRef(null);
  
  React.useEffect(() => {
    const handleClickOutside = (event) => {
      if (contentRef.current && !contentRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open, setOpen]);
  
  if (!open) return null;
  
  const alignmentClass = align === "end" ? "right-0" : "left-0";
  
  return (
    <div
      ref={contentRef}
      className={cn(
        "absolute z-50 min-w-[8rem] mt-2 overflow-hidden rounded-md border bg-white p-1 text-slate-950 shadow-md",
        alignmentClass,
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
});
DropdownMenuContent.displayName = "DropdownMenuContent";

const DropdownMenuItem = React.forwardRef(({ 
  className, 
  children,
  asChild,
  ...props 
}, ref) => {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      className: cn(
        "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-slate-100 focus:bg-slate-100",
        children.props.className
      ),
      ref,
      ...props
    });
  }
  
  return (
    <div
      ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-slate-100 focus:bg-slate-100",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
});
DropdownMenuItem.displayName = "DropdownMenuItem";

const DropdownMenuLabel = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

const DropdownMenuSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-slate-100", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

const DropdownMenuGroup = ({ children }) => <>{children}</>;
const DropdownMenuPortal = ({ children }) => <>{children}</>;
const DropdownMenuSub = ({ children }) => <>{children}</>;
const DropdownMenuSubContent = ({ children }) => <>{children}</>;
const DropdownMenuSubTrigger = ({ children }) => <>{children}</>;
const DropdownMenuRadioGroup = ({ children }) => <>{children}</>;
const DropdownMenuCheckboxItem = ({ children }) => <>{children}</>;
const DropdownMenuRadioItem = ({ children }) => <>{children}</>;
const DropdownMenuShortcut = ({ className, ...props }) => (
  <span className={cn("ml-auto text-xs tracking-widest opacity-60", className)} {...props} />
);

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};