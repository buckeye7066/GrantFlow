FROM node:20-alpine AS base
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
COPY ../../package.json ../../pnpm-lock.yaml* ./../..

RUN corepack enable && pnpm install --filter @grantflow/api... --prod=false

COPY . .
COPY ../../packages ../../packages

RUN pnpm build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=base /app/dist ./dist
COPY --from=base /app/package.json .
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/prisma ./prisma

EXPOSE 4000
CMD ["node", "dist/index.js"]

