FROM harbor.sa.iyunquna.com/yqn-library/node:22-bookworm-slim

ENV LANG=C.UTF-8

ARG APP_PORT=55847
ARG PACKAGE_PATH
ARG ENV
ARG IMAGE_TAG
ARG GIT_COMMIT

ENV APP_PORT=${APP_PORT} \
    PACKAGE_PATH=${PACKAGE_PATH} \
    ENV=${ENV} \
    IMAGE_TAG=${IMAGE_TAG} \
    CODE_VERSION=${GIT_COMMIT} \
    UV_THREADPOOL_SIZE=1 \
    PROSPECTOR_CENTER_MODE=production \
    PROSPECTOR_CENTER_BIND_HOST=0.0.0.0 \
    PROSPECTOR_CENTER_RUNTIME_DIR=/var/lib/prospector-center

USER root

RUN mkdir -p /opt/web/ws-${APP_PORT} /var/lib/prospector-center \
    && chmod -R 755 /opt/web \
    && chmod 1777 /tmp

WORKDIR /opt/web/ws-${APP_PORT}

COPY package.json package-lock.json ./
RUN node --single-threaded --v8-pool-size=0 /usr/local/lib/node_modules/npm/bin/npm-cli.js ci \
    --ignore-scripts \
    --maxsockets=1 \
    --registry=https://registry.npmmirror.com \
    --replace-registry-host=always

COPY . .
RUN node --single-threaded --v8-pool-size=0 ./node_modules/typescript/bin/tsc -p tsconfig.server.json \
    && node --single-threaded --v8-pool-size=0 ./node_modules/typescript/bin/tsc -p tsconfig.admin.json \
    && node --single-threaded --v8-pool-size=0 scripts/build-admin.mjs \
    && chown -R node:node /opt/web/ws-${APP_PORT} /var/lib/prospector-center

ENV NODE_ENV=production

USER node
EXPOSE ${APP_PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node --single-threaded --v8-pool-size=0 -e "fetch('http://127.0.0.1:55847/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--single-threaded", "--v8-pool-size=0", "dist-server/online.js"]
