# Multi-stage Dockerfile for GrantFlow (Vite + Express hybrid)
# Stage 1: Build stage
FROM node:20-slim AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
# Use --legacy-peer-deps as required by package.json
RUN npm install --legacy-peer-deps

# Copy all source files
COPY . .

# Build Vite frontend to dist/
RUN npm run build

# Stage 2: Production stage
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy node_modules from builder (includes all deps)
# This approach avoids npm install issues in production stage
COPY --from=builder /app/node_modules ./node_modules

# Copy backend code
COPY backend ./backend

# Copy seed data needed for admin maintenance operations (e.g., baseline profile seeding)
COPY seed ./seed

# Copy built frontend assets from builder stage
COPY --from=builder /app/dist ./dist

# Expose port (Railway will set PORT env var)
EXPOSE 8080

# Health check on /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/api/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the Express server
CMD ["npm", "start"]
