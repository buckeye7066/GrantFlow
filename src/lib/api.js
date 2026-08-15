const DEFAULT_TIMEOUT_MS = 30000;

export const API_BASE_URL = getApiBaseUrl();

export function getApiBaseUrl() {
  const configured = import.meta.env?.VITE_API_BASE_URL;

  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.replace(/\/$/, '');
  }

  return '';
}

function buildUrl(path, query) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${API_BASE_URL}${normalizedPath}`;

  if (!query || Object.keys(query).length === 0) {
    return url;
  }

  const params = new URLSearchParams();

  Object.entries(query).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry !== null && entry !== undefined && entry !== '') {
          params.append(key, String(entry));
        }
      });
      return;
    }

    params.set(key, String(value));
  });

  const queryString = params.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function getAuthToken() {
  try {
    return window.localStorage.getItem('grantflow.session.token') || window.localStorage.getItem('authToken');
  } catch {
    return null;
  }
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';

  if (response.status === 204) {
    return null;
  }

  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

export class ApiError extends Error {
  constructor(message, response, data) {
    super(message);
    this.name = 'ApiError';
    this.status = response.status;
    this.statusText = response.statusText;
    this.data = data;
  }
}

export async function apiFetch(path, options = {}) {
  const {
    query,
    body,
    headers = {},
    timeout = DEFAULT_TIMEOUT_MS,
    auth = true,
    signal,
    ...fetchOptions
  } = options;

  const controller = new AbortController();
  const timeoutId = timeout > 0 ? window.setTimeout(() => controller.abort(), timeout) : null;

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const token = auth ? getAuthToken() : null;
  const requestHeaders = new Headers(headers);

  if (body !== null && body !== undefined && !(body instanceof FormData) && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  if (token !== null && token !== undefined && token !== '' && !requestHeaders.has('Authorization')) {
    requestHeaders.set('Authorization', `Bearer ${token}`);
  }

  try {
    const response = await fetch(buildUrl(path, query), {
      ...fetchOptions,
      headers: requestHeaders,
      body: body instanceof FormData || typeof body === 'string' ? body : body !== null && body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = await parseResponse(response);

    if (!response.ok) {
      const message = data && typeof data === 'object' && data.message ? data.message : `Request failed with status ${response.status}`;
      throw new ApiError(message, response, data);
    }

    return data;
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

export function apiGet(path, options = {}) {
  return apiFetch(path, { ...options, method: 'GET' });
}

export function apiPost(path, body, options = {}) {
  return apiFetch(path, { ...options, method: 'POST', body });
}

export function apiPut(path, body, options = {}) {
  return apiFetch(path, { ...options, method: 'PUT', body });
}

export function apiPatch(path, body, options = {}) {
  return apiFetch(path, { ...options, method: 'PATCH', body });
}

export function apiDelete(path, options = {}) {
  return apiFetch(path, { ...options, method: 'DELETE' });
}

export const api = {
  fetch: apiFetch,
  get: apiGet,
  post: apiPost,
  put: apiPut,
  patch: apiPatch,
  delete: apiDelete,
};

export default api;
