import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().default(168),
  COOKIE_SECURE: z.coerce.boolean().default(true),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  GRANTS_GOV_API_BASE: z.string().default('https://api.grants.gov/v1/api/v2'),
  GRANTS_GOV_API_KEY: z.string().optional(),

  SAM_GOV_API_BASE: z.string().default('https://api.sam.gov'),
  SAM_GOV_API_KEY: z.string().optional(),

  UPLOAD_DIR: z.string().default('./data/uploads'),
  UPLOAD_MAX_BYTES: z.coerce.number().default(52428800),
  UPLOAD_ALLOWED_MIME: z.string().default('application/pdf,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword'),

  SSRF_ALLOW_PRIVATE: z.coerce.boolean().default(false),
  SSRF_DOMAIN_ALLOWLIST: z.string().default('grants.gov,sam.gov,usa.gov'),

  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().default(3310),
  CLAMAV_ENABLED: z.coerce.boolean().default(false),

  TRUSTED_ORIGINS: z.string().default('http://localhost:5173'),
});

function loadEnv(): z.infer<typeof EnvSchema> {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Environment configuration error:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('Configuration failed validation. Set required environment variables before starting the server.');
    console.error('The application never works around missing required configuration or fabricates values.');
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
export type EnvConfig = z.infer<typeof EnvSchema>;

export function getCredential(name: string): string | undefined {
  return process.env[name];
}

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';