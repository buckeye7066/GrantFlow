// Base44 Client Compatibility Layer
// This file maintains API compatibility with Base44 SDK
// All actual logic is in ./client.js

import client, { base44 } from './client';

export { base44 };
export default client;
