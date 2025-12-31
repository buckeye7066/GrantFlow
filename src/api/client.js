// API Client - Replaces Base44 SDK
// This file provides the same interface as base44Client but uses your own backend

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const APP_BASE = import.meta.env.VITE_APP_BASE || '/grantflow';

class APIClient {
  constructor() {
    this.baseUrl = API_URL;
    this.token = null;
    this.entityResourceMap = {
      Organization: 'organizations',
      Grant: 'grants',
      FundingOpportunity: 'opportunities',
      Opportunity: 'opportunities',
      Milestone: 'milestones',
      Document: 'documents',
      Expense: 'expenses',
    };
    this.stubStores = new Map();
    this.stubWarnings = new Set();
    this.isDev = import.meta.env?.DEV ?? false;
    this.entities = {};
  }

  setToken(token) {
    this.token = token;
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('grantflow:admin-token', token);
    }
  }

  getToken() {
    if (this.token) return this.token;
    if (typeof window !== 'undefined') {
      return sessionStorage.getItem('grantflow:admin-token');
    }
    return null;
  }

  clearToken() {
    this.token = null;
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('grantflow:admin-token');
    }
  }

  async fetch(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const token = this.getToken();
    
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || error.message || 'Request failed');
    }

    return response.json();
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
        // Validate token by hitting a protected endpoint
        await this.fetch('/api/anya/status');
        return { 
          email: 'admin@grantflow.app',
          full_name: 'Admin User',
          role: 'admin'
        };
      } catch {
        return null;
      }
    },
    
    login: async (token) => {
      this.setToken(token);
      return this.auth.me();
    },
    
    logout: () => {
      this.clearToken();
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

  // Entity proxies (Base44 compatibility)
  entities = {
    Organization: null,
    Grant: null,
    FundingOpportunity: null,
    Milestone: null,
    Document: null,
    Expense: null,
    Budget: null,
    Contact: null,
    CrawlLog: null,
    ApplicationDraft: null,
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
} = client.entities;

export default client;
