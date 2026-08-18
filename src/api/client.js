import { env, getApiBasePrefixForFetch } from '@/config/env.js'
import { createLogger } from '@/utils/logger'
import { toast as showToast } from '@/components/ui/use-toast'
import { assertRealProfileId, isRealProfileId, resolveProfileIdForApi } from './profileIdGuards'

// API Client

// Use relative URLs in production (proxied by Vercel) to avoid CORS issues.
// When the app is served under a base path (e.g. /grantflow), API requests must
// use that prefix so rewrites like /grantflow/api/:path* reach the backend.
// getApiBasePrefixForFetch() re-applies axiombiolabs same-origin rules (never Railway cross-origin).
const API_URL = getApiBasePrefixForFetch()

// Frontend startup sanity (non-fatal): warn on env drift / misconfiguration.
if (import.meta.env.DEV) {
  const raw = import.meta.env.VITE_API_URL
  if (raw && !/^https?:\/\//i.test(String(raw))) {
    console.warn('[env] VITE_API_URL should be http(s)://...; falling back to same-origin proxy. value=', raw)
  }
  if (!raw && API_URL && API_URL !== '') {
    console.warn(
      '[env] API_URL resolved from appBase as a path prefix:',
      API_URL,
      '— ensure Vercel rewrites map',
      API_URL + '/api/:path*',
      'to the backend, otherwise all API calls will 404 silently.',
    )
  }
  if (!raw && API_URL === '') {
    console.info('[env] API_URL is empty string — using same-origin proxy (relative URLs). Ensure the proxy is configured.')
  }
}

const log = createLogger('APIClient')

