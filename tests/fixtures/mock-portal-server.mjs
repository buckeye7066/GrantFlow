/**
 * mock-portal-server.mjs
 *
 * A tiny Express server that simulates an institutional scholarship
 * portal end-to-end so the Yana browser automation suite can run
 * without ever touching a live university portal.
 *
 * Routes:
 *   GET  /              → landing page with "Login" link
 *   GET  /login         → login form (username/password)
 *   POST /login         → sets a session cookie, redirects to /apply
 *   GET  /apply         → application form (gated by session cookie)
 *   POST /apply         → returns confirmation page with reference
 *
 * Behaviour we deliberately model:
 *   - Trying to GET /apply without the session cookie redirects to /login
 *     (so Yana detects the login gate and pauses).
 *   - The application form has a mix of recognized fields (first name,
 *     last name, email, school, major, gpa) and one unrecognized
 *     required field ("favorite_quote") so we can prove Yana flags
 *     missing info instead of inventing a value.
 *   - The submit button is labelled "Submit Application" so Yana's
 *     `detectSubmitButton` heuristic can find it.
 *   - The confirmation page renders "Confirmation reference: MOCK-123ABC"
 *     so the regex in the base adapter can extract it.
 */

import express from 'express'
import http from 'node:http'

export function createMockPortalApp({ requireFavoriteQuote = true } = {}) {
  const app = express()
  app.use(express.urlencoded({ extended: false }))
  app.use(express.json())

  // ── crude in-memory session store
  const sessions = new Set()
  function ensureSession(req, res) {
    const cookie = req.headers.cookie || ''
    const m = cookie.match(/portal_sid=([^;]+)/)
    return m && sessions.has(m[1])
  }

  app.get('/', (req, res) => {
    res.send(`<!doctype html><html><head><title>Mock Scholarship Portal</title></head>
      <body><h1>Mock Scholarship Portal</h1>
      <a href="/login" id="login-link">Sign in to apply</a></body></html>`)
  })

  app.get('/login', (req, res) => {
    res.send(`<!doctype html><html><head><title>Sign in — Mock Portal</title></head>
      <body><h1>Sign in</h1>
      <form method="POST" action="/login">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required />
        <button type="submit">Sign in</button>
      </form></body></html>`)
  })

  app.post('/login', (req, res) => {
    if (!req.body?.username || !req.body?.password) {
      return res.status(400).send('missing credentials')
    }
    const sid = `s_${Math.random().toString(36).slice(2)}_${Date.now()}`
    sessions.add(sid)
    res.setHeader('Set-Cookie', `portal_sid=${sid}; Path=/; HttpOnly`)
    return res.redirect(302, '/apply')
  })

  app.get('/apply', (req, res) => {
    if (!ensureSession(req, res)) return res.redirect(302, '/login')
    const fav = requireFavoriteQuote
      ? `<label for="favorite_quote">Favorite quote (required)</label>
         <textarea id="favorite_quote" name="favorite_quote" required></textarea>`
      : ''
    res.send(`<!doctype html><html><head><title>Scholarship Application — Mock Portal</title></head>
      <body><h1>Scholarship Application</h1>
      <form method="POST" action="/apply">
        <label for="first_name">First name</label>
        <input id="first_name" name="first_name" type="text" required />

        <label for="last_name">Last name</label>
        <input id="last_name" name="last_name" type="text" required />

        <label for="email">Email</label>
        <input id="email" name="email" type="email" required />

        <label for="school">School</label>
        <input id="school" name="school" type="text" required />

        <label for="major">Major / program</label>
        <input id="major" name="major" type="text" />

        <label for="gpa">GPA</label>
        <input id="gpa" name="gpa" type="number" step="0.01" />

        <label for="essay">Personal statement / essay</label>
        <textarea id="essay" name="essay" rows="4"></textarea>

        ${fav}

        <button type="button" id="save_draft">Save Draft</button>
        <button type="submit" id="submit_application">Submit Application</button>
      </form></body></html>`)
  })

  app.post('/apply', (req, res) => {
    if (!ensureSession(req, res)) return res.status(401).send('not logged in')
    const ref = `MOCK-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    res.send(`<!doctype html><html><head><title>Submitted — Mock Portal</title></head>
      <body><h1>Application submitted</h1>
      <p>Confirmation reference: ${ref}</p>
      </body></html>`)
  })

  return app
}

export async function startMockPortal({ port = 0, requireFavoriteQuote = true } = {}) {
  const app = createMockPortalApp({ requireFavoriteQuote })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const url = `http://127.0.0.1:${addr.port}`
  return {
    url,
    server,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
