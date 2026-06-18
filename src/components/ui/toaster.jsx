import { useLocation, useNavigate } from "react-router-dom";
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

// Normalise paths for "are we already here?" comparison (ignore the flash param).
function stripFlash(path) {
  if (!path) return "";
  const [base, query = ""] = String(path).split("?");
  if (!query) return base;
  const params = new URLSearchParams(query);
  params.delete("flash");
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function Toaster() {
  const { toasts } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  // Re-derived on every navigation so a toast that outlives its origin page
  // becomes clickable ("take me back to where this happened").
  const here = stripFlash(`${location.pathname}${location.search || ""}`);

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, navigateTo, flash, originRoute, ...props }) {
        // Destination: an explicit navigateTo wins; otherwise fall back to the
        // route the toast was fired from (so it can take you back to where it's
        // relevant). A toast is clickable when there's somewhere meaningful to
        // go — an explicit target/flash, or an origin different from where we
        // are now. Pure same-page confirmations stay non-clickable.
        const dest = navigateTo || originRoute || null;
        const destElsewhere = dest && stripFlash(dest) !== here;
        const clickable = Boolean(navigateTo || flash || destElsewhere);

        const handleActivate = (event) => {
          // Don't hijack clicks on the toast's own action buttons / close (X).
          if (event?.target?.closest?.("[data-toast-noclick],button,a")) return;
          if (dest) {
            navigate(withFlashParam(dest, flash));
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
              {title && <ToastTitle>{title}</ToastTitle>}
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
