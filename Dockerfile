# Supply curl from a pinned internal Bookworm image without an APT step on Jenkins.
FROM harbor.sa.iyunquna.com/yqn-library/fc_sandbox_v2:20260903@sha256:1864a44b2df21e11559985921dbf3a18c2a8321eaa4cfc0e788e098824b981ae AS curl-tools
COPY deploy/export_curl_runtime.py /tmp/export_curl_runtime.py
RUN python3 /tmp/export_curl_runtime.py /tmp/curl-runtime

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
    APP_ID=22124 \
    APP_NAME=yqn_prospector \
    YQN_APOLLO_CLUSTER=qa4 \
    YQN_APOLLO_METADATA=http://apollo.qa4.yqn.corp:8080 \
    APOLLO_NAMESPACE=application \
    APOLLO_REQUIRED=1 \
    UV_THREADPOOL_SIZE=1 \
    PROSPECTOR_CENTER_MODE=production \
    PROSPECTOR_CENTER_BIND_HOST=0.0.0.0 \
    PROSPECTOR_CENTER_RUNTIME_DIR=/var/lib/prospector-center

USER root

COPY --from=curl-tools /tmp/curl-runtime/ /

RUN curl --version \
    && mkdir -p /opt/web/ws-${APP_PORT}/logs /var/lib/prospector-center \
    && chmod -R 755 /opt/web \
    && chmod 1777 /tmp

WORKDIR /opt/web/ws-${APP_PORT}

COPY deploy/prospector-prebuilt/dist-server ./dist-server
COPY deploy/prospector-prebuilt/dist-admin ./dist-admin
COPY scripts/apollo-bootstrap.mjs ./apollo-bootstrap.mjs

RUN chown -R node:node /opt/web/ws-${APP_PORT} /var/lib/prospector-center

ENV NODE_ENV=production

USER node
EXPOSE ${APP_PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node --single-threaded --v8-pool-size=0 -e "fetch('http://127.0.0.1:'+process.env.APP_PORT+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--single-threaded", "--v8-pool-size=0", "apollo-bootstrap.mjs", "dist-server/adapters/online.cjs"]
