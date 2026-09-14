# syntax=docker/dockerfile:1
FROM node:22-slim AS base
WORKDIR /app

# ---- deps -------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS build-deps
COPY package.json package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund

# ---- build ------------------------------------------------------------------
FROM build-deps AS build
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npx tsc -p tsconfig.json

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# No Chromium is installed. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 is set in the deps
# stages and nothing runs `playwright install`, so BROWSER_ENABLED=true cannot
# work from this image. To enable the browser worker, add a
# `npx playwright install --with-deps chromium` step here. Until then this RUN
# only provides certificates and curl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

# Playwright browsers live on the persistent volume so a redeploy doesn't refetch
# them and the logged-in profile survives.
ENV PLAYWRIGHT_BROWSERS_PATH=/data/playwright
ENV CLAUDE_CONFIG_DIR=/data/claude

RUN mkdir -p /data/claude /data/browser-profile /data/playwright

EXPOSE 3000
CMD ["node", "dist/index.js"]
