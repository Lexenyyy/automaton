# Agent images (fork, Phase 1). Two targets from one build:
#   runtime  agent loop, policy engine, wallet, keys. Starts no processes.
#   sandbox  runs the agent's shell and file tools. Holds no secrets.
# Built and wired by docker/compose.agent.yml (pnpm agent:build).
ARG NODE_IMAGE=node:22.21.1-bookworm-slim

# ─── build ─────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.28.1
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Production dependencies only, for the runtime image.
RUN rm -rf node_modules packages/cli/node_modules \
 && pnpm install --frozen-lockfile --prod
# Working-tree scripts may have CRLF line endings (Windows checkout).
RUN sed -i 's/\r$//' docker/runtime-entrypoint.sh docker/load-secrets.sh

# ─── runtime ───────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# No package managers in the runtime: it never installs or starts anything.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && groupadd -g 10100 sandboxsock \
 && groupadd -g 10001 automaton \
 && useradd -u 10001 -g 10001 -G sandboxsock -m -d /home/automaton -s /usr/sbin/nologin automaton \
 && mkdir -p /home/automaton/.automaton /workspace /run/automaton-sandbox /run/secrets/automaton \
 && mkdir -p -m 0755 /usr/local/lib/automaton \
 && chown 10001:10001 /home/automaton/.automaton && chmod 700 /home/automaton/.automaton \
 && chown 10002:10100 /run/automaton-sandbox && chmod 2770 /run/automaton-sandbox
WORKDIR /app
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/constitution.md ./constitution.md
COPY --from=build --chmod=0555 /build/docker/runtime-entrypoint.sh /usr/local/bin/runtime-entrypoint.sh
COPY --from=build --chmod=0444 /build/docker/load-secrets.sh /usr/local/lib/automaton/load-secrets.sh
ENV HOME=/home/automaton \
    NODE_ENV=production \
    PATH=/usr/local/bin:/usr/bin:/bin
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/runtime-entrypoint.sh"]
CMD ["--status"]

# ─── sandbox ───────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS sandbox
# Tools the agent's shell may use. Network is off in compose (network_mode: none).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10100 sandboxsock \
 && groupadd -g 10002 agent \
 && useradd -u 10002 -g 10002 -G sandboxsock -m -d /home/agent -s /bin/sh agent \
 && mkdir -p /workspace/skills /run/automaton-sandbox \
 && chown -R 10002:10002 /workspace \
 && chown 10002:10100 /run/automaton-sandbox && chmod 2770 /run/automaton-sandbox
WORKDIR /app
# Only the sandbox server, not the agent runtime.
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/dist/types.js ./dist/types.js
COPY --from=build /build/dist/sandbox ./dist/sandbox
ENV HOME=/home/agent \
    SANDBOX_SOCKET=/run/automaton-sandbox/sandbox.sock \
    SANDBOX_ROOTS=/workspace:/home/agent
USER 10002:10002
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=15 \
  CMD ["node", "-e", "require('http').get({socketPath:process.env.SANDBOX_SOCKET,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "/app/dist/sandbox/main.js"]
