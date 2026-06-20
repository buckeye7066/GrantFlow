/**
 * portalSync/connectors/generic.js
 *
 * Fallback connector for any portal that has a saved login/session but no
 * dedicated connector yet. It proves access (navigates to the portal using the
 * authenticated context Hamilton already holds) but does NOT pretend to
 * understand the portal's structure — it returns honest, empty results with a
 * note. This keeps every saved-login portal "connectable" in the UI instead of
 * showing the dead "no connectable portals" state, while never fabricating data.
 *
 * Hamilton owns the URL here too: it derives the destination from the saved
 * credential's login_url when present, else https://<portalHost>/ — the user
 * never has to supply a URL.
 */

const GENERIC_NOTE =
  'Signed in successfully, but there is no structured data connector for this portal yet, ' +
  'so no fields were read/written. (A dedicated connector is needed to map this portal.)'

function destinationUrl(ctx) {
  const loginUrl = ctx?.credential?.login_url || ctx?.credential?.loginUrl || null
  if (loginUrl && /^https?:\/\//i.test(loginUrl)) return loginUrl
  return `https://${ctx?.portalHost || ''}/`
}

async function visit(page, ctx) {
  const url = destinationUrl(ctx)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return { reached: true, url }
  } catch (err) {
    return { reached: false, url, error: err?.message || String(err) }
  }
}

const generic = {
  id: 'generic',
  label: 'Generic portal (sign-in only)',
  hostMatch: /.*/,

  async read(page, ctx) {
    const nav = await visit(page, ctx)
    return {
      fields: [],
      awards: [],
      notFound: [nav.reached ? GENERIC_NOTE : `Could not reach ${nav.url}: ${nav.error}`],
      raw: { navigated: nav },
    }
  },

  async write(page, ctx /*, data */) {
    const nav = await visit(page, ctx)
    return {
      written: [],
      skipped: [nav.reached ? GENERIC_NOTE : `Could not reach ${nav.url}: ${nav.error}`],
    }
  },
}

export default generic
