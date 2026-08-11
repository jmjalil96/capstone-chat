# syntax=docker/dockerfile:1.7

FROM node:24.13.0-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /workspace

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/brand/package.json ./packages/brand/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json

FROM manifests AS build
ARG DEPLOYMENT_REVISION
RUN printf '%s\n' "$DEPLOYMENT_REVISION" | grep -Eq '^[0-9a-f]{40}$'
RUN pnpm install --frozen-lockfile --filter @capstone/api... --filter @capstone/web...
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages/brand ./packages/brand
COPY packages/protocol ./packages/protocol
RUN DEPLOYMENT_REVISION="$DEPLOYMENT_REVISION" pnpm build \
  && find apps/api/dist packages/protocol/dist apps/web/dist -type f -name '*.map' -delete

FROM manifests AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --filter @capstone/api...

FROM node:24.13.0-alpine AS runtime
ARG DEPLOYMENT_REVISION
LABEL org.opencontainers.image.revision="$DEPLOYMENT_REVISION"
LABEL org.opencontainers.image.source="https://github.com/jmjalil96/capstone-chat"
ENV CLIENT_ADDRESS_SOURCE=caddy
ENV HOST=127.0.0.1
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-dependencies --chown=node:node /workspace/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=build --chown=node:node /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /workspace/apps/api/migrations ./apps/api/migrations
COPY --from=build --chown=node:node /workspace/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /workspace/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=node:node /workspace/packages/protocol/dist ./packages/protocol/dist

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/entrypoint.js", "server"]
