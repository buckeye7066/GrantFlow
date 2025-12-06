// Global click tracer for debugging click interception issues
export function installClickTracer() {
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
    console.log("[TRACE click]", chain);
  }, { capture: true });
  
  console.log("[Click Tracer] Installed successfully");
}