import crypto from 'crypto'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'

// In-memory ring buffer of recent client sign-ins.
// This intentionally does NOT require email/Resend and does not persist across restarts.
const MAX_EVENTS = Math.max(50, Math.min(1000, Number(process.env.ADMIN_LOGIN_EVENT_BUFFER || 200) || 200))

/** @type {Array<{id:string,type:'client_sign_in',at:string,identifier:string|null,method:string|null,user_id:string|null,profile_id:string|null,ip:string|null,user_agent:string|null}>} */
const events = []

function nowIso() {
  return new Date().toISOString()
}

function safeString(value, maxLen) {
  if (value === null || value === undefined) return null
  const s = String(value)
  if (!s) return null
  return s.length > maxLen ? s.slice(0, maxLen) : s
}

function safeUuid() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // ignore
  }
  return `evt_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`
}

export function recordClientSignInEvent({ identifier, method, userId, profileId, ip, userAgent } = {}) {
  const db = arguments?.[0]?.db ?? null
  const event = {
    id: safeUuid(),
    type: 'client_sign_in',
    at: nowIso(),
    identifier: safeString(identifier, 256),
    method: safeString(method, 64),
    user_id: safeString(userId, 128),
    profile_id: safeString(profileId, 128),
    ip: safeString(ip, 128),
    user_agent: safeString(userAgent, 256),
  }

  events.unshift(event)
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS
  }

  // Durable sink: DB audit logs (best-effort).
  if (db) {
    try {
      logAuditEvent(db, {
        category: AUDIT_CATEGORIES.AUTH,
        action: 'client_sign_in',
        severity: SEVERITY.INFO,
        userId: event.user_id ?? null,
        profileId: event.profile_id ?? null,
        resourceType: 'client_sign_in',
        resourceId: null,
        details: {
          identifier: event.identifier,
          method: event.method,
        },
        ipAddress: event.ip ?? null,
        userAgent: event.user_agent ?? null,
      })
    } catch {
      // best-effort only
    }
  }

  return event
}

export function listClientSignInEvents({ since, limit } = {}) {
  const cappedLimit = Math.max(1, Math.min(100, Number(limit || 25) || 25))
  const sinceMs = since ? Date.parse(String(since)) : NaN

  const filtered = Number.isFinite(sinceMs)
    ? events.filter((e) => Date.parse(e.at) > sinceMs)
    : events

  return filtered.slice(0, cappedLimit)
}

