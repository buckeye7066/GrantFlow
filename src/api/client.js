// API Client - Replaces Base44 SDK
// This file provides the same interface as base44Client but uses your own backend

// Use relative URLs in production (proxied by Vercel) to avoid CORS issues
// In dev mode, use VITE_API_URL or default to localhost
const API_URL = import.meta.env.DEV 
  ? (import.meta.env.VITE_API_URL || 'http://localhost:8080')
  : '';  // Empty string = relative URLs, proxied by Vercel
const APP_BASE = import.meta.env.VITE_APP_BASE || '/grantflow';

class APIClient {
  constructor() {
    this.baseUrl = API_URL;
    this.token = null;
    this.refreshToken = null;
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
    };
    this.stubStores = new Map();
    this.stubWarnings = new Set();
    this.isDev = import.meta.env?.DEV ?? false;
    this.entities = {};
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
    if (typeof window !== 'undefined') {
      localStorage.removeItem('grantflow:access-token');
      localStorage.removeItem('grantflow:refresh-token');
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
    
    // Single-flight refresh: if a refresh is already in progress, await it
    if (this.refreshPromise) {
      console.log('[APIClient] Refresh already in progress, waiting...');
      try {
        await this.refreshPromise;
        // After the refresh completes, retry the original request
        console.log('[APIClient] Refresh complete, retrying original request');
        return this.fetch(originalRequest.endpoint, originalRequest.options);
      } catch (error) {
        console.error('[APIClient] Refresh failed while waiting:', error.message);
        throw error;
      }
    }
    
    // Start a new refresh
    console.log('[APIClient] Starting token refresh...');
    this.refreshPromise = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include', // Ensure cookies are sent with the request
          body: JSON.stringify({ refreshToken }),
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          console.error('[APIClient] Refresh request failed:', response.status, errorData);
          
          // Clear tokens immediately on 401 from refresh endpoint
          if (response.status === 401) {
            console.warn('[APIClient] Invalid refresh token, clearing auth state');
            this.clearToken();
          }
          
          throw new Error(errorData.error || `Refresh failed with status ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[APIClient] Refresh successful, updating tokens');
        
        if (data?.accessToken) {
          this.setToken(data.accessToken);
        } else {
          console.warn('[APIClient] No accessToken in refresh response');
        }
        
        if (data?.refreshToken) {
          this.setRefreshToken(data.refreshToken);
        }
        
        return data;
      } catch (error) {
        // Refresh failed - clear everything and notify once
        console.error('[APIClient] Token refresh failed:', error.message);
        this.clearToken();
        
        // Create a user-friendly error
        const authError = this.createAuthError('Your session has expired. Please sign in again.');
        authError.isAuthError = true; // Flag this as an auth error
        
        if (this.onAuthFailure) {
          this.onAuthFailure('Your session expired. Sign in again to continue.');
        } else {
          this.auth.redirectToLogin();
        }
        throw authError;
      } finally {
        // Clear the promise after completion (success or failure)
        this.refreshPromise = null;
      }
    })();
    
    await this.refreshPromise;
    // Retry the original request with new token
    console.log('[APIClient] Retrying original request after refresh');
    return this.fetch(originalRequest.endpoint, originalRequest.options);
  }

  async fetch(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const token = this.getToken();
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    
    // Track if this is a retry attempt to prevent infinite loops
    const isRetry = options._isRetry || false;

    const headers = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    };

    if (isFormData) {
      delete headers['Content-Type'];
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include', // Ensure cookies are sent with the request
    });

    if (response.status === 401) {
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
      const retryOptions = { ...options, _isRetry: true };
      return this.handleUnauthorized({ endpoint, options: retryOptions });
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || error.message || 'Request failed');
    }

    if (response.status === 204) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    return response.text();
  }

  // Entity wrapper for Base44-compatible interface
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
          const field = sortBy.replace(/^-/, '');
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
        return await this.fetch('/api/auth/me');
      } catch (error) {
        // If it's an auth error (401 or session expired), return null gracefully
        if (error.status === 401 || error.isAuthError) {
          console.log('[APIClient] Auth check failed, user needs to sign in');
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
      try {
        this.fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        // non-blocking
      }
      if (typeof window !== 'undefined') {
        window.location.href = `${APP_BASE.replace(/\/$/, '')}/login`;
      }
    },
    
    redirectToLogin: () => {
      if (typeof window !== 'undefined') {
        window.location.href = `${APP_BASE.replace(/\/$/, '')}/login`;
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

  // Integrations wrapper (for backwards compatibility with Base44 SDK helpers)
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
            console.warn(
              `[base44] Using in-memory stub for entity "${prop}". API endpoint not configured.`,
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

// Export as base44 for compatibility with existing code
export const base44 = client;

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
