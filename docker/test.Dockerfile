# Linux build + test image (Phase 1). Run from the repo root with: pnpm test:linux
# Gets a copy of the source only (see .dockerignore allowlist): no bind mounts,
# no host home directory, no secrets, no env vars.
FROM node:22.21.1-bookworm-slim

# Toolchain so better-sqlite3 can compile if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Same pnpm version as "packageManager" in package.json.
RUN npm install -g pnpm@10.28.1

WORKDIR /app
RUN chown node:node /app
USER node

# Dependency layer: cached until the lockfile or a package.json changes.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages/cli/package.json packages/cli/package.json
RUN pnpm install --frozen-lockfile

# Source.
COPY --chown=node:node . .

# Same command as the Windows baseline in CLAUDE.md.
CMD ["sh", "-c", "pnpm build && npx vitest run --exclude '**/node_modules/**'"]
