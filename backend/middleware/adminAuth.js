function extractToken(req) {
  const authHeader = req.headers.authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }

  const headerToken = req.headers['x-admin-token']
  if (typeof headerToken === 'string') return headerToken.trim()

  const anyaHeaderToken = req.headers['x-anya-token']
  if (typeof anyaHeaderToken === 'string') return anyaHeaderToken.trim()

  if (req.cookies && typeof req.cookies.anya_admin_token === 'string') {
    return req.cookies.anya_admin_token.trim()
  }

  return null
}

module.exports = function adminAuth(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.isAdmin)) {
    req.anyaActor = req.user.email ?? req.user.id ?? 'admin-user'
    return next()
  }

  const configuredToken = process.env.ANYA_ADMIN_TOKEN
  const token = extractToken(req)

  if (!configuredToken && !token) {
    return res.status(401).json({ error: 'Admin authentication required. Set ANYA_ADMIN_TOKEN.' })
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing admin credentials' })
  }

  if (configuredToken && token !== configuredToken) {
    return res.status(403).json({ error: 'Invalid admin credentials' })
  }

  req.anyaActor = 'admin-token'
  return next()
}
