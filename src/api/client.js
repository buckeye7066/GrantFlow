// API Client - Replaces Base44 SDK
// This file provides the same interface as base44Client but uses your own backend

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const APP_BASE = import.meta.env.VITE_APP_BASE || '/grantflow';

class APIClient {
  constructor() {
    this.baseUrl = API_URL;
    this.token = null;
    this.refreshToken = null;
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
    if (typeof window !== 'undefined') {
      localStorage.removeItem('grantflow:access-token');
      localStorage.removeItem('grantflow:refresh-token');
    }
  }

  async handleUnauthorized(originalRequest) {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      if (this.onAuthFailure) {
        this.onAuthFailure('Your session expired. Sign in again to continue.');
      } else {
        this.auth.redirectToLogin();
      }
      throw new Error('Authentication required');
    }
    try {
      const response = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        throw new Error('Refresh failed');
      }
      const data = await response.json();
      if (data?.accessToken) {
        this.setToken(data.accessToken);
      }
      if (data?.refreshToken) {
        this.setRefreshToken(data.refreshToken);
      }
      return this.fetch(originalRequest.endpoint, originalRequest.options);
    } catch (error) {
      this.clearToken();
      if (this.onAuthFailure) {
        this.onAuthFailure('Your session expired. Sign in again to continue.');
      } else {
        this.auth.redirectToLogin();
      }
      throw new Error('Session expired. Please sign in again.');
    }
  }

  async fetch(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const token = this.getToken();
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;

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
    });

    if (response.status === 401) {
      return this.handleUnauthorized({ endpoint, options });
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
      } catch {
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
