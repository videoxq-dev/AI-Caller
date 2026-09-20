# syntax=docker/dockerfile:1
# One image supports the web process, migration job, and background worker.
# Keep tsx available at runtime because worker/index.ts and scripts/migrate.ts
# currently execute TypeScript directly. Do not prune devDependencies yet.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund
COPY . .

# These are inert BUILD-ONLY values required when Next evaluates server
# modules at build time. Never pass live API keys or production auth secrets
# as Docker build arguments; runtime credentials come from env_file.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    BETTER_AUTH_URL=http://localhost:8080 \
    BETTER_AUTH_SECRET=build-only-placeholder-not-for-runtime-123456 \
    INTEGRATION_ENCRYPTION_KEY=build-only-placeholder-not-for-runtime \
    npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/.data/recordings && chown -R node:node /app/.data
USER node
EXPOSE 8080
CMD ["npm", "start"]
