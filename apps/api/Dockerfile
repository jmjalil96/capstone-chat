# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.13.0-alpine@sha256:cd6fb7efa6490f039f3471a189214d5f548c11df1ff9e5b181aa49e22c14383e AS base
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
RUN pnpm install --frozen-lockfile --filter @capstone/api... --filter @capstone/web...
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages/brand ./packages/brand
COPY packages/protocol ./packages/protocol
RUN pnpm build \
  && find apps/api/dist packages/protocol/dist apps/web/dist -type f -name '*.map' -delete

FROM manifests AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --filter @capstone/api...

FROM node:24.13.0-alpine@sha256:cd6fb7efa6490f039f3471a189214d5f548c11df1ff9e5b181aa49e22c14383e AS runtime
LABEL org.opencontainers.image.source="https://github.com/jmjalil96/capstone-chat"
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
