# syntax=docker/dockerfile:1.7

FROM node:24.13.0-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /workspace

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json

FROM manifests AS build
RUN pnpm install --frozen-lockfile --filter @capstone/api...
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/api ./apps/api
COPY packages/protocol ./packages/protocol
RUN pnpm --filter @capstone/api... build

FROM manifests AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --filter @capstone/api...

FROM node:24.13.0-alpine AS runtime
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-dependencies --chown=node:node /workspace/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=build --chown=node:node /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /workspace/apps/api/migrations ./apps/api/migrations
COPY --from=build --chown=node:node /workspace/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=node:node /workspace/packages/protocol/dist ./packages/protocol/dist

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
