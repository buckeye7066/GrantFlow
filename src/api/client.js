// API Client - Replaces Base44 SDK
// This file provides the same interface as base44Client but uses your own backend

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const APP_BASE = import.meta.env.VITE_APP_BASE || '/grantflow';

class APIClient {
  constructor() {
    this.baseUrl = API_URL;
    this.token = null;
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
  createEntityClient(entityName) {
    const endpoint = `/api/${entityName.toLowerCase()}s`;
    
    return {
      list: async (sortBy) => {
        let url = endpoint;
        if (sortBy) {
          const order = sortBy.startsWith('-') ? 'desc' : 'asc';
          const field = sortBy.replace(/^-/, '');
          url += `?sort=${field}&order=${order}`;
        }
        return this.fetch(url);
      },
      
      filter: async (filters) => {
        const params = new URLSearchParams(filters);
        return this.fetch(`${endpoint}?${params}`);
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
    this.entities.Organization = this.createEntityClient('organization');
    this.entities.Grant = this.createEntityClient('grant');
    this.entities.FundingOpportunity = this.createEntityClient('opportunitie'); // Note: opportunities
    this.entities.Milestone = this.createEntityClient('milestone');
    this.entities.Document = this.createEntityClient('document');
    this.entities.Expense = this.createEntityClient('expense');
    this.entities.Budget = this.createEntityClient('budget');
    this.entities.Contact = this.createEntityClient('contact');
    this.entities.CrawlLog = this.createEntityClient('crawl_log');
    this.entities.ApplicationDraft = this.createEntityClient('application_draft');
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
