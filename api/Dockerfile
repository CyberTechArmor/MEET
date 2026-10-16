# Build stage
#
# better-sqlite3 ships musl-x64 prebuilds for Node 20+, so on most builds
# `npm ci` just downloads the binary. The build deps below are a fallback
# for arches without a prebuild (or when prebuilds are blocked) — npm-rebuild
# from source then needs python3, make, g++, and sqlite headers.
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (incl. dev — TypeScript needs them)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Drop dev deps so node_modules can be carried straight into prod.
RUN npm prune --omit=dev

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files (kept for npm metadata; node_modules is copied below)
COPY package*.json ./

# Carry over the already-installed (and possibly compiled) node_modules
# from the builder. Avoids re-running native compiles in this stage.
COPY --from=builder /app/node_modules ./node_modules

# Copy built files
COPY --from=builder /app/dist ./dist

# Persistent data directory (SQLite). The external-proxy compose stack
# mounts a named volume here so state survives `docker compose down && up`.
RUN mkdir -p /data
VOLUME ["/data"]
ENV MEET_DATA_DIR=/data

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
