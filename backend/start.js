import dotenv from 'dotenv'

// Load .env from the current working directory. Use override so .env wins over any stale
// machine-level values during local development.
dotenv.config({ override: true })

// Import server AFTER env is loaded (ESM imports are hoisted).
await import('./server.js')