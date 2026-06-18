import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { flashHighlight, withFlashParam } from "@/lib/flashHighlight";
import { ArrowRight } from "lucide-react";

export function Toaster() {
  const { toasts } = useToast();
  const navigate = useNavigate();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, navigateTo, flash, ...props }) {
        // A toast is "clickable" when it knows where attention is needed: a
        // route to open (navigateTo) and/or an element to flash (flash).
        const clickable = Boolean(navigateTo || flash);

        const handleActivate = (event) => {
          // Don't hijack clicks on the toast's own action buttons / close (X).
          if (event?.target?.closest?.("[data-toast-noclick],button,a")) return;
          if (navigateTo) {
            navigate(withFlashParam(navigateTo, flash));
          } else if (flash) {
            flashHighlight(flash);
          }
          props.onOpenChange?.(false);
        };

        return (
          <Toast key={id} {...props}>
            <div
              className={clickable ? "grid gap-1 cursor-pointer pr-1" : "grid gap-1"}
              onClick={clickable ? handleActivate : undefined}
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleActivate(e); }
                    }
                  : undefined
              }
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
            >
              {title && (
                <ToastTitle className={clickable ? "flex items-center gap-1" : undefined}>
                  {title}
                </ToastTitle>
              )}
              {description && <ToastDescription>{description}</ToastDescription>}
              {clickable && (
                <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-600">
                  Take me there <ArrowRight className="h-3 w-3" />
                </span>
              )}
            </div>
            {action}
            <ToastClose onClick={() => props.onOpenChange?.(false)} />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
