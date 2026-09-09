# syntax=docker/dockerfile:1.7

# ---- build -------------------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# deps first, so a source edit does not re-download the registry
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
# the build fails here, not at runtime, if the types or the checks are broken
RUN npm run typecheck && npm test && npm run build

# ---- production dependencies ---------------------------------------------------------------------
# A separate stage so the runtime never inherits a layer that briefly held dev tooling.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
  # typescript is an optional peer of viem/abitype/ox: it is used for type inference at compile time
  # and never imported at runtime. 23 MB of a 105 MB tree.
  && rm -rf node_modules/typescript node_modules/.bin/tsc node_modules/.bin/tsserver \
  && npm cache clean --force

# ---- runtime -----------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# --chown on the COPY instead of a `chown -R` step: rewriting ownership in its own layer would
# duplicate the whole dependency tree and cost ~67 MB.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node .env.example README.md LICENSE ./
COPY --chown=node:node docs ./docs

# positions.json lives here; mount a volume over it to keep a ledger between runs
RUN mkdir -p /data && chown node:node /data
ENV ASSAY_DATA=/data

# never run the thing that can hold a private key as root
USER node

# the board's port; harmless when running any other command
EXPOSE 4663

# `doctor` is the honest health check: it re-reads the chain and the pons parameters and exits
# non-zero when they are not what the code assumes. Override it for the board, which has an HTTP one.
HEALTHCHECK --interval=5m --timeout=60s --start-period=20s --retries=2 \
  CMD node dist/cli/main.js doctor > /dev/null || exit 1

ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["doctor", "--probe"]
