import React from "react"
import { KeyRound, ExternalLink, LogIn, Search, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createPageUrl } from "@/utils"
import { safeHttpUrl, hostFromUrl } from "@/lib/safeUrl"
import { openWithHamiltonWatching } from "@/components/hamilton/hamiltonWatchedOpen"
import { useToast } from "@/components/ui/use-toast"

// When we have no portal/login URL on file but we DO know the school / funding
// source name, build a web search for its login page so the control is never a
// dead end. This is the global guarantee: PortalLoginButton always does
// something useful.
function loginSearchUrl(name) {
  const q = String(name || "").trim()
  if (!q) return null
  return `https://www.google.com/search?q=${encodeURIComponent(`${q} login portal`)}`
}

/**
 * PortalLoginButton
 *
 * One consistent, obvious control for "log in to this portal" — dropped onto
 * EVERY funding-source and college surface so the path to (a) opening the
 * portal/application login page and (b) setting up the saved login Hamilton
 * uses is always one click away, not buried.
 *
 * Two actions:
 *   1. "Log in to portal" — with a profileId, opens the portal through
 *      Hamilton's WATCHED secure window (cloud-login co-browse, session
 *      captured for the profile — see hamiltonWatchedOpen.js); without one it
 *      falls back to a plain new tab. When there is no valid http(s) URL we
 *      render a subtle disabled state instead of a broken link.
 *   2. "Save login for Hamilton" — deep-links to the profile's Pipeline tab
 *      with ?addLogin=<host>&loginUrl=<url> so SavedLoginsCard opens its
 *      Add-Login dialog pre-filled. Requires a profileId; hidden without one.
 *
 * @param {object}  props
 * @param {string}  [props.profileId]  Profile to attach the saved login to. Omit
 *                                     to hide the save-login action (open-only).
 * @param {string}  props.url          Portal / application login URL.
 * @param {string}  [props.label]      Override the primary button label.
 * @param {string}  [props.size]       Button size (default "sm").
 * @param {string}  [props.variant]    Primary button variant (default "outline").
 * @param {string}  [props.className]  Extra classes on the wrapper.
 */
export default function PortalLoginButton({
  profileId,
  url,
  label = "Log in to portal",
  size = "sm",
  variant = "outline",
  className = "",
  // Name of the school / funding source. When there's no valid `url`, we use
  // this to open a web search for the login page instead of rendering a dead,
  // un-clickable "No portal link" button. Pass it everywhere a name is known.
  searchName = "",
}) {
  const { toast } = useToast()
  const [opening, setOpening] = React.useState(false)
  const href = safeHttpUrl(url)
  const host = hostFromUrl(url)
  const canSaveLogin = Boolean(profileId) && Boolean(host)
  // Fallback target when no real URL is on file but we know the name.
  const searchHref = href ? null : loginSearchUrl(searchName)

  // With a profile in scope, opening the portal MUST go through Hamilton's
  // watched window — never a bare tab Hamilton can't see. Popup opens inside
  // this gesture (first line of the helper), so no awaits before the call.
  const openWatched = (e) => {
    e.stopPropagation()
    setOpening(true)
    openWithHamiltonWatching({
      profileId,
      url: href,
      label: searchName || host,
      toast,
    }).finally(() => setOpening(false))
  }

  // Plain anchor (not useNavigate) so this control works in ANY render context
  // — including the many card surfaces and tests that aren't wrapped in a
  // <Router> — and so a full navigation re-runs SavedLoginsCard's mount effect
  // that reads ?addLogin/?loginUrl and opens the pre-filled dialog.
  const saveLoginHref = canSaveLogin
    ? createPageUrl("ProfileDetail", {
        id: profileId,
        tab: "pipeline",
        addLogin: host,
        loginUrl: href || url || "",
      })
    : null

  return (
    <div className={`inline-flex items-center gap-1 ${className}`} data-portal-login>
      {href && profileId ? (
        <Button
          type="button"
          variant={variant}
          size={size}
          className="gap-1.5"
          disabled={opening}
          onClick={openWatched}
          title="Open this portal in Hamilton's watched window — he learns the login so it's automatic next time"
        >
          {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <LogIn className="h-3.5 w-3.5" />}
          {label}
        </Button>
      ) : href ? (
        <Button
          asChild
          variant={variant}
          size={size}
          className="gap-1.5"
          title="Open this portal's login / application page in a new tab"
        >
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <LogIn className="h-3.5 w-3.5" />
            {label}
          </a>
        </Button>
      ) : searchHref ? (
        // No URL on file, but we know the name — stay CLICKABLE: open a web
        // search for the login page rather than a dead "No portal link" button.
        <Button
          asChild
          variant={variant}
          size={size}
          className="gap-1.5"
          title={`No saved link yet — search the web for ${searchName}'s login page`}
        >
          <a
            href={searchHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <Search className="h-3.5 w-3.5" />
            Find login page
          </a>
        </Button>
      ) : (
        <Button
          variant="ghost"
          size={size}
          disabled
          className="gap-1.5 text-slate-400"
          title="No portal/application link on file for this source yet"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          No portal link
        </Button>
      )}

      {canSaveLogin && (
        <Button
          asChild
          variant="ghost"
          size={size === "icon" ? "icon" : "sm"}
          className="gap-1.5 text-indigo-700 hover:text-indigo-800"
          title="Save this portal's login so Hamilton can sign in for you"
        >
          <a href={saveLoginHref} onClick={(e) => e.stopPropagation()}>
            <KeyRound className="h-3.5 w-3.5" />
            {size === "icon" ? null : "Save login for Hamilton"}
          </a>
        </Button>
      )}
    </div>
  )
}
