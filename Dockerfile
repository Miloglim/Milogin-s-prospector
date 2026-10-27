FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run crm:pg:build && npm run crm:admin:build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PROSPECTOR_CENTER_MODE=production \
    PROSPECTOR_CENTER_BIND_HOST=0.0.0.0 \
    PROSPECTOR_CENTER_RUNTIME_DIR=/var/lib/prospector-center

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-admin ./dist-admin
COPY scripts/bootstrap-production-admin.mjs ./scripts/bootstrap-production-admin.mjs

RUN mkdir -p /var/lib/prospector-center \
    && chown -R node:node /app /var/lib/prospector-center

USER node
EXPOSE 55847

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:55847/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/online.js"]
