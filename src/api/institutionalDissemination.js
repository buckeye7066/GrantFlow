import { apiFetch } from './client'

export function buildInstitutionalNewsletterBundle(payload) {
  return apiFetch('/api/institutional-dissemination/newsletter-bundle', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
