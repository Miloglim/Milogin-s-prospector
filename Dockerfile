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
    PROSPECTOR_CENTER_MODE=production \
    PROSPECTOR_CENTER_BIND_HOST=0.0.0.0 \
    PROSPECTOR_CENTER_RUNTIME_DIR=/var/lib/prospector-center

USER root

RUN mkdir -p /opt/web/ws-${APP_PORT} /var/lib/prospector-center \
    && chmod -R 755 /opt/web \
    && chmod 1777 /tmp

WORKDIR /opt/web/ws-${APP_PORT}

COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set replace-registry-host always \
    && npm ci --ignore-scripts

COPY . .
RUN npm run crm:pg:build \
    && npm run crm:admin:build \
    && npm cache clean --force \
    && chown -R node:node /opt/web/ws-${APP_PORT} /var/lib/prospector-center

ENV NODE_ENV=production

USER node
EXPOSE ${APP_PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:55847/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/online.js"]
