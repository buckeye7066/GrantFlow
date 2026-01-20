// Base44 Client Compatibility Layer
//
// IMPORTANT:
// Some deployed bundles have ended up with `base44.get is not a function` despite the APIClient prototype
// defining `get/post/patch/...`. To make this resilient across bundlers/minifiers and import styles, we
// export a plain-object facade that *always* has the expected Base44-style methods as own-properties.

import client from './client';

function bind(fn) {
  return typeof fn === 'function' ? fn.bind(client) : fn;
}

export const base44 = {
  // Base44-style HTTP helpers
  fetch: bind(client.fetch),
  get: bind(client.get),
  post: bind(client.post),
  put: bind(client.put),
  patch: bind(client.patch),
  delete: bind(client.delete),

  // Auth/token helpers used throughout the app
  getToken: bind(client.getToken),
  setToken: bind(client.setToken),
  clearToken: bind(client.clearToken),
  getRefreshToken: bind(client.getRefreshToken),
  setRefreshToken: bind(client.setRefreshToken),
  setAuthFailureHandler: bind(client.setAuthFailureHandler),

  // Namespaces
  auth: client.auth,
  entities: client.entities,
  functions: client.functions,
  integrations: client.integrations,
};

export default client;
