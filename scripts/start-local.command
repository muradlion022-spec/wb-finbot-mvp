#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

export PATH="/Users/levonstepanian/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/levonstepanian/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$PATH"
export CI=true
export TMPDIR=/private/tmp

if [ ! -f .env ]; then
  cp .env.example .env
fi

if [ ! -d node_modules ]; then
  pnpm install
fi

RUST_LOG=debug pnpm db:push:local

if grep -q '^USE_DEMO_DATA=true' .env; then
  node --import tsx prisma/seed.ts
fi

pnpm dev
