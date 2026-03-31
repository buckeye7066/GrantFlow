import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, MUTATION_RATE_LIMIT_MAX } from '../config/constants.js';

// Fallback defaults if constants are undefined
const windowMs = RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000; // 15 minutes
const maxRequests = RATE_LIMIT_MAX_REQUESTS || 100;
const mutationMax = MUTATION_RATE_LIMIT_MAX || 20;

/**
 * Standard rate limiter for general API requests
 */
export const standardRateLimiter = rateLimit({
  windowMs: windowMs,
  max: maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

/**
 * Stricter rate limiter for mutation operations (POST, PUT, PATCH, DELETE)
 */
export const mutationRateLimiter = rateLimit({
  windowMs: windowMs,
  max: mutationMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many mutation requests, please try again later' },
  skip: (req) => {
    // Only apply to mutation operations
    return !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  }
});

/**
 * Very strict rate limiter for sensitive operations
 */
export const sensitiveRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // Only 5 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sensitive operation requests, please try again later' }
});
