import { useEffect } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { flashHighlight } from "@/lib/flashHighlight"

/**
 * FlashHighlighter — watches the URL for a `?flash=<targets>` param (set when a
 * clickable toast / notification navigates the user to the spot that needs
 * attention) and flashes the matching element(s). The param is then stripped so
 * a refresh/back doesn't re-trigger it. Mounted once near the app root, inside
 * the Router.
 */
export default function FlashHighlighter() {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const flash = params.get("flash")
    if (!flash) return

    flashHighlight(flash)

    // Remove only the flash param; keep tab/section/field/etc. intact.
    params.delete("flash")
    const qs = params.toString()
    navigate(`${location.pathname}${qs ? `?${qs}` : ""}${location.hash || ""}`, { replace: true })
  }, [location.pathname, location.search, location.hash, navigate])

  return null
}
