import * as React from "react"

const CollapsibleContext = React.createContext({ open: false, onOpenChange: () => {} });

const Collapsible = ({ open, onOpenChange, defaultOpen, children, ...props }) => {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen || false);
  
  const currentOpen = open !== undefined ? open : internalOpen;
  const handleOpenChange = open !== undefined ? onOpenChange : setInternalOpen;

  return (
    <CollapsibleContext.Provider value={{ open: currentOpen, onOpenChange: handleOpenChange }}>
      <div {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
};

const CollapsibleTrigger = React.forwardRef(({ children, ...props }, ref) => {
  const context = React.useContext(CollapsibleContext);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => context.onOpenChange(!context.open)}
      {...props}
    >
      {children}
    </button>
  );
});
CollapsibleTrigger.displayName = "CollapsibleTrigger";

const CollapsibleContent = React.forwardRef(({ children, ...props }, ref) => {
  const context = React.useContext(CollapsibleContext);

  if (!context.open) return null;

  return (
    <div ref={ref} {...props}>
      {children}
    </div>
  );
});
CollapsibleContent.displayName = "CollapsibleContent";

export { Collapsible, CollapsibleTrigger, CollapsibleContent }