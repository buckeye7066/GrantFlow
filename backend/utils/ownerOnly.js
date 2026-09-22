import { isAdminEmail } from '../config/constants.js'

export function ownerOnlyEnabled(env = process.env) {
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'test') return false
  return String(env.OWNER_ONLY_MODE ?? 'true').trim().toLowerCase() !== 'false'
}

export function isOwnerIdentity(user, env = process.env) {
  if (!ownerOnlyEnabled(env)) return true
  const email = String(user?.email || user?.primary_email || '').trim().toLowerCase()
  const admin = Boolean(
    user?.is_admin ||
    user?.role === 'admin' ||
    (Array.isArray(user?.roles) && user.roles.includes('admin'))
  )
  return admin && isAdminEmail(email)
}

export function assertOwnerIdentity(user, env = process.env) {
  if (isOwnerIdentity(user, env)) return
  const error = new Error('Access is restricted to the owner account')
  error.status = 403
  error.code = 'OWNER_ONLY_ACCESS'
  throw error
}
