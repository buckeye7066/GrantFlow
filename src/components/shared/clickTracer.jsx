// Global click tracer for debugging click interception issues
export function installClickTracer() {
  const enabled =
    (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV === true) ||
    String(typeof import.meta !== "undefined" && import.meta.env ? import.meta.env.VITE_ENABLE_CLICK_TRACER : "").toLowerCase() === "true";

  // Never install noisy tracing in production unless explicitly enabled.
  if (!enabled) return;

  if (window.__clickTracerInstalled) return;
  window.__clickTracerInstalled = true;

  document.addEventListener("click", (ev) => {
    const path = ev.composedPath?.() || [];
    const chain = path
      .filter((n) => n && n.tagName)
      .slice(0, 6)
      .map((n) => {
        const id = n.id ? `#${n.id}` : "";
        const cls = n.className && typeof n.className === "string" 
          ? "." + n.className.split(" ").slice(0, 3).join(".") 
          : "";
        return `${n.tagName.toLowerCase()}${id}${cls}`;
      })
      .join(" > ");
    console.debug("[TRACE click]", chain);
  }, { capture: true });
  
  console.debug("[Click Tracer] Installed successfully");
}