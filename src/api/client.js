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
    // Browser smoke harnesses may inject a per-document bearer token directly
    // into memory. It is accepted only alongside the explicit smoke marker and
    // deleted immediately; production sessions never use this path.
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.__GF_SMOKE__ === true &&
      typeof globalThis.__GRANTFLOW_SMOKE_ACCESS_TOKEN__ === 'string'
    ) {
      this.token = globalThis.__GRANTFLOW_SMOKE_ACCESS_TOKEN__
      try { delete globalThis.__GRANTFLOW_SMOKE_ACCESS_TOKEN__ } catch { /* ignore */ }
    }
    this.activeProfileId = null;
    this.refreshPromise = null; // Single-flight refresh promise
    this.onAuthFailure = null;
    // Counter tracking how many concurrent auth.me() calls are in flight.
    // When > 0, onAuthFailure callbacks are suppressed to prevent markSessionExpired()
    // from firing during bootstrap. Using a counter (not a boolean) makes this safe
    // for concurrent invocations — the flag is only cleared when all callers finish.
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

      // Access tokens stay process-memory-only. BroadcastChannel carries only a
      // logout signal (never credentials) so logging out in one tab immediately
      // clears authenticated state in the others. Refresh-cookie rotation itself
      // is serialized by Web Locks below.
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
      // crypto.randomUUID failed (e.g. insecure context); log and use fallback.
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

  // Refresh credentials are owned by the server-issued HttpOnly cookie and are
  // intentionally unavailable to JavaScript. Retain this no-op compatibility
  // method temporarily so older call sites fail closed while rolling forward.
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

  /** Real profile id for tier-gated API calls (never the __admin__ sentinel). */
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
      // Storage may be unavailable in private mode. Tokens are never read from it.
    }
  }

  clearToken({ broadcast = true } = {}) {
    this.token = null;
    this.refreshPromise = null; // Clear any pending refresh
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
    // If the original request was to /refresh, don't try again - just fail
    if (originalRequest?.endpoint?.includes('/auth/refresh')) {
      console.warn('[APIClient] Refresh endpoint failed, clearing auth state');
      this.clearToken();
      if (this.onAuthFailure && !this._suppressAuthFailureCount) {
        this.onAuthFailure('Your session is no longer valid. Please sign in again.');
      }
      throw this.createAuthError('Session expired');
    }

    // Only auto-refresh-and-retry idempotent requests. Re-sending a POST/PUT/PATCH
    // after refresh risks duplicate side effects (e.g. duplicate creates) and may
    // re-use an already-consumed FormData body. Surface the auth error instead and
    // let the caller decide whether/how to retry.
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

    // Delegate to the shared single-flight refreshTokens() so all callers
    // (handleUnauthorized, authStore timer, proactive refresh) share one promise.
    log.debug('starting token refresh via refreshTokens()')
    try {
      await this.refreshTokens()
    } catch (error) {
      console.warn('[APIClient] Token refresh failed:', error.message)
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
   * @returns {Promise<{accessToken: string}>} The new access token and expiry metadata.
   */
  async refreshTokens() {
    // Reuse any in-flight refresh so concurrent callers in THIS window share one
    // rotation (single-flight). Cross-WINDOW serialization is handled separately
    // via the Web Locks API inside _runRefresh().
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

  // Serialize refreshes ACROSS same-origin windows/tabs. The refresh token is
  // single-use (the server rotates refresh_token_hash on every call), so two
  // windows refreshing at once — the app tab and the Hamilton live-login popup,
  // each with its OWN APIClient instance — must not send the same cookie at once.
  // navigator.locks serializes those rotations. The server also uses a compare-
  // and-swap and a brief 409 retry window for browsers without Web Locks.
  async _runRefresh() {
    const run = () => this._refreshTokenNetwork()
    try {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('grantflow:auth-refresh', run)
      }
    } catch (error) {
      // Web Locks unavailable or the request was rejected — fall back to an
      // unlocked refresh. The backend CAS/409 contract remains the safety net.
      log.debug('web lock refresh unavailable; running unlocked', error?.message)
    }
    return run()
  }

  async _refreshTokenNetwork({ retryOnConflict = true } = {}) {
    const response = await fetch(`${this.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Hint for server-side CSRF protections that this is a same-origin
        // programmatic request (not a cross-site form post).
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
        // A genuine dead refresh token: clear so the app routes to sign-in. Do
        // NOT call onAuthFailure here — callers (handleUnauthorized) already do
        // when appropriate; firing it twice thrashes markSessionExpired().
        this.clearToken()
      }
      // Non-401 (network blip / 5xx): DON'T clear — a transient failure must not
      // log the user out. The caller surfaces the error and may retry.
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

    // Deduplicate identical in-flight GET requests to avoid redundant network calls.
    // The dedup key must include request-distinguishing options so that requests
    // differing by profile, auth presence, response type or custom headers are
    // never collapsed into one shared promise (which could leak a JSON body to a
    // blob caller or another profile's data).
    if (method === 'GET' && !_isRetry) {
      const opts = options || {};
      const profileId =
        this.resolveRequestProfileId(
          opts.headers?.['X-Profile-Id'] || opts.profileId || opts.profile_id,
        ) || '';
      const responseType = opts.responseType || '';
      const cacheMode = opts.cache || '';
      const hasAuth = this.getToken() ? '1' : '0';
      // Serialize any custom headers so differing headers don't share a promise.
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
    const responseType = options?.responseType || null; // 'blob' | 'arrayBuffer' | 'response'

    // Strip internal retry flags so we don't pass unknown keys to `fetch()`.
    const {
      _isRetry: _internalIsRetry,
      _noCacheRetry: _internalNoCacheRetry,
      _gatewayRetried: _internalGatewayRetried,
      ...requestOptions
    } = options || {};

    // Track if this is a retry attempt to prevent infinite loops
    const isRetry = _internalIsRetry || false;
    const noCacheRetry = _internalNoCacheRetry || false;
    // Whether we've already retried this request through a transient
    // gateway/restart blip (502/503/504 or a dropped connection). One retry only.
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
      // Use a FRESH AbortController/timeout — the original controller may already be
      // aborted (or its timer about to fire), which would cause the retry fetch to
      // immediately reject with AbortError.
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

      // Transient gateway / restart blips: Railway returns 502/503/504 while the
      // backend container is briefly unavailable (e.g. a deploy or an OOM
      // restart). For safe, idempotent reads, ride through a short blip with ONE
      // backoff retry instead of surfacing a scary error to the UI (which would
      // otherwise cascade into "heartbeat stale" / spurious auth failures during
      // the few seconds the server is coming back up).
      // PUT and DELETE are idempotent by HTTP semantics (same request → same
      // end state), so replaying one through a blip is as safe as replaying a
      // GET. POST/PATCH stay excluded — replaying those risks duplicates.
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
          // Prefer an explicit machine code field; fall back to `error` only when it
          // looks like a stable code (no spaces) rather than human-readable prose.
          err.errorCode =
            errorBody.error_code
            || (typeof errorBody.error === 'string' && !/\s/.test(errorBody.error) ? errorBody.error : null)
          err.errorType = errorBody.error_type || null
          err.details = errorBody
          throw err
        }

        // Prevent infinite retry loops - only retry once
        if (isRetry) {
          console.warn('[APIClient] Still getting 401 after refresh, giving up');
          this.clearToken();
          if (this.onAuthFailure && !this._suppressAuthFailureCount) {
            this.onAuthFailure('Your session expired. Sign in again to continue.');
          }
          throw this.createAuthError('Authentication failed after retry');
        }
        
        // Mark the retry and handle unauthorized.
        // Pass _isRetry through the original options so handleUnauthorized's
        // re-invocation of this.fetch() still carries the guard flag.
        const retryOptions = { ...options, _isRetry: true };
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
        // Prefer an explicit machine code field; fall back to `error` only when it
        // looks like a stable code (no spaces) rather than human-readable prose.
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
        // A backend restart can drop an in-flight connection: for safe idempotent
        // reads, retry once after a short backoff before treating the server as
        // truly unreachable — this rides through restart blips transparently.
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
      
      // Re-throw other errors, attaching a request id for traceability when missing.
      if (error && typeof error === 'object' && !error.requestId) {
        error.requestId = headers['X-Request-Id'] || null;
      }
      throw error;
    } finally {
      // Ensure the timeout timer is always cleared, regardless of how we exit.
      clearTimeout(timeoutId);
    }
  }

  // Entity wrapper for CRUD interface
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

    // Append a filter value to URLSearchParams with deliberate coercion:
    // - skip undefined/null/'' (empty string treated as "no filter")
    // - arrays produce repeated params (key=a&key=b)
    // - objects are JSON-stringified
    // - primitives (string/number/boolean) use String()
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

  // Auth methods
  auth = {
    me: async () => {
      if (!this.getToken()) {
        try {
          // A reload starts with no JavaScript-readable credential. Exchange the
          // HttpOnly refresh cookie for a fresh in-memory access token.
          await this.refreshTokens()
        } catch {
          return null
        }
      }

      try {
        // Increment _suppressAuthFailureCount so that any onAuthFailure callbacks triggered
        // deep in the fetch/handleUnauthorized call stack (e.g. by a 401 on the
        // /api/auth/me request itself) do not fire markSessionExpired() during
        // bootstrap. The caller (App.jsx) already handles failure via clearState().
        // A counter (not boolean) handles concurrent auth.me() calls correctly.
        this._suppressAuthFailureCount++
        try {
          return await this.fetch('/api/auth/me');
        } finally {
          this._suppressAuthFailureCount--
        }
      } catch (error) {
        // If it's an auth error (401 or 403), return null gracefully — user needs to sign in
        if (error.status === 401 || error.status === 403 || error.isAuthError) {
          log.debug('auth check failed; user needs to sign in')
          this.clearToken();
          return null;
        }
        // Network/transport failures (server unreachable, DNS, etc.): log but return null
        // so that the app can still render without a user context.
        if (
          error.status === 0 ||
          error.name === 'AbortError' ||
          error.errorCode === 'NETWORK_FETCH_FAILED' ||
          (error instanceof TypeError && /failed to fetch/i.test(String(error.message || '')))
        ) {
          console.warn('[APIClient] Network error checking auth status (server may be starting):', error.message);
          return null;
        }
        // For other errors (5xx, unexpected), log context and rethrow so callers can
        // detect server issues. Re-throwing here is intentional: auth bootstrap must
        // surface unexpected server failures rather than masquerading them as a
        // logged-out state.
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
      // Send the logout request BEFORE clearing tokens so the server receives the
      // Authorization header / refresh token and can revoke the session. Clear
      // local tokens afterwards regardless of the request outcome.
      this.fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: '{}',
      })
        .catch(() => {
          // Non-blocking — best-effort server notification; ignore errors.
        })
        .finally(() => {
          this.clearToken();
        });
      // Clear in-memory token immediately so subsequent calls don't reuse it, but
      // the in-flight logout request above already captured the header.
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

        // Only primitive metadata is supported as form fields. Objects/arrays are
        // JSON-stringified deliberately so they aren't coerced to '[object Object]'.
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

// Create singleton instance
const client = new APIClient();
client.init();

// Entity accessors.
// NOTE: Re-running client.init() replaces the entities Proxy. Eagerly destructuring
// the Proxy at module load would capture stale client objects that diverge from
// client.entities after a re-init. Instead, export accessor functions that always
// read the current Proxy, preserving lazy/stub re-resolution.
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

// Back-compat named exports.
// These are lazy getters on a single namespace object so consumers using
// `import { Organization } from '@/api/client'` always resolve the current
// entity client from the live Proxy (no stale snapshot after a re-init).
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
