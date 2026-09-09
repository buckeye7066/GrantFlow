import { apiFetch } from './client.js'

export const advertisementApi = {
  list: () => apiFetch('/api/advertisements'),
  manage: () => apiFetch('/api/advertisements/manage'),
  image: (id) => apiFetch(`/api/advertisements/${encodeURIComponent(id)}/image`, { responseType: 'blob' }),
  save: (form, id) => apiFetch(`/api/advertisements/manage${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: form }),
  remove: (id) => apiFetch(`/api/advertisements/manage/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  ticket: (id) => apiFetch(`/api/advertisements/${encodeURIComponent(id)}/view-ticket`, { method: 'POST', body: '{}' }),
  event: (id, kind, ticket) => apiFetch(`/api/advertisements/${encodeURIComponent(id)}/events`, { method: 'POST', body: JSON.stringify({ kind, ticket }) }),
}