class APIClient {
  constructor() {
    this.baseUrl = API_URL;
    this.token = null;
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.__GF_SMOKE__ === true &&
      typeof globalThis.__GRANTFLOW_SMOKE_ACCESS_TOKEN__ === 'string'
    ) {
      this.token = globalThis.__GRANTFLOW_SMOKE_ACCESS_TOKEN__
      try { delete globalThis.__GRANTFLOW_SMOKE_ACCESS_TOKEN__ } catch { /* ignore */ }
    }
    this.activeProfileId = null;
    this.refreshPromise = null;
    this.onAuthFailure = null;
    this._suppressAuthFailureCount = 0;
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
      ChecklistItem: 'checklist-items',
      GrantAward: 'grant-awards',
      ComplianceReport: 'compliance-reports',
      Invoice: 'billing-settings/invoices',
      InvoiceLine: 'billing-settings/invoice-lines',
      Project: 'billing-settings/projects',
      TimeEntry: 'billing-settings/time-entries',
      TimeLog: 'billing-settings/time-logs',
      BillingAccount: 'billing-settings',
      AiArtifact: 'billing-settings/ai-artifacts',
      PartnerSource: 'billing-settings/partner-sources',
      SearchJob: 'billing-settings/search-jobs',
      Taxonomy: 'billing-settings/taxonomy',
    };
    this.stubStores = new Map();
    this.stubWarnings = new Set();
    this.isDev = import.meta.env?.DEV ?? false;
    this.entities = {};
    this._inflightRequests = new Map();

    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('grantflow:active-profile-id')
      this.activeProfileId = stored && String(stored).trim() ? String(stored).trim() : null

      try {
        if (typeof BroadcastChannel !== 'undefined') {
          this._authChannel = new BroadcastChannel('grantflow:auth')
          this._authChannel.addEventListener('message', (event) => {
            if (event?.data?.type !== 'logout') return
            this._handlingPeerLogout = true
            try {
              this.clearToken({ broadcast: false })
              if (this.onAuthFailure && !this._suppressAuthFailureCount) {
                this.onAuthFailure('You signed out in another tab.')
              }
            } finally {
              this._handlingPeerLogout = false
            }
          })
        }
      } catch {
        this._authChannel = null
      }
    }
  }

  getRequestId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (error) {
      log.warn('crypto.randomUUID failed; using fallback request id', error?.message || error);
    }
    return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  setAuthFailureHandler(handler) {
    this.onAuthFailure = handler;
  }

  setToken(token) {
    this.token = token || null;
  }

  setRefreshToken(_token) {
    this._clearLegacyTokenStorage()
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
    const stored = this.activeProfileId
      || (typeof window !== 'undefined' ? localStorage.getItem('grantflow:active-profile-id') : null)
    return isRealProfileId(stored) ? String(stored).trim() : null
  }

  resolveRequestProfileId(explicitId) {
    return resolveProfileIdForApi(explicitId, this.getActiveProfileId())
  }

  getToken() {
    return this.token;
  }

  getRefreshToken() {
    return null;
  }

  _clearLegacyTokenStorage() {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem('grantflow:access-token')
      window.localStorage.removeItem('grantflow:refresh-token')
    } catch {
      // Storage may be unavailable in private mode.
    }
  }

  clearToken({ broadcast = true } = {}) {
    this.token = null;
    this.refreshPromise = null;
    this.activeProfileId = null;
    this._clearLegacyTokenStorage()
    if (typeof window !== 'undefined') {
      localStorage.removeItem('grantflow:active-profile-id');
    }
    if (broadcast && !this._handlingPeerLogout) {
      try { this._authChannel?.postMessage({ type: 'logout' }) } catch { /* ignore */ }
    }
  }

  createAuthError(message) {
    const error = new Error(message);
    error.status = 401;
    return error;
  }

  async handleUnauthorized(originalRequest) {
    if (originalRequest?.endpoint?.startsWith('/api/auth/refresh')) {
      console.warn('[APIClient] Refresh endpoint failed, clearing auth state');
      this.clearToken();
      if (this.onAuthFailure && !this._suppressAuthFailureCount) {
        this.onAuthFailure('Your session is no longer valid. Please sign in again.');
      }
      throw this.createAuthError('Session expired');
    }

    const retryMethod = String(originalRequest?.options?.method || 'GET').toUpperCase();
    const isIdempotent = retryMethod === 'GET' || retryMethod === 'HEAD';
    if (!isIdempotent) {
      log.debug('skipping auto-retry for non-idempotent method after 401:', retryMethod)
      try {
        await this.refreshTokens()
      } catch (error) {
        console.warn('[APIClient] Token refresh failed:', error.message)
      }
      const authError = this.createAuthError('Your session expired during a non-idempotent request. Please retry.')
      authError.isAuthError = true
      throw authError
    }

    log.debug('starting token refresh via refreshTokens()')
    try {
      await this.refreshTokens()
    } catch (error) {
      console.warn('[APIClient] Token refresh failed:', error.message)
      const authError = this.createAuthError('Your session has expired. Please sign in again.')
      authError.isAuthError = true
      throw authError
    }

    log.debug('retrying original request after refresh')
    return this.fetch(originalRequest.endpoint, originalRequest.options);
  }

  async refreshTokens() {
    if (this.refreshPromise) {
      log.debug('refreshTokens: reusing in-flight refresh promise')
      return this.refreshPromise
    }

    log.debug('refreshTokens: starting new refresh')
    this.refreshPromise = this._runRefresh().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  async _runRefresh() {
    const run = () => this._refreshTokenNetwork()
    try {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('grantflow:auth-refresh', run)
      }
    } catch (error) {
      log.debug('web lock refresh unavailable; running unlocked', error?.message)
    }
    return run()
  }

  async _refreshTokenNetwork({ retryOnConflict = true } = {}) {
    const response = await fetch(`${this.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include',
      body: '{}',
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
      if (response.status === 409 && errorData?.retryable && retryOnConflict) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return this._refreshTokenNetwork({ retryOnConflict: false })
      }
      if (response.status === 401) {
        this.clearToken()
      }
      const error = new Error(errorData.error || `Refresh failed with status ${response.status}`)
      error.status = response.status
      error.errorCode = errorData.error || null
      error.retryable = Boolean(errorData.retryable)
      throw error
    }

    const data = await response.json()
    if (data?.accessToken) this.setToken(data.accessToken)
    return data
  }

  get(endpoint, options = {}) {
    return this.fetch(endpoint, { ...options, method: 'GET' })
  }

  delete(endpoint, options = {}) {
    return this.fetch(endpoint, { ...options, method: 'DELETE' })
  }

  post(endpoint, body, options = {}) {
    const payload =
      body instanceof FormData || typeof body === 'string' || body === null ? body : JSON.stringify(body)
    return this.fetch(endpoint, { ...options, method: 'POST', body: payload })
  }

  put(endpoint, body, options = {}) {
    const payload =
      body instanceof FormData || typeof body === 'string' || body === null ? body : JSON.stringify(body)
    return this.fetch(endpoint, { ...options, method: 'PUT', body: payload })
  }

  patch(endpoint, body, options = {}) {
    const payload =
      body instanceof FormData || typeof body === 'string' || body === null ? body : JSON.stringify(body)
    return this.fetch(endpoint, { ...options, method: 'PATCH', body: payload })
  }

  async fetch(endpoint, options = {}) {
    const { _isRetry } = options || {};
    const method = String((options || {}).method || 'GET').toUpperCase();

    if (method === 'GET' && !_isRetry) {
      const opts = options || {};
      const profileId =
        this.resolveRequestProfileId(
          opts.headers?.['X-Profile-Id'] || opts.profileId || opts.profile_id,
        ) || '';
      const responseType = opts.responseType || '';
      const cacheMode = opts.cache || '';
      const hasAuth = this.getToken() ? '1' : '0';
      let headerKey = '';
      try {
        headerKey = opts.headers ? JSON.stringify(opts.headers) : '';
      } catch {
        headerKey = '';
      }
      const inflightKey = [
        this.baseUrl + endpoint,
        profileId,
        responseType,
        cacheMode,
        hasAuth,
        headerKey,
      ].join('||');

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
    const responseType = options?.responseType || null;

    const {
      _isRetry: _internalIsRetry,
      _noCacheRetry: _internalNoCacheRetry,
      _gatewayRetried: _internalGatewayRetried,
      ...requestOptions
    } = options || {};

    const isRetry = _internalIsRetry || false;
    const noCacheRetry = _internalNoCacheRetry || false;
    const gatewayRetried = _internalGatewayRetried || false;
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

    const activeProfileId = this.resolveRequestProfileId(
      headers['X-Profile-Id'] || requestOptions.profileId || requestOptions.profile_id
    )
    if (activeProfileId) {
      headers['X-Profile-Id'] = activeProfileId
    } else {
      delete headers['X-Profile-Id']
    }

    headers['X-Request-Id'] = headers['X-Request-Id'] || requestId;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const requestInit = {
        ...requestOptions,
        headers,
        credentials: 'include',
        signal: controller.signal,
      };

      if (!('cache' in requestOptions) && method === 'GET') {
        requestInit.cache = 'no-store';
      }

      let response = await fetch(url, requestInit);

      if (response.status === 304 && !noCacheRetry) {
        const retryController = new AbortController();
        const retryTimeoutId = setTimeout(() => retryController.abort(), 60000);
        try {
          response = await fetch(url, {
            ...requestInit,
            cache: 'no-store',
            signal: retryController.signal,
            headers: {
              ...headers,
              'Cache-Control': 'no-cache',
            },
          });
        } finally {
          clearTimeout(retryTimeoutId);
        }
      }
      
      clearTimeout(timeoutId);

      const isIdempotentMethod =
        method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE';
      if (
        (response.status === 502 || response.status === 503 || response.status === 504) &&
        isIdempotentMethod &&
        !gatewayRetried
      ) {
        log.debug(`transient ${response.status} on ${endpoint}; retrying once after backoff`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return this._doFetch(endpoint, { ...options, _gatewayRetried: true });
      }

      if (response.status === 401) {
        if (endpoint.startsWith('/api/auth/') && !endpoint.startsWith('/api/auth/me') && endpoint !== '/api/auth/logout') {
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
          err.errorCode =
            errorBody.error_code
            || (typeof errorBody.error === 'string' && !/\s/.test(errorBody.error) ? errorBody.error : null)
          err.errorType = errorBody.error_type || null
          err.details = errorBody
          throw err
        }

        if (isRetry) {
          console.warn('[APIClient] Still getting 401 after refresh, giving up');
          this.clearToken();
          if (this.onAuthFailure && !this._suppressAuthFailureCount) {
            this.onAuthFailure('Your session expired. Sign in again to continue.');
          }
          throw this.createAuthError('Authentication failed after retry');
        }
        
        const retryOptions = { ...options, _isRetry: true };
        return this.handleUnauthorized({ endpoint, options: retryOptions });
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));

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
            // Non-blocking.
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
        err.errorCode =
          errorBody.error_code
          || (typeof errorBody.error === 'string' && !/\s/.test(errorBody.error) ? errorBody.error : null);
        err.errorType = errorBody.error_type || null;
        err.details = errorBody;
        throw err;
      }

      if (response.status === 204) {
        return null;
      }

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
      if (error.name === 'AbortError') {
        console.error(`[APIClient] Request timeout for ${endpoint}`);
        const timeoutErr = new Error('Request timed out. Please check your connection and try again.');
        timeoutErr.status = 504;
        timeoutErr.requestId = headers['X-Request-Id'] || null;
        throw timeoutErr;
      }

      if (error instanceof TypeError && /failed to fetch/i.test(String(error.message || ''))) {
        const canRetryMethod = method === 'GET' || method === 'HEAD';
        if (canRetryMethod && !gatewayRetried) {
          log.debug(`transport failure on ${endpoint}; retrying once after backoff`);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return this._doFetch(endpoint, { ...options, _gatewayRetried: true });
        }
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
      
      if (error && typeof error === 'object' && !error.requestId) {
        error.requestId = headers['X-Request-Id'] || null;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  createEntityClient(resource) {
    const normalizedResource = resource.replace(/^\/+/, '');
    const endpoint = normalizedResource.startsWith('api/')
      ? `/${normalizedResource}`
      : `/api/${normalizedResource}`;

    const buildUrl = (searchParams) => {
      const queryString = searchParams ? searchParams.toString() : '';
      const query = queryString.length > 0 ? `?${queryString}` : '';
      return `${endpoint}${query}`;
    };

    const appendFilterValue = (params, key, value) => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) {
        value
          .filter((v) => v !== undefined && v !== null && v !== '')
          .forEach((v) => {
            if (typeof v === 'object') {
              params.append(key, JSON.stringify(v));
            } else {
              params.append(key, String(v));
            }
          });
        return;
      }
      if (typeof value === 'object') {
        params.append(key, JSON.stringify(value));
        return;
      }
      params.set(key, String(value));
    };

    return {
      list: async (sortBy, limit, filters = {}) => {
        if (sortBy && typeof sortBy === 'object' && !Array.isArray(sortBy)) {
          filters = sortBy;
          sortBy = undefined;
          if (typeof limit !== 'number') limit = undefined;
        }
        const params = new URLSearchParams();
        if (sortBy) {
          const order = sortBy.startsWith('-') ? 'desc' : 'asc';
          const rawField = sortBy.replace(/^-/, '');
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
          Object.entries(filters).forEach(([key, value]) => appendFilterValue(params, key, value));
        }
        return this.fetch(buildUrl(params));
      },
      
      filter: async (filters = {}) => {
        const params = new URLSearchParams();
        Object.entries(filters).forEach(([key, value]) => appendFilterValue(params, key, value));
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
        const results = await Promise.allSettled(
          items.map((item) =>
            this.fetch(endpoint, {
              method: 'POST',
              body: JSON.stringify(item),
            }),
          ),
        );
        const failures = results.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
          log.warn(
            `[APIClient] bulkCreate: ${failures.length}/${items.length} items failed`,
            failures.map((f) => f.reason?.message),
          );
        }
        return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
      },
    };
  }

  createStubEntityClient(entityName) {
    if (!this.stubStores.has(entityName)) {
      this.stubStores.set(entityName, new Map());
    }
    const store = this.stubStores.get(entityName);

    const generateId = () => {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
          return crypto.randomUUID();
        }
      } catch (error) {
        log.warn('crypto.randomUUID failed in stub generateId; using fallback', error?.message || error);
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

  auth = {
    me: async () => {
      if (!this.getToken()) {
        try {
          await this.refreshTokens()
        } catch {
          return null
        }
      }

      try {
        this._suppressAuthFailureCount++
        try {
          return await this.fetch('/api/auth/me');
        } finally {
          this._suppressAuthFailureCount--
        }
      } catch (error) {
        if (error.status === 401 || error.status === 403 || error.isAuthError) {
          log.debug('auth check failed; user needs to sign in')
          this.clearToken();
          return null;
        }
        if (
          error.status === 0 ||
          error.name === 'AbortError' ||
          error.errorCode === 'NETWORK_FETCH_FAILED' ||
          (error instanceof TypeError && /failed to fetch/i.test(String(error.message || '')))
        ) {
          console.warn('[APIClient] Network error checking auth status (server may be starting):', error.message);
          return null;
        }
        console.error('[APIClient] Unexpected error during auth.me():', {
          status: error?.status,
          requestId: error?.requestId,
          message: error?.message,
        });
        throw error;
      }
    },
    
    loginWithTokens: async ({ accessToken } = {}) => {
      if (accessToken) {
        this.setToken(accessToken);
      }
      return this.auth.me();
    },
    
    logout: () => {
      this.fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: '{}',
      })
        .catch(() => {})
        .finally(() => {
          this.clearToken();
        });
      this.token = null;
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

  functions = {
    invoke: async (functionName, payload = {}) => {
      return this.fetch(`/api/${functionName}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
  };

  integrations = {
    Core: {
      InvokeLLM: async (payload = {}) => {
        const profileId = this.resolveRequestProfileId(payload.profile_id ?? payload.profileId)
        const body = profileId
          ? { ...payload, profile_id: profileId }
          : payload
        return this.fetch('/api/ai/invoke', {
          method: 'POST',
          body: JSON.stringify(body),
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
          if (value instanceof Blob || value instanceof File) {
            formData.append(key, value);
          } else if (typeof value === 'object') {
            formData.append(key, JSON.stringify(value));
          } else {
            formData.append(key, String(value));
          }
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
    assertRealProfileId(profileId, 'profileSectionsClient');
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

const client = new APIClient();
client.init();

export const getOrganization = () => client.entities.Organization;
export const getGrant = () => client.entities.Grant;
export const getFundingOpportunity = () => client.entities.FundingOpportunity;
export const getMilestone = () => client.entities.Milestone;
export const getDocument = () => client.entities.Document;
export const getExpense = () => client.entities.Expense;
export const getBudget = () => client.entities.Budget;
export const getContact = () => client.entities.Contact;
export const getCrawlLog = () => client.entities.CrawlLog;
export const getApplicationDraft = () => client.entities.ApplicationDraft;
export const getProfile = () => client.entities.Profile;

export const Organization = client.entities.Organization;
export const Grant = client.entities.Grant;
export const FundingOpportunity = client.entities.FundingOpportunity;
export const Milestone = client.entities.Milestone;
export const Document = client.entities.Document;
export const Expense = client.entities.Expense;
export const Budget = client.entities.Budget;
export const Contact = client.entities.Contact;
export const CrawlLog = client.entities.CrawlLog;
export const ApplicationDraft = client.entities.ApplicationDraft;
export const Profile = client.entities.Profile;

export const getProfileSectionsClient = (profileId) => client.profileSectionsClient(profileId);
export const apiFetch = (...args) => client.fetch(...args);

export default client;
