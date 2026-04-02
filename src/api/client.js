import { env } from '@/config/env.js'
import { createLogger } from '@/utils/logger'
import { toast as showToast } from '@/components/ui/use-toast'

// API Client

// Use relative URLs in production (proxied by Vercel) to avoid CORS issues.
// When the app is served under a base path (e.g. /grantflow), API requests must
// use that prefix so rewrites like /grantflow/api/:path* reach the backend.
const API_URL = env.apiUrl || (env.appBase && env.appBase !== '/' ? env.appBase : '')

// Frontend startup sanity (non-fatal): warn on env drift / misconfiguration.
if (import.meta.env.DEV) {
  const raw = import.meta.env.VITE_API_URL
  if (raw && !/^https?:\/\//i.test(String(raw))) {
    console.warn('[env] VITE_API_URL should be http(s)://...; falling back to same-origin proxy. value=', raw)
  }
}

const log = createLogger('APIClient')

class APIClient {
  constructor() {
    this.baseUrl = API_URL;
    this.token = null;
    this.refreshToken = null;
    this.activeProfileId = null;
    this.refreshPromise = null; // Single-flight refresh promise
    this.onAuthFailure = null;
    this.entityResourceMap = {
      Organization: 'organizations',
      Grant: 'grants',
      FundingOpportunity: 'opportunities',
      Opportunity: 'opportunities',
      Milestone: 'milestones',
      Document: 'documents',
      Expense: 'expenses',
      Profile: 'profiles',
      CrawlLog: 'crawl-logs',
      SourceDirectory: 'source-directory',
      Budget: 'budgets',
      Contact: 'contacts',
      ContactMethod: 'contact-methods',
      ApplicationDraft: 'application-drafts',
      BillingSettings: 'billing-settings',
    };
    this.stubStores = new Map();
    this.stubWarnings = new Set();
    this.isDev = import.meta.env?.DEV ?? false;
    this.entities = {};
    this._inflightRequests = new Map();

    // Persisted active profile context for profile-scoped requests.
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('grantflow:active-profile-id')
      this.activeProfileId = stored && String(stored).trim() ? String(stored).trim() : null
    }
  }

  getRequestId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch {
      // fall through to fallback request id
    }
    return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  setAuthFailureHandler(handler) {
    this.onAuthFailure = handler;
  }

  setToken(token) {
    this.token = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem('grantflow:access-token', token);
    }
  }

  setRefreshToken(token) {
    this.refreshToken = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem('grantflow:refresh-token', token);
    }
  }

  setActiveProfileId(profileId) {
    const normalized = profileId ? String(profileId).trim() : ''
    this.activeProfileId = normalized ? normalized : null
    if (typeof window !== 'undefined') {
      if (this.activeProfileId) {
        localStorage.setItem('grantflow:active-profile-id', this.activeProfileId)
      } else {
        localStorage.removeItem('grantflow:active-profile-id')
      }
    }
  }

  getActiveProfileId() {
    if (this.activeProfileId) return this.activeProfileId
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('grantflow:active-profile-id')
      return stored && String(stored).trim() ? String(stored).trim() : null
    }
    return null
  }

  getToken() {
    if (this.token) return this.token;
    if (typeof window !== 'undefined') {
      return localStorage.getItem('grantflow:access-token');
    }
    return null;
  }

  getRefreshToken() {
    if (this.refreshToken) return this.refreshToken;
    if (typeof window !== 'undefined') {
      return localStorage.getItem('grantflow:refresh-token');
    }
    return null;
  }

  clearToken() {
    this.token = null;
    this.refreshToken = null;
    this.refreshPromise = null; // Clear any pending refresh
    this.activeProfileId = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('grantflow:access-token');
      localStorage.removeItem('grantflow:refresh-token');
      localStorage.removeItem('grantflow:active-profile-id');
    }
  }

  createAuthError(message) {
    const error = new Error(message);
    error.status = 401;
    return error;
  }

  async handleUnauthorized(originalRequest) {
    const refreshToken = this.getRefreshToken();
    
    // CRITICAL: Don't attempt refresh if no token exists
    if (!refreshToken) {
      console.warn('[APIClient] No refresh token available, clearing auth state');
      this.clearToken();
      if (this.onAuthFailure) {
        this.onAuthFailure('Your session expired. Sign in again to continue.');
      }
      // Don't redirect automatically - let the app handle it
      throw this.createAuthError('Authentication required');
    }
    
    // If the original request was to /refresh, don't try again - just fail
    if (originalRequest?.endpoint?.includes('/auth/refresh')) {
      console.warn('[APIClient] Refresh endpoint failed, clearing auth state');
      this.clearToken();
      if (this.onAuthFailure) {
        this.onAuthFailure('Your session is no longer valid. Please sign in again.');
      }
      throw this.createAuthError('Session expired');
    }
    
    // Delegate to the shared single-flight refreshTokens() so all callers
    // (handleUnauthorized, authStore timer, proactive refresh) share one promise.
    log.debug('starting token refresh via refreshTokens()')
    try {
      await this.refreshTokens()
    } catch (error) {
      console.error('[APIClient] Token refresh failed:', error.message)
      const authError = this.createAuthError('Your session has expired. Please sign in again.')
      authError.isAuthError = true
      throw authError
    }

    // Retry the original request with the new token.
    log.debug('retrying original request after refresh')
    return this.fetch(originalRequest.endpoint, originalRequest.options);
  }

  /**
   * Refresh the access token using the single-flight refreshPromise.
   * Call this instead of hitting /api/auth/refresh directly so that concurrent
   * callers (e.g. authStore's scheduleSessionRefresh timer) share the same
   * in-flight request and we never send two simultaneous refresh calls.
   *
   * @returns {Promise<{accessToken: string, refreshToken?: string}>} The new tokens.
   */
  async refreshTokens() {
    const refreshToken = this.getRefreshToken()
    if (!refreshToken) {
      this.clearToken()
      throw this.createAuthError('Authentication required')
    }

    // Reuse any in-flight refresh.
    if (this.refreshPromise) {
      log.debug('refreshTokens: reusing in-flight refresh promise')
      return this.refreshPromise
    }

    // Start a new single-flight refresh.
    log.debug('refreshTokens: starting new refresh')
    this.refreshPromise = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ refreshToken }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
          if (response.status === 401) {
            this.clearToken()
          }
          throw new Error(errorData.error || `Refresh failed with status ${response.status}`)
        }

        const data = await response.json()
        if (data?.accessToken) this.setToken(data.accessToken)
        if (data?.refreshToken) this.setRefreshToken(data.refreshToken)
        return data
      } catch (error) {
        this.clearToken()
        if (this.onAuthFailure) {
          this.onAuthFailure('Your session expired. Sign in again to continue.')
        }
        throw error
      } finally {
        this.refreshPromise = null
      }
    })()

    return this.refreshPromise
  }

  // HTTP method shims.
  // Some parts of the app (and release-hardening tests) expect `client.get/patch/...` to exist.
  get(endpoint, options = {}) {
    return this.fetch(endpoint, { ...options, method: 'GET' })
  }

  delete(endpoint, options = {}) {
    return this.fetch(endpoint, { ...options, method: 'DELETE' })
  }

  post(endpoint, body, options = {}) {
    const payload =
      body instanceof FormData || typeof body === 'string' || body == null ? body : JSON.stringify(body)
    return this.fetch(endpoint, { ...options, method: 'POST', body: payload })
  }

  put(endpoint, body, options = {}) {
    const payload =
      body instanceof FormData || typeof body === 'string' || body == null ? body : JSON.stringify(body)
    return this.fetch(endpoint, { ...options, method: 'PUT', body: payload })
  }

  patch(endpoint, body, options = {}) {
    const payload =
      body instanceof FormData || typeof body === 'string' || body == null ? body : JSON.stringify(body)
    return this.fetch(endpoint, { ...options, method: 'PATCH', body: payload })
  }

  async fetch(endpoint, options = {}) {
    const { _isRetry } = options || {};
    const method = String((options || {}).method || 'GET').toUpperCase();

    // Deduplicate identical in-flight GET requests to avoid redundant network calls
    if (method === 'GET' && !_isRetry) {
      const inflightKey = `${this.baseUrl}${endpoint}`;
      if (this._inflightRequests.has(inflightKey)) {
        return this._inflightRequests.get(inflightKey);
      }
      const promise = this._doFetch(endpoint, options).finally(() => {
        this._inflightRequests.delete(inflightKey);
      });
      this._inflightRequests.set(inflightKey, promise);
      return promise;
    }

    return this._doFetch(endpoint, options);
  }

  async _doFetch(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const token = this.getToken();
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const responseType = options?.responseType || null; // 'blob' | 'arrayBuffer' | 'response'

    // Strip internal retry flags so we don't pass unknown keys to `fetch()`.
    const {
      _isRetry: _internalIsRetry,
      _noCacheRetry: _internalNoCacheRetry,
      ...requestOptions
    } = options || {};
    
    // Track if this is a retry attempt to prevent infinite loops
    const isRetry = _internalIsRetry || false;
    const noCacheRetry = _internalNoCacheRetry || false;
    const requestId = this.getRequestId();
    const method = String(requestOptions.method || 'GET').toUpperCase();

    const headers = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...requestOptions.headers,
    };

    if (isFormData) {
      delete headers['Content-Type'];
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const activeProfileId = this.getActiveProfileId?.()
    if (activeProfileId) {
      headers['X-Profile-Id'] = headers['X-Profile-Id'] || activeProfileId
    }

    headers['X-Request-Id'] = headers['X-Request-Id'] || requestId;

    // Add timeout to prevent hanging requests (60s for heavy list endpoints)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const requestInit = {
        ...requestOptions,
        headers,
        credentials: 'include', // Ensure cookies are sent with the request
        signal: controller.signal,
      };

      // Avoid browser HTTP caching/ETag revalidation (which can return 304 with an empty body).
      // This is especially important for polled status endpoints in the Admin UI.
      if (!('cache' in requestOptions) && method === 'GET') {
        requestInit.cache = 'no-store';
      }

      let response = await fetch(url, requestInit);

      // Some proxies/browsers may still revalidate and return 304. Retry once with explicit no-store.
      if (response.status === 304 && !noCacheRetry) {
        response = await fetch(url, {
          ...requestInit,
          cache: 'no-store',
          headers: {
            ...headers,
            'Cache-Control': 'no-cache',
          },
        });
      }
      
      clearTimeout(timeoutId);

      if (response.status === 401) {
        // IMPORTANT:
        // Most auth endpoints should NOT trigger refresh/reauth logic (we want to surface
        // specific backend payloads like invalid_credentials).
        //
        // EXCEPTION: `/api/auth/me` is the canonical "who am I" bootstrap and SHOULD
        // attempt refresh+retry when the access token expires.
        if (endpoint.startsWith('/api/auth/') && !endpoint.startsWith('/api/auth/me')) {
          const errorBody = await response.json().catch(() => ({ error: response.statusText }))
          const message =
            typeof errorBody?.message === 'string' && errorBody.message.trim()
              ? errorBody.message.trim()
              : typeof errorBody?.error === 'string' && errorBody.error.trim()
                ? errorBody.error.trim()
                : 'Request failed'

          const err = new Error(message)
          err.status = response.status
          err.requestId = errorBody.request_id || headers['X-Request-Id'] || null
          err.errorCode = errorBody.error || null
          err.errorType = errorBody.error_type || null
          err.details = errorBody
          throw err
        }

        // Prevent infinite retry loops - only retry once
        if (isRetry) {
          console.error('[APIClient] Still getting 401 after refresh, giving up');
          this.clearToken();
          if (this.onAuthFailure) {
            this.onAuthFailure('Your session expired. Sign in again to continue.');
          }
          throw this.createAuthError('Authentication failed after retry');
        }
        
        // Mark the retry and handle unauthorized
        const retryOptions = { ...requestOptions, _isRetry: true };
        return this.handleUnauthorized({ endpoint, options: retryOptions });
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));

        // Consistent UX for backend-authoritative tier denials.
        if (response.status === 403 && errorBody?.error === 'Tier upgrade required') {
          try {
            if (typeof window !== 'undefined') {
              showToast({
                title: 'Tier upgrade required',
                description:
                  typeof errorBody?.message === 'string' && errorBody.message.trim()
                    ? errorBody.message
                    : 'Your current billing tier does not include this feature.',
              })
            }
          } catch {
            // Non-blocking: never fail a request due to toast rendering.
          }
        }

        const message =
          typeof errorBody?.message === 'string' && errorBody.message.trim()
            ? errorBody.message.trim()
            : typeof errorBody?.error === 'string' && errorBody.error.trim()
              ? errorBody.error.trim()
              : 'Request failed'

        const err = new Error(message);
        err.status = response.status;
        err.requestId = errorBody.request_id || headers['X-Request-Id'] || null;
        err.errorCode = errorBody.error || null;
        err.errorType = errorBody.error_type || null;
        err.details = errorBody;
        throw err;
      }

      if (response.status === 204) {
        return null;
      }

      // Binary/stream responses (e.g., authenticated downloads).
      if (responseType === 'response') {
        return response
      }
      if (responseType === 'blob') {
        return await response.blob()
      }
      if (responseType === 'arrayBuffer') {
        return await response.arrayBuffer()
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return response.json();
      }

      return response.text();
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Handle timeout errors specifically
      if (error.name === 'AbortError') {
        console.error(`[APIClient] Request timeout for ${endpoint}`);
        const timeoutErr = new Error('Request timed out. Please check your connection and try again.');
        timeoutErr.status = 504;
        timeoutErr.requestId = headers['X-Request-Id'] || null;
        throw timeoutErr;
      }

      // Browser/network transport failure (DNS/CORS/proxy/backend unreachable).
      // fetch() throws TypeError before an HTTP response exists, so this is not a
      // server 500 and should be surfaced distinctly to callers/UI.
      if (error instanceof TypeError && /failed to fetch/i.test(String(error.message || ''))) {
        const networkErr = new Error(
          'Network request failed before the server responded. Check backend availability, API URL/proxy, and CORS.',
        );
        networkErr.status = 0;
        networkErr.requestId = headers['X-Request-Id'] || null;
        networkErr.errorCode = 'NETWORK_FETCH_FAILED';
        networkErr.details = {
          endpoint,
          url,
          method,
          originalError: String(error.message || error),
        };
        throw networkErr;
      }
      
      // Re-throw other errors
      if (error && typeof error === 'object' && !error.requestId) {
        error.requestId = headers['X-Request-Id'] || null;
      }
      throw error;
    }
  }

  // Entity wrapper for CRUD interface
  createEntityClient(resource) {
    const normalizedResource = resource.replace(/^\/+/, '');
    const endpoint = normalizedResource.startsWith('api/')
      ? `/${normalizedResource}`
      : `/api/${normalizedResource}`;

    const buildUrl = (searchParams) => {
      const query = searchParams && [...searchParams].length > 0
        ? `?${searchParams.toString()}`
        : '';
      return `${endpoint}${query}`;
    };

    return {
      list: async (sortBy, limit, filters = {}) => {
        const params = new URLSearchParams();
        if (sortBy) {
          const order = sortBy.startsWith('-') ? 'desc' : 'asc';
          const rawField = sortBy.replace(/^-/, '');
          // Back-compat: some older code used *_date while our DB uses *_at.
          const field =
            rawField === 'created_date'
              ? 'created_at'
              : rawField === 'updated_date'
                ? 'updated_at'
                : rawField
          params.set('sort', field);
          params.set('order', order);
        }
        if (typeof limit === 'number') {
          params.set('limit', String(limit));
        }
        if (filters && typeof filters === 'object') {
          Object.entries(filters)
            .filter(([, value]) => value !== undefined && value !== null)
            .forEach(([key, value]) => params.set(key, value));
        }
        return this.fetch(buildUrl(params));
      },
      
      filter: async (filters = {}) => {
        const params = new URLSearchParams();
        Object.entries(filters)
          .filter(([, value]) => value !== undefined && value !== null)
          .forEach(([key, value]) => params.set(key, value));
        return this.fetch(buildUrl(params));
      },
      
      get: async (id) => {
        return this.fetch(`${endpoint}/${id}`);
      },
      
      create: async (data) => {
        return this.fetch(endpoint, {
          method: 'POST',
          body: JSON.stringify(data),
        });
      },
      
      update: async (id, data) => {
        return this.fetch(`${endpoint}/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        });
      },
      
      delete: async (id) => {
        return this.fetch(`${endpoint}/${id}`, {
          method: 'DELETE',
        });
      },

      bulkCreate: async (items = []) => {
        if (!Array.isArray(items) || items.length === 0) {
          return [];
        }
        return Promise.all(
          items.map((item) =>
            this.fetch(endpoint, {
              method: 'POST',
              body: JSON.stringify(item),
            }),
          ),
        );
      },
    };
  }

  createStubEntityClient(entityName) {
    if (!this.stubStores.has(entityName)) {
      this.stubStores.set(entityName, new Map());
    }
    const store = this.stubStores.get(entityName);

    const generateId = () => {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      return `${entityName.toLowerCase()}_${Math.random().toString(36).slice(2, 10)}`;
    };

    const listRecords = () => Array.from(store.values());

    const upsertRecord = (data = {}) => {
      const id = data.id ?? generateId();
      const record = { ...data, id };
      store.set(id, record);
      return record;
    };

    const applyFilters = (records, filters = {}) => {
      const entries = Object.entries(filters || {}).filter(
        ([, value]) => value !== undefined && value !== null,
      );
      if (entries.length === 0) return records;
      return records.filter((record) =>
        entries.every(([key, value]) => {
          if (Array.isArray(value)) {
            return value.includes(record[key]);
          }
          return `${record[key]}` === `${value}`;
        }),
      );
    };

    return {
      list: async () => listRecords(),
      filter: async (filters = {}) => applyFilters(listRecords(), filters),
      get: async (id) => store.get(id) ?? null,
      create: async (data) => upsertRecord(data),
      update: async (id, data = {}) => {
        const existing = store.get(id) ?? { id };
        const updated = { ...existing, ...data, id };
        store.set(id, updated);
        return updated;
      },
      delete: async (id) => {
        const existing = store.get(id) ?? null;
        store.delete(id);
        return existing ?? { id, deleted: Boolean(existing) };
      },
      bulkCreate: async (items = []) => items.map((item) => upsertRecord(item)),
    };
  }

  // Auth methods
  auth = {
    me: async () => {
      const token = this.getToken();
      if (!token) return null;

      try {
        // Proactive refresh:
        // If we have a refresh token and the stored access expiry is near/over due,
        // refresh before calling `/api/auth/me` so we avoid noisy 401s.
        // Uses raw fetch() to avoid triggering the wrapper's own 401 → handleUnauthorized loop.
        try {
          if (typeof window !== 'undefined') {
            const refreshToken = this.getRefreshToken?.()
            const expiryRaw = window.localStorage.getItem('grantflow:access-expiry')
            const expiryMs = expiryRaw ? Number(expiryRaw) : NaN
            const leewayMs = 60 * 1000
            if (refreshToken && (!Number.isFinite(expiryMs) || expiryMs <= Date.now() + leewayMs)) {
              const resp = await fetch(`${this.baseUrl}/api/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ refreshToken }),
              })
              if (resp.ok) {
                const data = await resp.json()
                if (data?.accessToken) this.setToken(data.accessToken)
                if (data?.refreshToken) this.setRefreshToken(data.refreshToken)
              } else {
                // Refresh token is dead — clear it so handleUnauthorized won't retry
                log.debug('proactive refresh failed; clearing refresh token')
                this.refreshToken = null
                if (typeof window !== 'undefined') {
                  localStorage.removeItem('grantflow:refresh-token')
                }
              }
            }
          }
        } catch {
          // Network/parse error — best-effort, fall through to /api/auth/me
        }

        return await this.fetch('/api/auth/me');
      } catch (error) {
        // If it's an auth error (401 or session expired), return null gracefully
        if (error.status === 401 || error.status === 403 || error.isAuthError) {
          log.debug('auth check failed; user needs to sign in')
          this.clearToken();
          return null;
        }
        // For other errors, log but return null to avoid breaking the app
        console.warn('[APIClient] Error checking auth status:', error.message);
        return null;
      }
    },
    
    loginWithTokens: async ({ accessToken, refreshToken }) => {
      if (accessToken) {
        this.setToken(accessToken);
      }
      if (refreshToken) {
        this.setRefreshToken(refreshToken);
      }
      return this.auth.me();
    },
    
    logout: () => {
      this.clearToken();
      this.fetch('/api/auth/logout', { method: 'POST' }).catch(() => {
        // Non-blocking — best-effort server notification; ignore errors.
      });
      if (typeof window !== 'undefined') {
        const base = (env.appBase || '').replace(/\/$/, '');
        window.location.href = `${base}/login`;
      }
    },
    
    redirectToLogin: () => {
      if (typeof window !== 'undefined') {
        const base = (env.appBase || '').replace(/\/$/, '');
        window.location.href = `${base}/login`;
      }
    }
  };

  // Functions wrapper
  functions = {
    invoke: async (functionName, payload = {}) => {
      return this.fetch(`/api/${functionName}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
  };

  // Integrations wrapper
  integrations = {
    Core: {
      InvokeLLM: async (payload = {}) => {
        return this.fetch('/api/ai/invoke', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      },

      UploadFile: async ({ file, ...metadata } = {}) => {
        if (!file) {
          throw new Error('UploadFile requires a file parameter');
        }

        const formData = new FormData();
        formData.append('file', file);

        Object.entries(metadata || {}).forEach(([key, value]) => {
          if (value === undefined || value === null) return;
          formData.append(key, value);
        });

        return this.fetch('/api/documents/upload', {
          method: 'POST',
          body: formData,
        });
      },

      CreateFileSignedUrl: async ({ file_uri }) => {
        if (!file_uri) {
          throw new Error('CreateFileSignedUrl requires file_uri parameter');
        }

        return this.fetch('/api/documents/signed-url', {
          method: 'POST',
          body: JSON.stringify({ file_uri }),
        });
      },
    },
  };

  // Initialize entity clients
  init() {
    const target = {};
    this.entities = new Proxy(target, {
      get: (obj, prop) => {
        if (typeof prop !== 'string') {
          return Reflect.get(obj, prop);
        }

        if (!obj[prop]) {
          const resource = this.entityResourceMap[prop];
          obj[prop] = resource
            ? this.createEntityClient(resource)
            : this.createStubEntityClient(prop);

          if (!resource && !this.stubWarnings.has(prop) && this.isDev && typeof console !== 'undefined') {
            // Keep dev noise low (avoid surfacing as "errors" in some console collectors)
            console.info(
              `[APIClient] Using in-memory stub for entity "${prop}". API endpoint not configured.`,
            );
            this.stubWarnings.add(prop);
          }
        }

        return obj[prop];
      },
      has: (obj, prop) => Reflect.has(obj, prop) || prop in this.entityResourceMap,
    });
  }

  profileSectionsClient(profileId) {
    const base = `/api/profiles/${profileId}/sections`;
    return {
      list: async () => this.fetch(base),
      get: async (sectionKey) => this.fetch(`${base}/${sectionKey}`),
      update: async (sectionKey, data, updatedBy) =>
        this.fetch(`${base}/${sectionKey}`, {
          method: 'PUT',
          body: JSON.stringify({ data, updated_by: updatedBy ?? null }),
        }),
      delete: async (sectionKey) =>
        this.fetch(`${base}/${sectionKey}`, {
          method: 'DELETE',
        }),
    };
  }
}

// Create singleton instance
const client = new APIClient();
client.init();

// Also export individual pieces
export const {
  Organization,
  Grant,
  FundingOpportunity,
  Milestone,
  Document,
  Expense,
  Budget,
  Contact,
  CrawlLog,
  ApplicationDraft,
  Profile,
} = client.entities;

export const getProfileSectionsClient = (profileId) => client.profileSectionsClient(profileId);
export const apiFetch = (...args) => client.fetch(...args);

export default client;