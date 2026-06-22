import { apiFetch } from './client'

// ── Admin (owner-initiated) ──────────────────────────────────────────────────

/** All profiles + resolved email/phone contacts for the broadcast recipient table. */
export async function listBroadcastRecipients() {
  return apiFetch('/api/admin/comms/recipients')
}

/** Send a broadcast. channel: 'auto' | 'email' | 'sms'. */
export async function sendBroadcast({ profileIds, channel = 'auto', subject = null, body }) {
  return apiFetch('/api/admin/comms/broadcast', {
    method: 'POST',
    body: JSON.stringify({ profileIds, channel, subject, body }),
  })
}

export async function addProfilePhone({ profileId, phone, label = null, optIn = true }) {
  return apiFetch('/api/admin/comms/phones', {
    method: 'POST',
    body: JSON.stringify({ profileId, phone, label, optIn }),
  })
}

export async function setPhoneOptInAdmin({ profileId, phone, optIn }) {
  return apiFetch('/api/admin/comms/phones/optin', {
    method: 'POST',
    body: JSON.stringify({ profileId, phone, optIn }),
  })
}

export async function removeProfilePhone({ profileId, phone }) {
  return apiFetch('/api/admin/comms/phones/remove', {
    method: 'POST',
    body: JSON.stringify({ profileId, phone }),
  })
}

export async function setEmailProxy({ profileId, email, isProxy }) {
  return apiFetch('/api/admin/comms/email-proxy', {
    method: 'POST',
    body: JSON.stringify({ profileId, email, isProxy }),
  })
}

export async function listBroadcasts() {
  return apiFetch('/api/admin/comms/broadcasts')
}

// ── User-facing ──────────────────────────────────────────────────────────────

/** Email the GrantFlow owner alias from a profile (reply-to = the user). */
export async function contactOwner({ profileId = null, subject = null, message }) {
  return apiFetch('/api/comms/contact', {
    method: 'POST',
    body: JSON.stringify({ profileId, subject, message }),
  })
}

export async function getProfileContacts(profileId) {
  return apiFetch(`/api/comms/me/${profileId}/contacts`)
}

/** The user opts a phone IN or OUT of SMS for their own profile. */
export async function setMySmsOptIn(profileId, { phone, optIn }) {
  return apiFetch(`/api/comms/me/${profileId}/sms`, {
    method: 'POST',
    body: JSON.stringify({ phone, optIn }),
  })
}
