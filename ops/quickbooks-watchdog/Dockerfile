FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/watchdog ./src/watchdog
COPY src/services/quickbooks-observability.ts src/services/quickbooks-worker-operational.ts ./src/services/
# Compile only the standalone graph: no Prisma, env loader, or API at runtime.
RUN npx tsc --ignoreConfig --types node src/watchdog/main.ts --outDir /compiled --rootDir src --module commonjs --target es2022 --esModuleInterop --strict --skipLibCheck

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
# flock holds exclusion in the kernel, so a killed container cannot strand a lock.
RUN test -x /usr/bin/flock \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --from=build /compiled/watchdog ./watchdog
COPY --from=build /compiled/services/quickbooks-observability.js ./services/quickbooks-observability.js
COPY --from=build /compiled/services/quickbooks-worker-operational.js ./services/quickbooks-worker-operational.js
RUN mkdir /state && chown node:node /state && chmod 700 /state
ENV WATCHDOG_STATE_DIRECTORY=/state PORT=8080
USER node
EXPOSE 8080
CMD ["node", "watchdog/main.js"]
