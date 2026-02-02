import { z } from 'zod'

function normalizeBase(base) {
  if (!base) return '/'
  if (base === '/') return '/'
  return String(base).endsWith('/') ? String(base).slice(0, -1) : String(base)
}

const EnvSchema = z.object({
  DEV: z.boolean(),
  PROD: z.boolean(),
  BASE_URL: z.string().optional(),

  VITE_APP_BASE: z.string().optional(),
  VITE_API_URL: z.string().optional(),

  VITE_CANONICAL_HOST: z.string().optional(),
  VITE_CANONICAL_HOST_STRICT: z.string().optional(),

  // Feature flags (frontend-gated UI only; backend remains authoritative)
  VITE_SHOULDERS_VNEXT: z.string().optional(),
})

export const env = (() => {
  const raw = {
    DEV: import.meta.env.DEV,
    PROD: import.meta.env.PROD,
    BASE_URL: import.meta.env.BASE_URL,
    VITE_APP_BASE: import.meta.env.VITE_APP_BASE,
    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_CANONICAL_HOST: import.meta.env.VITE_CANONICAL_HOST,
    VITE_CANONICAL_HOST_STRICT: import.meta.env.VITE_CANONICAL_HOST_STRICT,
    VITE_SHOULDERS_VNEXT: import.meta.env.VITE_SHOULDERS_VNEXT,
  }

  const parsed = EnvSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn('[env] Frontend env validation failed:', parsed.error.issues)
  }

  const appBase = normalizeBase(raw.VITE_APP_BASE ?? raw.BASE_URL ?? '/')
  const canonicalHost = String(raw.VITE_CANONICAL_HOST || '').trim() || null
  const canonicalStrict = String(raw.VITE_CANONICAL_HOST_STRICT || '').toLowerCase() === 'true'

  const apiUrlRaw = String(raw.VITE_API_URL || '').trim()
  const apiUrl = apiUrlRaw ? apiUrlRaw : ''

  const shouldersVnext =
    String(raw.VITE_SHOULDERS_VNEXT || '').trim().toLowerCase() === 'true'

  return {
    isDev: !!raw.DEV,
    isProd: !!raw.PROD,
    appBase,
    apiUrl,
    canonicalHost,
    canonicalStrict,
    shouldersVnext,
  }
})()