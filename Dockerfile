# syntax=docker/dockerfile:1

# --- Build the web UI ---
FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- Production dependencies only ---
FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Runtime ---
FROM oven/bun:1.4.4-alpine
# Set by CI. Builds that are not a stable release show the short commit instead of the version.
ARG KEEPWATCH_VERSION=""
ARG KEEPWATCH_COMMIT=""
ARG KEEPWATCH_RELEASE="false"
ENV NODE_ENV=production \
    PORT=4321 \
    DATA_DIR=/data \
    WEB_DIR=/app/dist/web \
    MIGRATIONS_DIR=/app/drizzle \
    KEEPWATCH_VERSION=${KEEPWATCH_VERSION} \
    KEEPWATCH_COMMIT=${KEEPWATCH_COMMIT} \
    KEEPWATCH_RELEASE=${KEEPWATCH_RELEASE}
# tzdata so TZ works, su-exec to drop root in the entrypoint
RUN apk add --no-cache tzdata su-exec
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/web ./dist/web
COPY package.json ./
COPY drizzle ./drizzle
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
ENTRYPOINT ["entrypoint.sh"]
CMD ["bun", "src/server/index.ts"]
