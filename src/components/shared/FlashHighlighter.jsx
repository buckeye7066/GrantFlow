import { useEffect } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { flashHighlight } from "@/lib/flashHighlight"
import { setCurrentRoute } from "@/lib/currentRoute"

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

  // Keep the current route available to toast() so every toast can remember
  // where it was fired (its default click target). Stored WITHOUT the flash
  // param so a toast never points back at a stale flash.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    params.delete("flash")
    const qs = params.toString()
    setCurrentRoute(`${location.pathname}${qs ? `?${qs}` : ""}`)
  }, [location.pathname, location.search])

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
